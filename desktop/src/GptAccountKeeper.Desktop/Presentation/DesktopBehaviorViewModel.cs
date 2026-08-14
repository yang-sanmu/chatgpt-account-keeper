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
    private CloseBehaviorOptionViewModel _closeBehavior;
    private UpdatePolicyOptionViewModel _updatePolicy;
    private bool _startAtLogin;
    private bool _loaded;
    private string _updateStatus = "启动 30 秒后自动检查更新";
    private bool _canDownloadUpdate;
    private bool _canInstallUpdate;
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

        CloseBehaviorOptions =
        [
            new(CloseBehavior.Ask, "每次询问", "关闭窗口时选择隐藏到托盘或退出全部"),
            new(CloseBehavior.MinimizeToTray, "隐藏到托盘", "管理窗口隐藏，Agent 继续执行调度和巡检"),
            new(CloseBehavior.ExitAll, "退出全部", "安全停止 Agent 后退出桌面程序"),
        ];
        _closeBehavior = CloseBehaviorOptions[0];
        UpdatePolicyOptions =
        [
            new(UpdatePolicy.NotifyOnly, "仅提醒", "默认；只有点击下载后才获取更新"),
            new(UpdatePolicy.DownloadAndPrompt, "后台下载后提醒", "发现更新后下载，安装仍需确认"),
            new(UpdatePolicy.InstallAtSafePoint, "安全空闲时安装", "下载后等待没有登录窗口和运行任务的安全点"),
        ];
        _updatePolicy = UpdatePolicyOptions[0];

        CheckUpdateCommand = new AsyncRelayCommand(CheckUpdateAsync);
        DownloadUpdateCommand = new AsyncRelayCommand(DownloadUpdateAsync, () => CanDownloadUpdate);
        InstallUpdateCommand = new AsyncRelayCommand(InstallUpdateAsync, () => CanInstallUpdate);
        _updates.Changed += OnUpdateChanged;
    }

    public ObservableCollection<CloseBehaviorOptionViewModel> CloseBehaviorOptions { get; }

    public ObservableCollection<UpdatePolicyOptionViewModel> UpdatePolicyOptions { get; }

    public ICommand CheckUpdateCommand { get; }
    public ICommand DownloadUpdateCommand { get; }
    public ICommand InstallUpdateCommand { get; }

    /// <summary>安装更新前必须先 drain Agent，由 Shell 提供实现。</summary>
    public Func<Task>? InstallRequested { get; set; }

    public CancellationToken Lifetime { get; set; } = CancellationToken.None;

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

    public async Task LoadAsync(CancellationToken cancellationToken)
    {
        var settings = await _store.LoadAsync(cancellationToken);
        _startAtLogin = settings.StartAtLogin;
        _startup.SetEnabled(settings.StartAtLogin);
        OnPropertyChanged(nameof(StartAtLogin));
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
        _loaded = true;
        _updates.Start(settings.UpdatePolicy);
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
                    StartAtLogin = StartAtLogin,
                    CloseBehavior = SelectedCloseBehavior.Value,
                    UpdatePolicy = SelectedUpdatePolicy.Value,
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
        () => InstallRequested?.Invoke() ?? Task.CompletedTask);

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
