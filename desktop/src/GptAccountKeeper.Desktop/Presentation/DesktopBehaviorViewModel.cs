using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Infrastructure.Updates;
using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 桌面自身的行为：关闭窗口选择、开机启动、更新策略。
///
/// 这些只写 desktop.json，不与 Agent 业务数据混写；单独拆出来是为了让设置页和
/// 托盘菜单共用同一份状态，不各自维护一套。
/// </summary>
internal sealed class DesktopBehaviorViewModel : ObservableObject
{
    private readonly DesktopSettingsStore _store;
    private readonly StartupRegistrationService _startup;
    private readonly UpdateService _updates;
    private readonly ToastHost _toasts;
    private ThemeOptionViewModel _theme;
    private CloseBehaviorOptionViewModel _closeBehavior;
    private UpdatePolicyOptionViewModel _updatePolicy;
    private bool _startAtLogin;
    private bool _autoStartScheduler;
    private bool _loaded;
    private string _updateStatus = "启动时会自动检查一次更新，之后每 30 分钟后台检查";
    private bool _canDownloadUpdate;
    private bool _canInstallUpdate;
    private string? _ignoredUpdateVersion;
    private string? _pendingLegacyImportRoot;
    private int _promptOpen;
    private int? _windowX;
    private int? _windowY;
    private double _windowWidth = 1260;
    private double _windowHeight = 820;
    private bool _windowMaximized;

    public DesktopBehaviorViewModel(
        DesktopSettingsStore store,
        StartupRegistrationService startup,
        UpdateService updates,
        ToastHost toasts)
    {
        _store = store;
        _startup = startup;
        _updates = updates;
        _toasts = toasts;

        ThemeOptions =
        [
            new(AppTheme.Dark, "暗黑主题 (Dark)", "深邃黑夜 Slate 玻璃质感，专注不刺眼"),
            new(AppTheme.Light, "亮色主题 (Light)", "清爽明亮 Slate 风格，高对比度清晰易读"),
            new(AppTheme.System, "跟随系统 (System)", "自动根据操作系统外观设置切换明暗主题"),
        ];
        _theme = ThemeOptions[0];

        CloseBehaviorOptions =
        [
            new(CloseBehavior.Ask, "每次询问", "关闭窗口时选择隐藏到托盘或退出全部"),
            new(CloseBehavior.MinimizeToTray, "隐藏到托盘", "管理窗口隐藏，Agent 继续执行调度和巡检"),
            new(CloseBehavior.ExitAll, "退出全部", "安全停止 Agent 后退出桌面程序"),
        ];
        _closeBehavior = CloseBehaviorOptions[0];
        UpdatePolicyOptions =
        [
            new(UpdatePolicy.NotifyOnly, "仅提醒", "默认；发现新版本时弹窗询问，下载前不占用带宽"),
            new(UpdatePolicy.DownloadAndPrompt, "后台下载后提醒", "发现更新后先下载好再弹窗，安装仍需确认"),
            new(UpdatePolicy.InstallAtSafePoint, "安全空闲时安装", "下载后等待没有登录窗口和运行任务的安全点"),
        ];
        _updatePolicy = UpdatePolicyOptions[0];

        CheckUpdateCommand = new AsyncRelayCommand(CheckUpdateAsync);
        DownloadUpdateCommand = new AsyncRelayCommand(DownloadUpdateAsync, () => CanDownloadUpdate);
        InstallUpdateCommand = new AsyncRelayCommand(InstallUpdateAsync, () => CanInstallUpdate);
        _updates.Changed += OnUpdateChanged;
        _updates.UpdatePromptRequested += OnUpdatePromptRequested;
    }

    public ObservableCollection<ThemeOptionViewModel> ThemeOptions { get; }

    public ObservableCollection<CloseBehaviorOptionViewModel> CloseBehaviorOptions { get; }

    public ObservableCollection<UpdatePolicyOptionViewModel> UpdatePolicyOptions { get; }

    public ICommand CheckUpdateCommand { get; }
    public ICommand DownloadUpdateCommand { get; }
    public ICommand InstallUpdateCommand { get; }

    /// <summary>安装更新前必须先 drain Agent，由 Shell 提供实现。</summary>
    public Func<CancellationToken, IProgress<UpdateExecutionProgress>?, Task>? InstallRequested { get; set; }

    /// <summary>弹出“发现新版本”提示窗，由窗口提供实现（ViewModel 不依赖顶层控件）。</summary>
    public Func<UpdatePrompt, Task<UpdateChoice>>? UpdatePromptRequested { get; set; }

    /// <summary>用户选择立即更新后显示可取消的前端进度窗。</summary>
    public Func<UpdateProgressRequest, Task>? UpdateProgressRequested { get; set; }

    /// <summary>下次启动时要执行的旧项目导入源目录；导入完成后由 Shell 清除。</summary>
    public string? PendingLegacyImportRoot => _pendingLegacyImportRoot;

    public CancellationToken Lifetime { get; set; } = CancellationToken.None;

    public ThemeOptionViewModel SelectedTheme
    {
        get => _theme;
        set
        {
            if (value is null || !SetProperty(ref _theme, value)) return;
            OnPropertyChanged(nameof(Theme));
            ApplyTheme(value.Value);
            if (_loaded) _ = PersistAsync();
        }
    }

    public AppTheme Theme => SelectedTheme.Value;

    public CloseBehaviorOptionViewModel SelectedCloseBehavior
    {
        get => _closeBehavior;
        set
        {
            if (value is null || !SetProperty(ref _closeBehavior, value)) return;
            OnPropertyChanged(nameof(CloseBehavior));
            if (_loaded) _ = PersistAsync();
        }
    }

    public CloseBehavior CloseBehavior => SelectedCloseBehavior.Value;

    public UpdatePolicyOptionViewModel SelectedUpdatePolicy
    {
        get => _updatePolicy;
        set
        {
            if (value is null || !SetProperty(ref _updatePolicy, value)) return;
            if (!_loaded) return;
            _updates.ChangePolicy(value.Value);
            _ = PersistAsync();
        }
    }

    public bool StartAtLogin
    {
        get => _startAtLogin;
        set
        {
            if (!SetProperty(ref _startAtLogin, value) || !_loaded) return;
            _ = PersistAsync();
        }
    }

    public bool AutoStartScheduler
    {
        get => _autoStartScheduler;
        set
        {
            if (!SetProperty(ref _autoStartScheduler, value) || !_loaded) return;
            _ = PersistAsync();
        }
    }

    /// <summary>供“启动调度”提示窗使用；等待落盘后再执行本次启动。</summary>
    public async Task SetAutoStartSchedulerAsync(bool enabled)
    {
        if (!SetProperty(ref _autoStartScheduler, enabled, nameof(AutoStartScheduler))) return;
        if (_loaded) await PersistAsync();
    }

    public string UpdateStatus
    {
        get => _updateStatus;
        private set => SetProperty(ref _updateStatus, value);
    }

    public bool CanDownloadUpdate
    {
        get => _canDownloadUpdate;
        private set
        {
            if (SetProperty(ref _canDownloadUpdate, value))
            {
                (DownloadUpdateCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            }
        }
    }

    public bool CanInstallUpdate
    {
        get => _canInstallUpdate;
        private set
        {
            if (SetProperty(ref _canInstallUpdate, value))
            {
                (InstallUpdateCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            }
        }
    }

    public int? WindowX => _windowX;

    public int? WindowY => _windowY;

    public double WindowWidth => _windowWidth;

    public double WindowHeight => _windowHeight;

    public bool WindowMaximized => _windowMaximized;

    public static void ApplyTheme(AppTheme theme)
    {
        if (Avalonia.Application.Current is null) return;
        Avalonia.Application.Current.RequestedThemeVariant = theme switch
        {
            AppTheme.Light => Avalonia.Styling.ThemeVariant.Light,
            AppTheme.System => Avalonia.Styling.ThemeVariant.Default,
            _ => Avalonia.Styling.ThemeVariant.Dark,
        };
    }

    public async Task LoadAsync(CancellationToken cancellationToken)
    {
        var settings = await _store.LoadAsync(cancellationToken);
        _theme = ThemeOptions.FirstOrDefault(option => option.Value == settings.Theme) ?? ThemeOptions[0];
        OnPropertyChanged(nameof(SelectedTheme));
        OnPropertyChanged(nameof(Theme));
        ApplyTheme(_theme.Value);
        _startAtLogin = settings.StartAtLogin;
        _startup.SetEnabled(settings.StartAtLogin);
        OnPropertyChanged(nameof(StartAtLogin));
        _autoStartScheduler = settings.AutoStartScheduler;
        OnPropertyChanged(nameof(AutoStartScheduler));
        _closeBehavior = CloseBehaviorOptions.First(option => option.Value == settings.CloseBehavior);
        OnPropertyChanged(nameof(SelectedCloseBehavior));
        OnPropertyChanged(nameof(CloseBehavior));
        _updatePolicy = UpdatePolicyOptions.First(option => option.Value == settings.UpdatePolicy);
        OnPropertyChanged(nameof(SelectedUpdatePolicy));
        _windowX = settings.WindowX;
        _windowY = settings.WindowY;
        _windowWidth = Math.Clamp(settings.WindowWidth, 1120, 4000);
        _windowHeight = Math.Clamp(settings.WindowHeight, 720, 2400);
        _windowMaximized = settings.WindowMaximized;
        _ignoredUpdateVersion = settings.IgnoredUpdateVersion;
        _pendingLegacyImportRoot = settings.PendingLegacyImportRoot;
        _loaded = true;
        _updates.Start(settings.UpdatePolicy, settings.IgnoredUpdateVersion);
    }

    /// <summary>记下待执行的旧项目导入；换数据目录重启后由 Shell 接着做。</summary>
    public Task RememberPendingLegacyImportAsync(string? legacyRoot)
    {
        _pendingLegacyImportRoot = string.IsNullOrWhiteSpace(legacyRoot) ? null : legacyRoot;
        return PersistAsync();
    }

    public async Task RememberCloseChoiceAsync(CloseChoice choice)
    {
        var behavior = choice switch
        {
            CloseChoice.HideToTray => CloseBehavior.MinimizeToTray,
            CloseChoice.ExitAll => CloseBehavior.ExitAll,
            _ => CloseBehavior.Ask,
        };
        _closeBehavior = CloseBehaviorOptions.First(option => option.Value == behavior);
        OnPropertyChanged(nameof(SelectedCloseBehavior));
        OnPropertyChanged(nameof(CloseBehavior));
        await PersistAsync();
    }

    public Task SaveWindowPlacementAsync(int? x, int? y, double width, double height, bool maximized)
    {
        if (x is not null) _windowX = x;
        if (y is not null) _windowY = y;
        if (double.IsFinite(width) && width >= 1120) _windowWidth = width;
        if (double.IsFinite(height) && height >= 720) _windowHeight = height;
        _windowMaximized = maximized;
        return PersistAsync();
    }

    public Task ApplyAndRestartAsync()
    {
        _updates.ScheduleApplyAndRestart();
        return Task.CompletedTask;
    }

    public bool WantsSafePointInstall => SelectedUpdatePolicy.Value == UpdatePolicy.InstallAtSafePoint;

    private async Task PersistAsync()
    {
        try
        {
            await _store.SaveAsync(
                new DesktopSettings
                {
                    Theme = SelectedTheme.Value,
                    StartAtLogin = StartAtLogin,
                    AutoStartScheduler = AutoStartScheduler,
                    CloseBehavior = SelectedCloseBehavior.Value,
                    UpdatePolicy = SelectedUpdatePolicy.Value,
                    IgnoredUpdateVersion = _ignoredUpdateVersion,
                    PendingLegacyImportRoot = _pendingLegacyImportRoot,
                    WindowX = _windowX,
                    WindowY = _windowY,
                    WindowWidth = _windowWidth,
                    WindowHeight = _windowHeight,
                    WindowMaximized = _windowMaximized,
                },
                Lifetime);
            _startup.SetEnabled(StartAtLogin);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception exception)
        {
            _toasts.Error($"保存桌面设置失败：{exception.Message}");
        }
    }

    private Task CheckUpdateAsync() => Guard("检查更新", () => _updates.CheckNowAsync(Lifetime));

    private Task DownloadUpdateAsync() => Guard("下载更新", () => _updates.DownloadPendingAsync(Lifetime));

    private Task InstallUpdateAsync() => Guard(
        "安装更新",
        () => InstallRequested?.Invoke(Lifetime, null) ?? Task.CompletedTask);

    private async Task Guard(string action, Func<Task> execute)
    {
        try
        {
            await execute();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception exception)
        {
            _toasts.Error($"{action}失败：{exception.Message}");
        }
    }

    /// <summary>
    /// 处理“发现新版本”的用户选择。
    ///
    /// 立即更新会补齐缺失的步骤：还没下载就先下载，下载好直接进入安装流程；
    /// 用户不必像以前那样点两次“下载更新”再自己找“安全安装”。
    /// </summary>
    private void OnUpdatePromptRequested(object? sender, UpdatePrompt prompt)
    {
        if (UpdatePromptRequested is null) return;
        Avalonia.Threading.Dispatcher.UIThread.Post(() => _ = HandleUpdatePromptAsync(prompt));
    }

    internal async Task HandleUpdatePromptAsync(UpdatePrompt prompt)
    {
        if (UpdatePromptRequested is null) return;
        // 后台每 30 分钟一轮，一次"立即更新"的下载可能跨过下一轮检查。
        // 不加这道闩会叠出第二个模态窗，把第一个挡在后面。
        if (Interlocked.Exchange(ref _promptOpen, 1) != 0) return;
        try
        {
            var choice = await UpdatePromptRequested(prompt);
            switch (choice)
            {
                case UpdateChoice.UpdateNow:
                    if (UpdateProgressRequested is not null)
                    {
                        await UpdateProgressRequested(new UpdateProgressRequest(
                            prompt.Version,
                            prompt.AlreadyDownloaded,
                            (progress, cancellationToken) =>
                                ExecuteImmediateUpdateAsync(prompt, progress, cancellationToken)));
                    }
                    else
                    {
                        await Guard(
                            "更新",
                            () => ExecuteImmediateUpdateAsync(prompt, null, Lifetime));
                    }
                    break;
                case UpdateChoice.RemindNextLaunch:
                    _updates.DeferVersion(prompt.Version);
                    _toasts.Info($"已跳过本次提醒，下次启动会重新提示版本 {prompt.Version}");
                    break;
                case UpdateChoice.IgnoreThisVersion:
                    _updates.IgnoreVersion(prompt.Version);
                    _ignoredUpdateVersion = prompt.Version;
                    await PersistAsync();
                    _toasts.Info($"已忽略版本 {prompt.Version}；更高版本仍会提示");
                    break;
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception exception)
        {
            _toasts.Error($"处理更新提示失败：{exception.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _promptOpen, 0);
        }
    }

    private async Task ExecuteImmediateUpdateAsync(
        UpdatePrompt prompt,
        IProgress<UpdateExecutionProgress>? progress,
        CancellationToken cancellationToken)
    {
        EventHandler<UpdateSnapshot>? onChanged = null;
        if (progress is not null)
        {
            onChanged = (_, snapshot) =>
            {
                if (snapshot.State == "downloading")
                {
                    progress.Report(new UpdateExecutionProgress(
                        "正在下载更新…",
                        snapshot.Message,
                        snapshot.Progress,
                        CanCancel: true));
                }
            };
            _updates.Changed += onChanged;
        }

        try
        {
            if (!prompt.AlreadyDownloaded && !CanInstallUpdate)
            {
                progress?.Report(new UpdateExecutionProgress(
                    "正在下载更新…",
                    $"正在下载版本 {prompt.Version}，可随时取消。",
                    0,
                    CanCancel: true));
                await _updates.DownloadPendingAsync(cancellationToken);
            }

            cancellationToken.ThrowIfCancellationRequested();
            progress?.Report(new UpdateExecutionProgress(
                "更新包已就绪",
                "正在检查 Agent、Chrome 窗口和运行任务。",
                Percent: null,
                CanCancel: true));
            await (InstallRequested?.Invoke(cancellationToken, progress) ?? Task.CompletedTask);
        }
        finally
        {
            if (onChanged is not null) _updates.Changed -= onChanged;
        }
    }

    private void OnUpdateChanged(object? sender, UpdateSnapshot snapshot)
    {
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            UpdateStatus = snapshot.Message;
            CanDownloadUpdate = snapshot.CanDownload;
            CanInstallUpdate = snapshot.CanInstall;
        });
    }
}

internal sealed record ThemeOptionViewModel(AppTheme Value, string Title, string Description);
