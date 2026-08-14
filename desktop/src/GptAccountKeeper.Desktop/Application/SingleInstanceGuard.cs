using GptAccountKeeper.Desktop.Infrastructure.Ipc;

namespace GptAccountKeeper.Desktop.Application;

/// <summary>
/// 桌面端单实例。互斥量和窗口激活信号都按规范化数据目录分域，不同数据目录可以
/// 同时运行，同一目录的第二次启动只通知已有窗口回到前台。
/// </summary>
internal static class SingleInstanceGuard
{
    private static Mutex? _mutex;
    private static EventWaitHandle? _activationEvent;
    private static RegisteredWaitHandle? _activationRegistration;

    public static bool TryAcquire(string scopeKey)
    {
        if (_mutex is not null) return true;
        var scopeHash = ScopeHash(scopeKey);
        var mutex = new Mutex(
            initiallyOwned: false,
            $"Local\\GptAccountKeeper.Desktop.{scopeHash}",
            out _);
        try
        {
            // 立即返回：等待会让第二次双击的进程挂在后台而不是干脆退出。
            if (!mutex.WaitOne(TimeSpan.Zero, exitContext: false))
            {
                mutex.Dispose();
                return false;
            }
        }
        catch (AbandonedMutexException)
        {
            // 上一个实例崩溃没有释放：互斥量已经归当前进程所有，可以继续。
        }

        _mutex = mutex;
        if (OperatingSystem.IsWindows())
        {
            _activationEvent = new EventWaitHandle(
                initialState: false,
                EventResetMode.AutoReset,
                ActivationEventName(scopeHash));
        }
        return true;
    }

    /// <summary>窗口创建后注册同数据目录第二实例的激活回调。</summary>
    public static void RegisterActivationHandler(Action handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        _activationRegistration?.Unregister(null);
        _activationRegistration = null;
        if (!OperatingSystem.IsWindows() || _activationEvent is null) return;

        _activationRegistration = ThreadPool.RegisterWaitForSingleObject(
            _activationEvent,
            static (state, timedOut) =>
            {
                if (!timedOut && state is Action callback) callback();
            },
            handler,
            Timeout.Infinite,
            executeOnlyOnce: false);
    }

    /// <summary>通知同一数据目录的已有实例显示窗口。</summary>
    public static bool TrySignalExistingWindow(string scopeKey)
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using var activation = EventWaitHandle.OpenExisting(ActivationEventName(ScopeHash(scopeKey)));
            return activation.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    public static void Release()
    {
        _activationRegistration?.Unregister(null);
        _activationRegistration = null;
        _activationEvent?.Dispose();
        _activationEvent = null;

        var mutex = Interlocked.Exchange(ref _mutex, null);
        if (mutex is null) return;
        try
        {
            mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // 未持有时释放会抛；退出路径不该因此失败。
        }
        mutex.Dispose();
    }

    private static string Hash(string value)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes.AsSpan(0, 8));
    }

    private static string ScopeHash(string scopeKey) =>
        Hash(AgentEndpointResolver.CanonicalDataRoot(scopeKey));

    private static string ActivationEventName(string scopeHash) =>
        $"Local\\GptAccountKeeper.Desktop.Activate.{scopeHash}";
}
