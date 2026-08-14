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

internal sealed class UpdateService : IDisposable
{
    private const string RepositoryUrl = "https://github.com/yang-sanmu/chatgpt-account-keeper";
    private static readonly TimeSpan InitialDelay = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private UpdateManager? _manager;
    private UpdateInfo? _pending;
    private Task? _monitor;
    private UpdatePolicy _policy;

    public UpdateSnapshot Snapshot { get; private set; } = new(
        "idle",
        "启动 30 秒后自动检查更新");

    public event EventHandler<UpdateSnapshot>? Changed;

    public void Start(UpdatePolicy policy)
    {
        _policy = policy;
        _monitor ??= MonitorAsync(_lifetime.Token);
    }

    public void ChangePolicy(UpdatePolicy policy)
    {
        _policy = policy;
    }

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
            await Task.Delay(InitialDelay, cancellationToken).ConfigureAwait(false);
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
                _pending = null;
                Publish(new UpdateSnapshot("current", "当前已是最新版本"));
                return;
            }

            _pending = update;
            var version = update.TargetFullRelease.Version.ToString();
            Publish(new UpdateSnapshot(
                "available",
                $"发现新版本 {version}",
                version,
                CanDownload: true));

            if (_policy is UpdatePolicy.DownloadAndPrompt or UpdatePolicy.InstallAtSafePoint)
            {
                await DownloadCoreAsync(_manager, update, cancellationToken).ConfigureAwait(false);
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
        Publish(new UpdateSnapshot(
            "downloaded",
            $"版本 {version} 已下载，等待安全安装",
            version,
            100,
            CanInstall: true));
    }

    private void Publish(UpdateSnapshot snapshot)
    {
        Snapshot = snapshot;
        Changed?.Invoke(this, snapshot);
    }
}
