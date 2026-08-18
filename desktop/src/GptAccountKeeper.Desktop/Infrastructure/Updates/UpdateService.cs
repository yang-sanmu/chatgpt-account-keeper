using GptAccountKeeper.Desktop.Models;
using Velopack;
using Velopack.Sources;

namespace GptAccountKeeper.Desktop.Infrastructure.Updates;

internal sealed record UpdateSnapshot(
    string State,
    string Message,
    string? Version = null,
    int? Progress = null,
    bool CanDownload = false,
    bool CanInstall = false);

/// <summary>发现新版本时给界面的提示请求。Manual 决定是否越过“忽略本次更新”。</summary>
internal sealed record UpdatePrompt(string Version, bool Manual, bool AlreadyDownloaded);

internal sealed class UpdateService : IDisposable
{
    private const string RepositoryUrl = "https://github.com/yang-sanmu/chatgpt-account-keeper";
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly UpdateGate _state = new();
    private UpdateManager? _manager;
    private UpdateInfo? _pending;
    private Task? _monitor;
    private UpdatePolicy _policy;

    public UpdateSnapshot Snapshot { get; private set; } = new(
        "idle",
        "启动时会自动检查一次更新，之后每 6 小时后台检查");

    public event EventHandler<UpdateSnapshot>? Changed;

    /// <summary>发现可用更新且尚未被压制时触发，由界面决定如何提示用户。</summary>
    public event EventHandler<UpdatePrompt>? UpdatePromptRequested;

    public string? IgnoredVersion => _state.IgnoredVersion;

    /// <summary>启动时立刻检查一次，随后进入固定间隔的后台检查。</summary>
    public void Start(UpdatePolicy policy, string? ignoredVersion = null)
    {
        _policy = policy;
        _state.Ignore(ignoredVersion);
        _monitor ??= MonitorAsync(_lifetime.Token);
    }

    public void ChangePolicy(UpdatePolicy policy)
    {
        _policy = policy;
    }

    /// <summary>“忽略本次更新”：压制这个版本的弹窗，更高版本仍会提示。</summary>
    public void IgnoreVersion(string? version) => _state.Ignore(version);

    /// <summary>“下次启动提醒”：本次会话不再弹，下次启动的首检会重新提示。</summary>
    public void DeferVersion(string? version) => _state.Defer(version);

    public Task CheckNowAsync(CancellationToken cancellationToken = default) =>
        CheckAsync(manual: true, cancellationToken);

    public async Task DownloadPendingAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_manager is null || _pending is null)
            {
                throw new InvalidOperationException("当前没有可下载的更新");
            }

            var version = _pending.TargetFullRelease.Version.ToString();
            if (_state.IsDownloaded(version))
            {
                // 已经下载好了就只是重申状态，不重复拉一遍安装包。
                Publish(UpdateGate.Downloaded(version));
                return;
            }

            await DownloadCoreAsync(_manager, _pending, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public void ScheduleApplyAndRestart()
    {
        if (_manager is null)
        {
            throw new InvalidOperationException("更新管理器尚未初始化");
        }

        var target = _manager.UpdatePendingRestart ?? _pending?.TargetFullRelease
            ?? throw new InvalidOperationException("更新尚未下载完成");
        _manager.WaitExitThenApplyUpdates(target, silent: true, restart: true);
    }

    public void Dispose()
    {
        _lifetime.Cancel();
        _lifetime.Dispose();
        _gate.Dispose();
    }

    private async Task MonitorAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                await CheckAsync(manual: false, cancellationToken).ConfigureAwait(false);
                await Task.Delay(CheckInterval, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task CheckAsync(bool manual, CancellationToken cancellationToken)
    {
        // 提示事件要留到释放 _gate 之后再发：处理"立即更新"会回调
        // DownloadPendingAsync，那里同样要拿 _gate。在锁内直接发事件的话，
        // 只要哪天处理端改成同步执行就会死锁。
        UpdatePrompt? pendingPrompt = null;
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Publish(new UpdateSnapshot("checking", manual ? "正在检查更新…" : "正在后台检查更新…"));
            _manager ??= new UpdateManager(new GithubSource(
                RepositoryUrl,
                accessToken: null,
                prerelease: false));
            if (!_manager.IsInstalled)
            {
                Publish(new UpdateSnapshot("portable", "当前是开发/便携运行，安装版更新检查未启用"));
                return;
            }

            var update = await _manager.CheckForUpdatesAsync().WaitAsync(cancellationToken).ConfigureAwait(false);
            if (update is null)
            {
                // 已下载待安装时 Velopack 仍会报告该版本；真的没有更新才清空可安装状态。
                _pending = null;
                _state.ClearDownloaded();
                Publish(new UpdateSnapshot("current", "当前已是最新版本"));
                return;
            }

            _pending = update;
            var version = update.TargetFullRelease.Version.ToString();

            // 一次检查绝不能把"已下载待安装"降级回"可下载"（见 UpdateGate.Coalesce）。
            if (IsStagedByVelopack(version)) _state.MarkDownloaded(version);
            var staged = _state.IsDownloaded(version);
            Publish(new UpdateSnapshot(
                "available",
                $"发现新版本 {version}",
                version,
                CanDownload: true));

            if (!staged && _policy is UpdatePolicy.DownloadAndPrompt or UpdatePolicy.InstallAtSafePoint)
            {
                // 预下载失败不能顺带把提示也吃掉：下面仍会照常弹窗，
                // 只是这次 AlreadyDownloaded=false，用户点"立即更新"时再下载。
                try
                {
                    await DownloadCoreAsync(_manager, update, cancellationToken).ConfigureAwait(false);
                    staged = true;
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    Publish(new UpdateSnapshot(
                        "available",
                        $"发现新版本 {version}，自动下载失败：{exception.Message}",
                        version,
                        CanDownload: true));
                }
            }

            // MarkPrompted 必须留到真的要弹窗时才做，否则一次下载异常
            // 就会让这个版本在本次会话里再也不提示。
            if (_state.ShouldPrompt(version, manual))
            {
                _state.MarkPrompted(version);
                pendingPrompt = new UpdatePrompt(version, manual, staged);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            // Network and release-feed failures never affect the local Agent.
            Publish(new UpdateSnapshot("error", $"更新检查失败：{exception.Message}"));
        }
        finally
        {
            _gate.Release();
        }

        if (pendingPrompt is not null)
        {
            UpdatePromptRequested?.Invoke(this, pendingPrompt);
        }
    }

    /// <summary>
    /// 该版本是否已经落盘等待重启。Velopack 在下载完成后用 UpdatePendingRestart
    /// 暴露待应用的包：上次运行下载完但还没装的更新，重启后仍然可以直接安装。
    /// </summary>
    private bool IsStagedByVelopack(string version)
    {
        try
        {
            var staged = _manager?.UpdatePendingRestart;
            return staged is not null
                && string.Equals(
                    staged.Version.ToString(),
                    version,
                    StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 读取本地暂存包失败不该让整次检查失败：当作尚未下载，重新下载即可。
            return false;
        }
    }

    private async Task DownloadCoreAsync(
        UpdateManager manager,
        UpdateInfo update,
        CancellationToken cancellationToken)
    {
        var version = update.TargetFullRelease.Version.ToString();
        Publish(new UpdateSnapshot("downloading", $"正在下载 {version}", version, 0));
        await manager.DownloadUpdatesAsync(
                update,
                progress => Publish(new UpdateSnapshot(
                    "downloading",
                    $"正在下载 {version} · {progress}%",
                    version,
                    progress)))
            .WaitAsync(cancellationToken)
            .ConfigureAwait(false);
        // 先记下已下载再发布：Velopack 的进度回调来自独立线程，最后一次可能在
        // DownloadUpdatesAsync 返回之后才投递，Publish 会把它折叠成 downloaded。
        _state.MarkDownloaded(version);
        Publish(UpdateGate.Downloaded(version));
    }

    /// <summary>
    /// 所有状态都经过 UpdateGate.Coalesce：已下载待安装的版本不会被降级回
    /// "需要下载"，无论降级来自新一轮检查还是迟到的下载进度回调。
    /// </summary>
    private void Publish(UpdateSnapshot snapshot)
    {
        var coalesced = _state.Coalesce(snapshot);
        Snapshot = coalesced;
        Changed?.Invoke(this, coalesced);
    }
}
