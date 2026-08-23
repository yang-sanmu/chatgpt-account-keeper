using System.Collections.ObjectModel;
using System.Windows.Input;
using Avalonia.Media;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

/// <summary>
/// 活动 Chrome 明细的一行。DTO 本身是不可变快照，所以「按 run 精确关闭」的命令挂在
/// 这个包装上，而不是给 DTO 加行为——按钮要传的是 browserRunId，不是列表索引。
/// </summary>
internal sealed class BrowserRunRowViewModel : ObservableObject
{
    private BrowserRunDto _run;

    public BrowserRunRowViewModel(BrowserRunDto run, Func<string, Task> close)
    {
        _run = run;
        CloseCommand = new AsyncRelayCommand(() => close(run.BrowserRunId));
    }

    public ICommand CloseCommand { get; }

    public BrowserRunDto Run
    {
        get => _run;
        set
        {
            if (!SetProperty(ref _run, value)) return;
            OnPropertyChanged(nameof(AccountId));
            OnPropertyChanged(nameof(PurposeText));
            OnPropertyChanged(nameof(SourceText));
            OnPropertyChanged(nameof(StateText));
            OnPropertyChanged(nameof(StateColor));
            OnPropertyChanged(nameof(NeedsAttention));
            OnPropertyChanged(nameof(RuntimeText));
            OnPropertyChanged(nameof(DetailText));
            OnPropertyChanged(nameof(RootPidText));
            OnPropertyChanged(nameof(CloseButtonText));
        }
    }

    public string BrowserRunId => _run.BrowserRunId;
    public string AccountId => _run.AccountId;
    public string PurposeText => _run.PurposeText;
    public string SourceText => _run.SourceText;
    public string StateText => _run.StateText;
    public IBrush StateColor => _run.StateColor;
    public bool NeedsAttention => _run.NeedsAttention;
    public string RuntimeText => _run.RuntimeText;
    public string DetailText => _run.DetailText;

    public string RootPidText => _run.RootPid is { } pid ? $"PID {pid}" : "PID —";

    /// <summary>close_failed 的语义是复验，不是「从列表里删掉」。</summary>
    public string CloseButtonText => _run.NeedsAttention ? "重试回收" : "关闭";
}

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
        RefreshRunsCommand = new AsyncRelayCommand(
            () => RefreshRunsRequested?.Invoke() ?? Task.CompletedTask);
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

    // ---- 队列与 Chrome 可观察状态（计划 §15）----
    // 目的很具体：当后台活动任务显示为 0 时，仍存在的项目 Chrome 必须能在明细里
    // 找到对应记录，用户才能定位卡顿而不是面对一个自相矛盾的界面。

    private int _queuedCount;
    private int _runningCount;
    private int _closingCount;
    private string _chromeUsage = "0 / 4";
    private string _workSlotUsage = "0 / 4";
    private int _waitingWorkSlot;
    private int _waitingAccount;
    private int _waitingChrome;
    private int _quarantinedCount;
    private int _longLivedPageCount;
    private bool _brokerRunning = true;

    public int QueuedCount
    {
        get => _queuedCount;
        private set => SetProperty(ref _queuedCount, value);
    }

    public int RunningCount
    {
        get => _runningCount;
        private set => SetProperty(ref _runningCount, value);
    }

    public int ClosingCount
    {
        get => _closingCount;
        private set => SetProperty(ref _closingCount, value);
    }

    /// <summary>形如 “3 / 4”。分母占用含长期页面与未回收的僵尸。</summary>
    public string ChromeUsage
    {
        get => _chromeUsage;
        private set => SetProperty(ref _chromeUsage, value);
    }

    public string WorkSlotUsage
    {
        get => _workSlotUsage;
        private set => SetProperty(ref _workSlotUsage, value);
    }

    public int WaitingWorkSlotCount
    {
        get => _waitingWorkSlot;
        private set => SetProperty(ref _waitingWorkSlot, value);
    }

    public int WaitingAccountCount
    {
        get => _waitingAccount;
        private set => SetProperty(ref _waitingAccount, value);
    }

    public int WaitingChromeCount
    {
        get => _waitingChrome;
        private set => SetProperty(ref _waitingChrome, value);
    }

    /// <summary>Chrome 未能回收而被隔离的账号数；非 0 时必须显眼。</summary>
    public int QuarantinedCount
    {
        get => _quarantinedCount;
        private set
        {
            if (SetProperty(ref _quarantinedCount, value)) OnPropertyChanged(nameof(HasQuarantined));
        }
    }

    public bool HasQuarantined => QuarantinedCount > 0;

    public bool BrokerRunning
    {
        get => _brokerRunning;
        private set
        {
            if (SetProperty(ref _brokerRunning, value)) OnPropertyChanged(nameof(BrokerStatusText));
        }
    }

    public string BrokerStatusText => BrokerRunning
        ? "Chrome 启动器正常（Agent 级基础设施，恒为 1 个进程）"
        : "Chrome 启动器不可用，无法启动新的 Chrome";

    /// <summary>活动 Chrome 明细。close_failed 也在这里，它仍占用容量。</summary>
    public ObservableCollection<BrowserRunRowViewModel> ActiveRuns { get; } = [];

    public ObservableCollection<QuarantinedAccountDto> QuarantinedAccounts { get; } = [];

    /// <summary>由 Shell 注入：按 run 精确关闭 / 复验，以及只读刷新。</summary>
    public Func<string, Task>? CloseBrowserRunRequested { get; set; }
    public Func<Task>? RefreshRunsRequested { get; set; }

    public ICommand RefreshRunsCommand { get; }

    public bool HasActiveRuns => ActiveRuns.Count > 0;

    /// <summary>长期页面单列，避免与后台任务数量混淆——它计入 Chrome 分母但不是任务。</summary>
    public int LongLivedPageCount
    {
        get => _longLivedPageCount;
        private set => SetProperty(ref _longLivedPageCount, value);
    }

    public string ChromeDetailEmptyText => QueuedCount + RunningCount + ClosingCount > 0
        ? "任务正在等待资源，尚未启动 Chrome"
        : "当前没有运行中的 Chrome";

    public void ApplyQueueSnapshot(QueueSnapshotDto snapshot)
    {
        QueuedCount = snapshot.QueuedTotal;
        RunningCount = snapshot.Running;
        ClosingCount = snapshot.Closing;
        WorkSlotUsage = snapshot.WorkSlots.Text;
        ChromeUsage = snapshot.ChromeSlots.Text;
        WaitingWorkSlotCount = snapshot.Waiting.WorkSlot;
        WaitingAccountCount = snapshot.Waiting.Account;
        WaitingChromeCount = snapshot.Waiting.Chrome;
        // broker 缺失时 Windows Agent 会 fail-closed，所以运行中的 Agent 报告 null
        // 只可能是非 Windows 开发路径，按正常处理。
        BrokerRunning = snapshot.Broker?.Running ?? true;
        OnPropertyChanged(nameof(ChromeDetailEmptyText));
    }

    public void ApplyBrowserRuns(BrowserRunListDto runs)
    {
        QuarantinedCount = runs.Quarantined.Length;
        LongLivedPageCount = runs.Active.Count(run => run.Purpose == "open-page");

        // 未能回收的排在最前：它是用户唯一需要动手的一类。
        var ordered = runs.Active
            .OrderByDescending(run => run.NeedsAttention)
            .ThenBy(run => run.StartedAt ?? DateTimeOffset.MaxValue)
            .ToList();
        // 增量同步：明细每次 browserRun.changed 都会刷新，整表重建会让滚动位置回顶。
        var existing = ActiveRuns.ToDictionary(row => row.BrowserRunId, StringComparer.Ordinal);
        var rows = ordered
            .Select(run =>
            {
                if (!existing.TryGetValue(run.BrowserRunId, out var row))
                {
                    return new BrowserRunRowViewModel(run, CloseRunAsync);
                }
                row.Run = run;
                return row;
            })
            .ToList();
        CollectionSync.Apply(
            ActiveRuns,
            rows,
            row => row.BrowserRunId,
            static (left, right) => ReferenceEquals(left, right));
        CollectionSync.Apply(
            QuarantinedAccounts,
            runs.Quarantined,
            item => item.AccountId,
            static (left, right) => left.Reason == right.Reason);
        OnPropertyChanged(nameof(HasActiveRuns));
    }

    private Task CloseRunAsync(string browserRunId) =>
        CloseBrowserRunRequested?.Invoke(browserRunId) ?? Task.CompletedTask;

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
