using System.Windows.Input;
using Avalonia.Media;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal sealed class OverviewPageViewModel : PageViewModel
{
    private readonly AgentSession _session;
    private readonly AppPaths _paths;
    private readonly DesktopBehaviorViewModel _behavior;
    private bool _schedulerRunning;
    private bool _needsFirstRun;
    private double _migrationProgress;
    private string _migrationStage = "尚未开始迁移";
    private string _connectionStatus = "初始化中";
    private string _connectionDetail = "正在载入桌面设置";
    private string _agentVersion = "—";
    private string _instanceId = "—";
    private string _lastEvent = "尚未收到 Agent 事件";
    private int _accountCount;
    private int _enabledCount;
    private int _loggedInCount;
    private int _needsReauthCount;
    private int _openPageCount;
    private int _activeOperationCount;

    public OverviewPageViewModel(
        AgentSession session,
        AppPaths paths,
        DesktopBehaviorViewModel behavior)
        : base("overview", "⌂", "总览", "连接状态、调度与后台活动")
    {
        _session = session;
        _paths = paths;
        _behavior = behavior;
        StartSchedulerCommand = new AsyncRelayCommand(StartSchedulerAsync);
        StopSchedulerCommand = new AsyncRelayCommand(() => ChangeSchedulerAsync(false));
    }

    public ICommand StartSchedulerCommand { get; }
    public ICommand StopSchedulerCommand { get; }

    /// <summary>首次启动的三个入口由 Shell 提供：导入旧项目、创建新数据、换数据目录。</summary>
    public ICommand? ImportLegacyCommand { get; set; }
    public ICommand? CreateFreshDataCommand { get; set; }
    public ICommand? ChooseDataDirectoryCommand { get; set; }

    public Func<string, Task>? RevealRequested { get; set; }

    /// <summary>手动启动调度时，由主窗口询问是否记住自动启动偏好。</summary>
    public Func<Task<SchedulerStartChoice>>? StartSchedulerPromptRequested { get; set; }

    public string ConnectionStatus
    {
        get => _connectionStatus;
        set => SetProperty(ref _connectionStatus, value);
    }

    public string ConnectionDetail
    {
        get => _connectionDetail;
        set => SetProperty(ref _connectionDetail, value);
    }

    public string AgentVersion
    {
        get => _agentVersion;
        set => SetProperty(ref _agentVersion, value);
    }

    public string InstanceId
    {
        get => _instanceId;
        set => SetProperty(ref _instanceId, value);
    }

    public string LastEvent
    {
        get => _lastEvent;
        set => SetProperty(ref _lastEvent, value);
    }

    public bool SchedulerRunning
    {
        get => _schedulerRunning;
        set
        {
            if (!SetProperty(ref _schedulerRunning, value)) return;
            OnPropertyChanged(nameof(SchedulerStatusText));
            OnPropertyChanged(nameof(SchedulerStatusColor));
        }
    }

    public string SchedulerStatusText => SchedulerRunning ? "运行中" : "已停止";

    public IBrush SchedulerStatusColor => SchedulerRunning ? Palette.Ok : Palette.Muted;

    public bool NeedsFirstRun
    {
        get => _needsFirstRun;
        set => SetProperty(ref _needsFirstRun, value);
    }

    public double MigrationProgress
    {
        get => _migrationProgress;
        set => SetProperty(ref _migrationProgress, value);
    }

    public string MigrationStage
    {
        get => _migrationStage;
        set => SetProperty(ref _migrationStage, value);
    }

    public int AccountCount
    {
        get => _accountCount;
        private set => SetProperty(ref _accountCount, value);
    }

    public int EnabledCount
    {
        get => _enabledCount;
        private set => SetProperty(ref _enabledCount, value);
    }

    public int LoggedInCount
    {
        get => _loggedInCount;
        private set => SetProperty(ref _loggedInCount, value);
    }

    public int NeedsReauthCount
    {
        get => _needsReauthCount;
        private set
        {
            if (SetProperty(ref _needsReauthCount, value)) OnPropertyChanged(nameof(HasNeedsReauth));
        }
    }

    public bool HasNeedsReauth => NeedsReauthCount > 0;

    public int OpenPageCount
    {
        get => _openPageCount;
        private set => SetProperty(ref _openPageCount, value);
    }

    public int ActiveOperationCount
    {
        get => _activeOperationCount;
        private set => SetProperty(ref _activeOperationCount, value);
    }

    public string DataDirectory => _paths.DataDirectory;

    public string AgentLogFile => _paths.AgentLogFile;

    public string RuntimeMode => _paths.IsDevelopment
        ? "开发模式：独立数据目录与 IPC 通道"
        : "安装模式：随应用携带的私有 Agent";

    public void ApplyBootstrap(AgentBootstrapResult bootstrap)
    {
        AccountCount = bootstrap.Accounts.Length;
        EnabledCount = bootstrap.Accounts.Count(account => account.Enabled);
        LoggedInCount = bootstrap.Accounts.Count(account => account.LoggedIn);
        NeedsReauthCount = bootstrap.Accounts.Count(account => account.State == "reauth");
        OpenPageCount = bootstrap.Accounts.Count(account => account.PageOpen);
        ActiveOperationCount = bootstrap.ActiveOperations.Length;
        SchedulerRunning = bootstrap.Scheduler.Running;
        InstanceId = bootstrap.InstanceId;
    }

    public void ApplyActiveOperationCount(int count) => ActiveOperationCount = count;

    internal Task EnsureSchedulerStartedAsync() => SchedulerRunning
        ? Task.CompletedTask
        : ChangeSchedulerAsync(true, "已根据设置自动启动调度");

    internal async Task<bool> ApplySchedulerStartChoiceAsync(SchedulerStartChoice choice)
    {
        if (choice == SchedulerStartChoice.Cancel) return false;
        if (choice == SchedulerStartChoice.Always)
        {
            await _behavior.SetAutoStartSchedulerAsync(true);
        }
        return true;
    }

    private async Task StartSchedulerAsync()
    {
        var choice = SchedulerStartChoice.StartOnce;
        if (!_behavior.AutoStartScheduler && StartSchedulerPromptRequested is not null)
        {
            choice = await StartSchedulerPromptRequested();
        }
        if (!await ApplySchedulerStartChoiceAsync(choice)) return;
        await ChangeSchedulerAsync(true);
    }

    private Task ChangeSchedulerAsync(bool start, string? successMessage = null) => _session.RunAsync(
        start ? "启动调度" : "停止调度",
        async () =>
        {
            var state = await _session.CallAsync(
                start ? "scheduler.start" : "scheduler.stop",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.SchedulerStateDto,
                AgentSession.NewCommandId());
            SchedulerRunning = state.Running;
        },
        successMessage ?? (start
            ? "调度已启动，隐藏到托盘后仍会继续执行"
            : "已请求停止调度，正在运行的账号会先完成本次对话"));
}
