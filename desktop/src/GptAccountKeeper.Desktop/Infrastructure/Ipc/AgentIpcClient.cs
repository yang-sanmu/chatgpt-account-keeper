using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Infrastructure.Ipc;

internal sealed partial class AgentIpcClient : IAsyncDisposable
{
    private readonly AgentEndpoint _endpoint;
    private readonly SemaphoreSlim _connectGate = new(1, 1);
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<AgentIncomingEnvelope>> _pending = new();
    private Stream? _stream;
    private CancellationTokenSource? _readerCancellation;
    private Task? _readerTask;
    private long _nextRequestId;
    private long? _lastEventSequence;
    private string? _eventInstanceId;
    private int _disposed;

    public AgentIpcClient(AgentEndpoint endpoint)
    {
        _endpoint = endpoint;
    }

    public bool IsConnected => _stream is not null && Volatile.Read(ref _disposed) == 0;

    public event EventHandler<AgentEvent>? EventReceived;

    public event EventHandler<Exception?>? Disconnected;

    public event EventHandler? ContinuityLost;

    internal static bool IsEndpointAvailable(AgentEndpoint endpoint)
    {
        if (endpoint.Transport != AgentTransport.NamedPipe || !OperatingSystem.IsWindows())
        {
            return true;
        }

        if (WaitNamedPipe(endpoint.Address, 0) != 0)
        {
            return true;
        }

        // “尚未创建”“全部实例忙”和零等待超时都是正常的启动探测结果。
        // 其它错误交给 NamedPipeClientStream 处理，以免隐藏权限或参数问题。
        return Marshal.GetLastPInvokeError() is not (2 or 3 or 121 or 231);
    }

    public async Task ConnectAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        await _connectGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_stream is not null)
            {
                return;
            }

            var stream = await OpenStreamAsync(timeout, cancellationToken).ConfigureAwait(false);
            _readerCancellation = new CancellationTokenSource();
            _stream = stream;
            _readerTask = ReadLoopAsync(stream, _readerCancellation.Token);
        }
        finally
        {
            _connectGate.Release();
        }
    }

    public async Task<TResult> CallAsync<TParams, TResult>(
        string method,
        TParams parameters,
        JsonTypeInfo<TParams> parametersType,
        JsonTypeInfo<TResult> resultType,
        CancellationToken cancellationToken,
        string? commandId = null)
    {
        var stream = _stream ?? throw new InvalidOperationException("尚未连接 Agent");
        var id = Interlocked.Increment(ref _nextRequestId).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var completion = new TaskCompletionSource<AgentIncomingEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(id, completion))
        {
            throw new InvalidOperationException("IPC request id 冲突");
        }

        try
        {
            var request = new AgentRequestEnvelope
            {
                Id = id,
                Method = method,
                Params = JsonSerializer.SerializeToElement(parameters, parametersType),
                CommandId = commandId,
            };
            var payload = JsonSerializer.SerializeToUtf8Bytes(request, AppJsonContext.Default.AgentRequestEnvelope);
            await WriteFrameAsync(stream, payload, cancellationToken).ConfigureAwait(false);
            var response = await completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            if (response.Error is not null)
            {
                throw new AgentRpcException(response.Error);
            }

            if (response.Result.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            {
                throw new InvalidDataException($"Agent 方法 {method} 未返回 result");
            }

            return response.Result.Deserialize(resultType)
                ?? throw new InvalidDataException($"Agent 方法 {method} 返回了无效 result");
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        var cancellation = _readerCancellation;
        var stream = Interlocked.Exchange(ref _stream, null);
        cancellation?.Cancel();
        if (stream is not null)
        {
            await stream.DisposeAsync().ConfigureAwait(false);
        }

        if (_readerTask is not null)
        {
            try
            {
                await _readerTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (IOException)
            {
            }
        }

        FailPending(new ObjectDisposedException(nameof(AgentIpcClient)));
        cancellation?.Dispose();
        _connectGate.Dispose();
        _writeGate.Dispose();
    }

    private async Task<Stream> OpenStreamAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (_endpoint.Transport == AgentTransport.NamedPipe)
        {
            var pipe = new NamedPipeClientStream(
                ".",
                _endpoint.PipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);
            try
            {
                // The timeout overload reports an unavailable pipe as TimeoutException.
                // A linked CancelAfter token reports it as OperationCanceledException,
                // which floods Visual Studio's first-chance exception output while an
                // Agent is legitimately still starting or migrating data.
                var timeoutMilliseconds = checked((int)Math.Clamp(
                    Math.Ceiling(timeout.TotalMilliseconds),
                    1,
                    int.MaxValue));
                await pipe.ConnectAsync(timeoutMilliseconds, cancellationToken).ConfigureAwait(false);
                return pipe;
            }
            catch
            {
                await pipe.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }

        using var timeoutCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCancellation.CancelAfter(timeout);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(_endpoint.Address), timeoutCancellation.Token)
                .ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            socket.Dispose();
            throw new TimeoutException($"连接 Agent IPC 超时：{_endpoint.Address}");
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private async Task WriteFrameAsync(Stream stream, byte[] payload, CancellationToken cancellationToken)
    {
        if (payload.Length is <= 0 or > AgentProtocol.MaxFrameBytes)
        {
            throw new InvalidDataException($"IPC frame 长度无效：{payload.Length}");
        }

        var prefix = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(prefix, payload.Length);
        await _writeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await stream.WriteAsync(prefix, cancellationToken).ConfigureAwait(false);
            await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private async Task ReadLoopAsync(Stream stream, CancellationToken cancellationToken)
    {
        Exception? failure = null;
        try
        {
            var prefix = new byte[sizeof(int)];
            while (!cancellationToken.IsCancellationRequested)
            {
                await ReadExactlyAsync(stream, prefix, cancellationToken).ConfigureAwait(false);
                var length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
                if (length is <= 0 or > AgentProtocol.MaxFrameBytes)
                {
                    throw new InvalidDataException($"Agent IPC frame 超出限制：{length}");
                }

                var payload = GC.AllocateUninitializedArray<byte>(length);
                await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
                var incoming = JsonSerializer.Deserialize(payload, AppJsonContext.Default.AgentIncomingEnvelope)
                    ?? throw new InvalidDataException("Agent 返回了空 JSON frame");
                Dispatch(incoming);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (exception is IOException or SocketException or JsonException or InvalidDataException)
        {
            failure = exception;
        }
        finally
        {
            if (ReferenceEquals(_stream, stream))
            {
                _stream = null;
            }

            var disconnectError = failure ?? new EndOfStreamException("Agent IPC 连接已关闭");
            FailPending(disconnectError);
            Disconnected?.Invoke(this, failure);
        }
    }

    private void Dispatch(AgentIncomingEnvelope incoming)
    {
        if (!string.IsNullOrWhiteSpace(incoming.Id))
        {
            if (_pending.TryRemove(incoming.Id, out var completion))
            {
                completion.TrySetResult(incoming);
            }

            return;
        }

        if (!string.IsNullOrWhiteSpace(incoming.Event))
        {
            var lost = false;
            if (!string.IsNullOrWhiteSpace(_eventInstanceId) &&
                !string.Equals(_eventInstanceId, incoming.InstanceId, StringComparison.Ordinal))
            {
                lost = true;
            }
            else if (_lastEventSequence is long previous && incoming.Sequence is long current && current != previous + 1)
            {
                lost = true;
            }
            _eventInstanceId = incoming.InstanceId;
            _lastEventSequence = incoming.Sequence;
            if (lost) ContinuityLost?.Invoke(this, EventArgs.Empty);
            EventReceived?.Invoke(
                this,
                new AgentEvent(
                    incoming.Event,
                    incoming.Sequence,
                    incoming.InstanceId,
                    incoming.Revision,
                    incoming.OccurredAt,
                    incoming.Payload));
        }
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                throw new EndOfStreamException();
            }

            offset += read;
        }
    }

    private void FailPending(Exception exception)
    {
        foreach (var pair in _pending)
        {
            if (_pending.TryRemove(pair.Key, out var completion))
            {
                completion.TrySetException(exception);
            }
        }
    }

    [LibraryImport(
        "kernel32.dll",
        EntryPoint = "WaitNamedPipeW",
        StringMarshalling = StringMarshalling.Utf16,
        SetLastError = true)]
    private static partial int WaitNamedPipe(string name, uint timeoutMilliseconds);
}
