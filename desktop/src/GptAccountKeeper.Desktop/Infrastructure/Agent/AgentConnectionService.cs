using System.Net.Sockets;
using System.Text.Json.Serialization.Metadata;
using GptAccountKeeper.Desktop.Infrastructure.Ipc;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;
using System.Text.Json;

namespace GptAccountKeeper.Desktop.Infrastructure.Agent;

internal sealed record AgentConnectionSnapshot(
    bool IsConnected,
    string Status,
    string Detail,
    string? AgentVersion = null,
    string? InstanceId = null);

internal sealed class AgentConnectionService : IAsyncDisposable
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromMilliseconds(700);
    private readonly AgentEndpoint _endpoint;
    private readonly AgentProcessLauncher _launcher;
    private readonly string _ipcCredential;
    private readonly string _dataRoot;
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private AgentIpcClient? _client;
    private int _disposed;

    public AgentConnectionService(
        AgentEndpoint endpoint,
        AgentProcessLauncher launcher,
        string ipcCredential,
        string dataRoot)
    {
        _endpoint = endpoint;
        _launcher = launcher;
        _ipcCredential = ipcCredential;
        _dataRoot = AgentEndpointResolver.CanonicalDataRoot(dataRoot);
    }

    public AgentEndpoint Endpoint => _endpoint;

    public bool IsConnected => _client?.IsConnected == true;

    public AgentConnectionSnapshot Snapshot { get; private set; } = new(
        false,
        "未连接",
        "正在等待首次连接");

    public event EventHandler<AgentConnectionSnapshot>? ConnectionChanged;

    public event EventHandler<AgentEvent>? EventReceived;

    public event EventHandler<MigrationProgressDto>? MigrationProgressChanged;

    public event EventHandler? ResynchronizationRequired;

    public Task<LegacyMigrationProbeResult> InspectLegacyAsync(
        string selectedRoot,
        CancellationToken cancellationToken = default) =>
        _launcher.InspectLegacyAsync(selectedRoot, cancellationToken);

    public Task<TResult> CallAsync<TParams, TResult>(
        string method,
        TParams parameters,
        JsonTypeInfo<TParams> parametersType,
        JsonTypeInfo<TResult> resultType,
        CancellationToken cancellationToken = default,
        string? commandId = null)
    {
        var client = _client;
        if (client?.IsConnected != true)
        {
            throw new InvalidOperationException("尚未连接 Agent");
        }

        return client.CallAsync(
            method,
            parameters,
            parametersType,
            resultType,
            cancellationToken,
            commandId);
    }

    public async Task WaitForDisconnectAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (IsConnected && DateTime.UtcNow < deadline)
        {
            await Task.Delay(50, cancellationToken).ConfigureAwait(false);
        }
        if (IsConnected)
        {
            throw new TimeoutException("Agent 未能在限定时间内完成安全退出");
        }
    }

    public async Task<AgentConnectionSnapshot> EnsureConnectedAsync(
        bool startWhenUnavailable,
        CancellationToken cancellationToken = default)
    {
        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_client?.IsConnected == true)
            {
                return Snapshot;
            }

            var initial = await TryConnectAsync(cancellationToken).ConfigureAwait(false);
            if (initial.IsConnected || !startWhenUnavailable)
            {
                return initial;
            }

            Publish(new AgentConnectionSnapshot(false, "正在启动 Agent", initial.Detail));
            var launch = _launcher.TryStart(_endpoint);
            if (!launch.Started)
            {
                return Publish(new AgentConnectionSnapshot(false, "Agent 启动失败", launch.Message));
            }

            Exception? lastFailure = null;
            for (var attempt = 0; attempt < 30; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                if (launch.ProcessId is int processId && !IsProcessAlive(processId))
                {
                    return Publish(new AgentConnectionSnapshot(
                        false,
                        "Agent 启动失败",
                        $"Agent 进程 {processId} 在建立 IPC 前退出。诊断日志：{launch.LogFile}"));
                }
                try
                {
                    var connected = await TryConnectAsync(cancellationToken).ConfigureAwait(false);
                    if (connected.IsConnected)
                    {
                        return connected;
                    }
                }
                catch (Exception exception) when (exception is IOException or TimeoutException)
                {
                    lastFailure = exception;
                }
            }

            return Publish(new AgentConnectionSnapshot(
                false,
                "Agent 无响应",
                lastFailure?.Message ?? $"已启动进程 {launch.ProcessId}，但未能在限定时间内连接 IPC"));
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<AgentConnectionSnapshot> StartWithLegacyMigrationAsync(
        string legacyRoot,
        CancellationToken cancellationToken = default)
    {
        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_client?.IsConnected == true)
            {
                throw new InvalidOperationException("Agent 已在运行；只有首次创建数据库前才能导入旧项目");
            }

            var launch = _launcher.TryStart(_endpoint, legacyRoot);
            if (!launch.Started)
            {
                return Publish(new AgentConnectionSnapshot(false, "旧数据迁移启动失败", launch.Message));
            }

            AgentConnectionSnapshot latest = new(false, "正在迁移旧数据", "正在校验旧配置与复制 Profile");
            string? lastProgressPayload = null;
            var migrationCompleted = false;
            for (var attempt = 0; attempt < 2400; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                var progress = ReadMigrationProgress(launch.ProgressFile, ref lastProgressPayload);
                if (progress is not null)
                {
                    migrationCompleted |= string.Equals(
                        progress.State,
                        "succeeded",
                        StringComparison.OrdinalIgnoreCase)
                        || string.Equals(
                            progress.Stage,
                            "completed",
                            StringComparison.OrdinalIgnoreCase);
                    MigrationProgressChanged?.Invoke(this, progress);
                    var percent = progress.Progress is double value ? $" · {value:P0}" : string.Empty;
                    latest = Publish(new AgentConnectionSnapshot(
                        false,
                        progress.State == "failed" ? "旧数据迁移失败" : "正在迁移旧数据",
                        $"{progress.Message}{percent}"));
                }
                if (launch.ProcessId is int processId && !IsProcessAlive(processId))
                {
                    progress ??= ReadMigrationProgress(launch.ProgressFile, ref lastProgressPayload, force: true);
                    var failure = progress?.Error?.Message ?? progress?.Message;
                    return Publish(new AgentConnectionSnapshot(
                        false,
                        "旧数据迁移失败",
                        $"{failure ?? "Agent 已在建立 IPC 前退出"}。旧目录未被修改。诊断日志：{launch.LogFile}"));
                }

                // The Agent deliberately does not expose IPC until the migration has
                // copied and verified every Profile and opened the promoted database.
                // Polling the not-yet-created pipe during that potentially long phase
                // only creates expected timeout/cancellation exceptions in the debugger.
                if (!migrationCompleted)
                {
                    continue;
                }

                latest = await TryConnectAsync(cancellationToken).ConfigureAwait(false);
                if (latest.IsConnected)
                {
                    return latest;
                }
            }

            return Publish(new AgentConnectionSnapshot(
                false,
                "旧数据迁移未完成",
                $"Agent 进程 {launch.ProcessId} 未在限定时间内建立 IPC，请查看日志：{launch.LogFile}"));
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        if (_client is not null)
        {
            await _client.DisposeAsync().ConfigureAwait(false);
        }

        _operationGate.Dispose();
    }

    private async Task<AgentConnectionSnapshot> TryConnectAsync(CancellationToken cancellationToken)
    {
        if (_client is not null)
        {
            await _client.DisposeAsync().ConfigureAwait(false);
        }

        if (!AgentIpcClient.IsEndpointAvailable(_endpoint))
        {
            var unavailable = new AgentConnectionSnapshot(
                false,
                "未连接",
                $"Agent IPC 尚未就绪：{_endpoint.DisplayName}");
            // 启动轮询期间保持“正在启动”状态，避免界面每 250ms 来回闪烁。
            return Snapshot.Status == "正在启动 Agent" ? unavailable : Publish(unavailable);
        }

        var client = new AgentIpcClient(_endpoint);
        client.EventReceived += OnEventReceived;
        client.Disconnected += OnDisconnected;
        client.ContinuityLost += OnContinuityLost;
        _client = client;

        try
        {
            Publish(new AgentConnectionSnapshot(false, "正在连接", _endpoint.DisplayName));
            await client.ConnectAsync(ConnectTimeout, cancellationToken).ConfigureAwait(false);
            var requestedMinor = _endpoint.UseLegacyHandshake ? 0 : AgentProtocol.Minor;
            var hello = await client.CallAsync(
                    "system.hello",
                    new AgentHelloParams(
                        new ProtocolVersionDto(AgentProtocol.Major, requestedMinor),
                        ThisAssemblyVersion(),
                        ["events", "native-desktop", "tray"],
                        _ipcCredential,
                        _endpoint.UseLegacyHandshake ? null : _dataRoot),
                    AppJsonContext.Default.AgentHelloParams,
                    AppJsonContext.Default.AgentHelloResult,
                    cancellationToken)
                .ConfigureAwait(false);
            if (hello.Protocol.Major != AgentProtocol.Major)
            {
                throw new InvalidDataException(
                    $"协议不兼容：客户端 v{AgentProtocol.Major}，Agent v{hello.Protocol.Major}");
            }
            if (requestedMinor < hello.Protocol.MinMinor || requestedMinor > hello.Protocol.MaxMinor)
            {
                throw new InvalidOperationException(
                    $"协议次版本不兼容：客户端 v{AgentProtocol.Major}.{requestedMinor}，" +
                    $"Agent 支持 {hello.Protocol.Major}.{hello.Protocol.MinMinor}-{hello.Protocol.MaxMinor}");
            }
            if ((!_endpoint.UseLegacyHandshake && string.IsNullOrWhiteSpace(hello.DataRoot))
                || (!string.IsNullOrWhiteSpace(hello.DataRoot) && !string.Equals(
                    AgentEndpointResolver.CanonicalDataRoot(hello.DataRoot),
                    _dataRoot,
                    OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)))
            {
                throw new InvalidDataException(
                    $"Agent 数据目录不匹配：Desktop={_dataRoot}，Agent={hello.DataRoot ?? "未报告"}");
            }

            return Publish(new AgentConnectionSnapshot(
                true,
                "Agent 已连接",
                $"协议 {hello.Protocol.Major}.{hello.Protocol.MaxMinor} · 实例 {hello.InstanceId}",
                hello.AgentVersion,
                hello.InstanceId));
        }
        catch (Exception exception) when (
            exception is IOException
                or SocketException
                or TimeoutException
                or OperationCanceledException
                or InvalidDataException
                or AgentRpcException)
        {
            if (exception is OperationCanceledException && cancellationToken.IsCancellationRequested)
            {
                throw;
            }

            client.EventReceived -= OnEventReceived;
            client.Disconnected -= OnDisconnected;
            client.ContinuityLost -= OnContinuityLost;
            await client.DisposeAsync().ConfigureAwait(false);
            if (ReferenceEquals(_client, client))
            {
                _client = null;
            }

            return Publish(new AgentConnectionSnapshot(false, "未连接", exception.Message));
        }
    }

    private void OnEventReceived(object? sender, AgentEvent agentEvent)
    {
        EventReceived?.Invoke(this, agentEvent);
    }

    private void OnDisconnected(object? sender, Exception? error)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        Publish(new AgentConnectionSnapshot(
            false,
            "连接已断开",
            error?.Message ?? "Agent 已关闭 IPC 连接"));
    }

    private void OnContinuityLost(object? sender, EventArgs e)
    {
        ResynchronizationRequired?.Invoke(this, EventArgs.Empty);
    }

    private AgentConnectionSnapshot Publish(AgentConnectionSnapshot snapshot)
    {
        Snapshot = snapshot;
        ConnectionChanged?.Invoke(this, snapshot);
        return snapshot;
    }

    private static string ThisAssemblyVersion()
    {
        return typeof(AgentConnectionService).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";
    }

    internal static bool IsProcessAlive(int processId)
    {
        // Process.GetProcessById uses ArgumentException to report an exited child,
        // which appears as a first-chance error in Visual Studio during normal
        // migration shutdown. Enumerating the current process table has a
        // non-exceptional "not found" result and is only used for the migration
        // child liveness check.
        foreach (var process in System.Diagnostics.Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id == processId)
                {
                    return true;
                }
            }
        }

        return false;
    }

    internal static MigrationProgressDto? ReadMigrationProgress(
        string? file,
        ref string? lastPayload,
        bool force = false)
    {
        if (string.IsNullOrWhiteSpace(file) || !File.Exists(file)) return null;
        try
        {
            // The Agent updates this file through an atomic rename. File.ReadAllText
            // does not share delete access on Windows, so it can make the rename fail
            // with EBUSY/EPERM. Explicit sharing keeps progress reads and atomic
            // replacements independent.
            using var stream = new FileStream(
                file,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 4096,
                FileOptions.SequentialScan);
            using var reader = new StreamReader(
                stream,
                System.Text.Encoding.UTF8,
                detectEncodingFromByteOrderMarks: true);
            var text = reader.ReadToEnd();
            var payload = LastCompleteProgressPayload(text);
            if (payload is null || (!force && string.Equals(payload, lastPayload, StringComparison.Ordinal)))
            {
                return null;
            }
            var progress = JsonSerializer.Deserialize(payload, AppJsonContext.Default.MigrationProgressDto);
            if (progress is not null) lastPayload = payload;
            return progress;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    internal static string? LastCompleteProgressPayload(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal);
        var endsWithNewline = normalized.EndsWith('\n');
        var lines = normalized.Split('\n');
        var lastIndex = endsWithNewline ? lines.Length - 2 : lines.Length - 1;
        if (!endsWithNewline && lines.Length > 1)
        {
            // An append may be visible before its terminating newline. Ignore that
            // last fragment and keep the most recent complete record.
            lastIndex--;
        }
        for (var index = lastIndex; index >= 0; index--)
        {
            var candidate = lines[index].Trim();
            if (candidate.Length == 0) continue;
            // Backward compatibility with the Alpha 2 single-JSON progress file.
            if (lines.Length == 1 && !endsWithNewline && candidate.EndsWith('}')) return candidate;
            if (endsWithNewline || index < lines.Length - 1) return candidate;
        }
        return null;
    }
}
