using System.Text.Json.Serialization.Metadata;
using Avalonia.Threading;
using GptAccountKeeper.Desktop.Infrastructure.Agent;
using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 页面共享的 Agent 会话。
///
/// 每个页面自己持有连接逻辑会导致重复的"没连上就先连"分支，也无法统一反馈。
/// 这里集中三件事：按需连接、统一的失败提示、忙碌状态。页面只写业务调用。
/// </summary>
internal sealed class AgentSession : ObservableObject
{
    private readonly AgentConnectionService _connection;
    private int _busyCount;

    public AgentSession(AgentConnectionService connection, ToastHost toasts)
    {
        _connection = connection;
        Toasts = toasts;
    }

    public ToastHost Toasts { get; }

    public CancellationToken Lifetime { get; set; } = CancellationToken.None;

    public bool IsConnected => _connection.IsConnected;

    public bool IsBusy => Volatile.Read(ref _busyCount) > 0;

    /// <summary>请求一次全量数据同步。由 Shell 提供实现。</summary>
    public Func<Task>? RequestRefresh { get; set; }

    /// <summary>确认对话框。由窗口提供实现，页面不直接依赖 Window。</summary>
    public Func<string, string, bool, Task<bool>>? ConfirmAsync { get; set; }

    public Task<TResult> CallAsync<TParams, TResult>(
        string method,
        TParams parameters,
        JsonTypeInfo<TParams> parametersType,
        JsonTypeInfo<TResult> resultType,
        string? commandId = null) =>
        _connection.CallAsync(method, parameters, parametersType, resultType, Lifetime, commandId);

    public static string NewCommandId() => Guid.NewGuid().ToString();

    /// <summary>
    /// 执行一次用户动作：自动补连接、统一失败提示、忙碌计数。
    /// 返回 false 表示动作失败（已经提示过），调用方可据此跳过后续步骤。
    /// </summary>
    public async Task<bool> RunAsync(string action, Func<Task> execute, string? successMessage = null)
    {
        Interlocked.Increment(ref _busyCount);
        OnPropertyChanged(nameof(IsBusy));
        try
        {
            if (!_connection.IsConnected)
            {
                var snapshot = await _connection.EnsureConnectedAsync(true, Lifetime);
                if (!snapshot.IsConnected)
                {
                    Toasts.Error($"{action}失败：{snapshot.Detail}");
                    return false;
                }
            }

            await execute();
            if (successMessage is not null) Toasts.Success(successMessage);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (Exception exception)
        {
            // 稳定错误码要露出来：用户和日志都靠它定位问题。
            Toasts.Error(exception is AgentRpcException rpc
                ? $"{action}失败 [{rpc.Code}]：{rpc.Message}"
                : $"{action}失败：{exception.Message}");
            return false;
        }
        finally
        {
            Interlocked.Decrement(ref _busyCount);
            Dispatcher.UIThread.Post(() => OnPropertyChanged(nameof(IsBusy)));
        }
    }

    public Task<bool> ConfirmDestructiveAsync(string title, string message) =>
        ConfirmAsync is null ? Task.FromResult(false) : ConfirmAsync(title, message, true);

    public Task RefreshAsync() => RequestRefresh?.Invoke() ?? Task.CompletedTask;
}
