using System.Collections.ObjectModel;
using System.Reflection;
using System.Text.Json;
using System.Windows.Input;
using Avalonia.Media;
using Avalonia.Threading;
using GptAccountKeeper.Desktop.Infrastructure.Agent;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Infrastructure.Updates;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Presentation.Pages;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation;

/// <summary>
/// 外壳：导航、连接生命周期、事件分派。
///
/// 取代原来 2081 行的单一 MainWindowViewModel。关键差别有两点：
///
/// 1. 每个页面是独立 ViewModel + 独立 UserControl，各自一个 ScrollViewer；
///    不再是八页共用一个 StackPanel 靠 IsVisible 切换（那样会造成嵌套滚动、
///    切页不重置滚动位置、所有控件常驻绑定）。
/// 2. 事件走增量分派：account.changed 只更新那一行，测速结果只回填那一个节点。
///    之前任何事件都触发一次全量 bootstrap + Clear/Add，会把用户正在编辑的
///    备注和选中项一起冲掉。
/// </summary>
internal sealed class ShellViewModel : ObservableObject
{
    private readonly AgentConnectionService _connection;
    private readonly DataLocationService _dataLocation;
    private readonly AppPaths _paths;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly AgentSession _session;
    private PageViewModel _selectedPage;
    private int _refreshQueued;
    private int _reconnectQueued;
    private int _safeInstallLoop;
    private bool _suppressReconnect;
    private bool _initialized;
    private bool _isAgentConnected;
    private bool _schedulerLaunchPreferenceEvaluated;

    public ShellViewModel(
        AgentConnectionService connection,
        DesktopSettingsStore settingsStore,
        DataLocationService dataLocation,
        StartupRegistrationService startupRegistration,
        UpdateService updates,
        AppPaths paths)
    {
        _connection = connection;
        _dataLocation = dataLocation;
        _paths = paths;

        Toasts = new ToastHost();
        _session = new AgentSession(connection, Toasts)
        {
            Lifetime = _lifetime.Token,
            RequestRefresh = RefreshAsync,
        };
        Behavior = new DesktopBehaviorViewModel(settingsStore, startupRegistration, updates, Toasts)
        {
            Lifetime = _lifetime.Token,
            InstallRequested = InstallUpdateAsync,
        };

        Overview = new OverviewPageViewModel(_session, paths, Behavior);
        Accounts = new AccountsPageViewModel(_session);
        Operations = new OperationsPageViewModel(_session);
        Proxies = new ProxiesPageViewModel(_session);
        Conversations = new ConversationsPageViewModel(_session);
        Profiles = new ProfilesPageViewModel(_session);
        History = new HistoryPageViewModel(_session);
        Settings = new SettingsPageViewModel(_session, paths) { Behavior = Behavior };

        Pages =
        [
            Overview,
            Accounts,
            Operations,
            Proxies,
            Conversations,
            Profiles,
            History,
            Settings,
        ];
        _selectedPage = Overview;

        ConnectAgentCommand = new AsyncRelayCommand(
            () => ConnectAsync(false),
            () => !IsAgentConnected);
        StartAgentCommand = new AsyncRelayCommand(
            () => ConnectAsync(true),
            () => !IsAgentConnected);
        RefreshDataCommand = new AsyncRelayCommand(RefreshAsync);
        ImportLegacyCommand = new AsyncRelayCommand(RequestLegacyImportAsync);
        ChooseDataDirectoryCommand = new AsyncRelayCommand(RequestDataDirectoryAsync);
        Settings.ImportLegacyCommand = ImportLegacyCommand;

        Overview.ImportLegacyCommand = ImportLegacyCommand;
        Overview.CreateFreshDataCommand = StartAgentCommand;
        Overview.ChooseDataDirectoryCommand = ChooseDataDirectoryCommand;
        Accounts.HistoryRequested = ShowHistoryForAccountAsync;

        Overview.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName is nameof(Overview.SchedulerRunning) or nameof(Overview.SchedulerStatusText) or nameof(Overview.SchedulerStatusColor) or null)
            {
                OnPropertyChanged(nameof(SchedulerRunning));
                OnPropertyChanged(nameof(SchedulerStatusText));
                OnPropertyChanged(nameof(SchedulerStatusColor));
                OnPropertyChanged(nameof(SchedulerActionText));
            }
        };

        ToggleSchedulerCommand = new AsyncRelayCommand(() =>
        {
            if (Overview.SchedulerRunning)
            {
                Overview.StopSchedulerCommand.Execute(null);
            }
            else
            {
                Overview.StartSchedulerCommand.Execute(null);
            }
            return Task.CompletedTask;
        });

        _connection.ConnectionChanged += OnConnectionChanged;
        _connection.EventReceived += OnAgentEvent;
        _connection.MigrationProgressChanged += OnMigrationProgress;
        _connection.ResynchronizationRequired += OnResynchronizationRequired;
    }

    public bool SchedulerRunning => Overview.SchedulerRunning;
    public string SchedulerStatusText => Overview.SchedulerStatusText;
    public IBrush SchedulerStatusColor => Overview.SchedulerStatusColor;
    public string SchedulerActionText => SchedulerRunning ? "停止调度" : "启动调度";
    public ICommand ToggleSchedulerCommand { get; }

    public string DesktopVersion { get; } = ResolveDesktopVersion();

    public ObservableCollection<PageViewModel> Pages { get; }

    public ToastHost Toasts { get; }

    public DesktopBehaviorViewModel Behavior { get; }

    public OverviewPageViewModel Overview { get; }
    public AccountsPageViewModel Accounts { get; }
    public OperationsPageViewModel Operations { get; }
    public ProxiesPageViewModel Proxies { get; }
    public ConversationsPageViewModel Conversations { get; }
    public ProfilesPageViewModel Profiles { get; }
    public HistoryPageViewModel History { get; }
    public SettingsPageViewModel Settings { get; }

    public ICommand ConnectAgentCommand { get; }
    public ICommand StartAgentCommand { get; }
    public ICommand RefreshDataCommand { get; }
    public ICommand ImportLegacyCommand { get; }
    public ICommand ChooseDataDirectoryCommand { get; }

    public event EventHandler? ApplicationExitRequested;

    public event EventHandler? LegacyFolderRequested;

    public event EventHandler? DataFolderRequested;

    public event EventHandler? DataDirectoryRestartRequested;

    /// <summary>重启后需要继续执行的旧项目导入；窗口据此重新走预检+确认流程。</summary>
    public event EventHandler<string>? LegacyImportResumeRequested;

    /// <summary>切页时重置滚动位置由视图处理；这里只负责通知。</summary>
    public event EventHandler<PageViewModel>? PageChanged;

    public PageViewModel SelectedPage
    {
        get => _selectedPage;
        set
        {
            if (value is null || !SetProperty(ref _selectedPage, value)) return;
            PageChanged?.Invoke(this, value);
            _ = value.ActivateAsync();
        }
    }

    public AgentSession Session => _session;

    public bool IsBusy => _session.IsBusy;

    public bool IsAgentConnected => _isAgentConnected;

    public IBrush AgentConnectionStatusColor => IsAgentConnected ? Palette.Ok : Palette.Muted;

    internal bool IsSafeInstallMonitorRunning => Volatile.Read(ref _safeInstallLoop) != 0;

    public string AgentActionText => IsAgentConnected ? "Agent 已连接" : "启动 Agent";

    public string Endpoint => _connection.Endpoint.DisplayName;

    public string RuntimeMode => Overview.RuntimeMode;

    public CancellationToken Lifetime => _lifetime.Token;

    public async Task InitializeAsync()
    {
        if (_initialized) return;
        _initialized = true;
        try
        {
            await Behavior.LoadAsync(_lifetime.Token);
            // 重启前安排的导入任务在这里接着做：新数据目录此时尚未建库，
            // 走的仍然是首次启动那条经过校验的迁移路径。
            var pendingImport = Behavior.PendingLegacyImportRoot;
            if (!string.IsNullOrWhiteSpace(pendingImport))
            {
                await Behavior.RememberPendingLegacyImportAsync(null);
                if (File.Exists(_paths.DatabaseFile))
                {
                    Toasts.Error("待导入的数据目录已经建库，已取消这次导入以避免覆盖数据");
                }
                else if (!Directory.Exists(pendingImport))
                {
                    Toasts.Error($"待导入的旧项目目录已不存在：{pendingImport}");
                }
                else
                {
                    Overview.NeedsFirstRun = true;
                    Overview.ConnectionStatus = "继续导入旧项目";
                    Overview.ConnectionDetail = $"已切换到新数据目录，正在继续导入：{pendingImport}";
                    if (!string.IsNullOrWhiteSpace(_paths.BootstrapWarning))
                    {
                        Toasts.Error(_paths.BootstrapWarning);
                    }
                    LegacyImportResumeRequested?.Invoke(this, pendingImport);
                    return;
                }
            }
            if (File.Exists(_paths.DatabaseFile))
            {
                Overview.NeedsFirstRun = false;
                // 打开一个已初始化的管理端总是需要它本机的 Agent；
                // 这与"开机自启"是两件独立的事。
                await ConnectAsync(true);
            }
            else
            {
                Overview.NeedsFirstRun = true;
                Overview.ConnectionStatus = "首次启动";
                Overview.ConnectionDetail = "可创建全新数据，或先选择旧项目目录无损导入账号、Profile 与历史";
                Toasts.Info("旧数据只会被复制；迁移失败不会修改旧项目");
            }
            if (!string.IsNullOrWhiteSpace(_paths.BootstrapWarning))
            {
                Toasts.Error(_paths.BootstrapWarning);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            Overview.ConnectionStatus = "初始化失败";
            Overview.ConnectionDetail = exception.Message;
            Toasts.Error($"初始化失败：{exception.Message}");
        }
    }

    public void Stop() => _lifetime.Cancel();

    internal static bool ShouldStartSchedulerOnLaunch(
        bool enabled,
        bool agentConnected,
        bool schedulerRunning) => enabled && agentConnected && !schedulerRunning;

    public async Task<AgentActivityResult?> GetActivityAsync()
    {
        if (!await TryReconnectToAgentAsync()) return null;
        return await _connection.CallAsync(
            "system.getActivity",
            new EmptyParams(),
            AppJsonContext.Default.EmptyParams,
            AppJsonContext.Default.AgentActivityResult,
            _lifetime.Token);
    }

    public async Task ShutdownAgentAsync(
        string reason = "user-exit-all",
        bool force = true,
        bool requireDisconnect = false,
        CancellationToken cancellationToken = default)
    {
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            _lifetime.Token,
            cancellationToken);
        var operationToken = linkedCancellation.Token;
        if (!await TryReconnectToAgentAsync(operationToken)) return;
        var agentProcessId = ReadAgentProcessId();
        _suppressReconnect = true;
        try
        {
            await _connection.CallAsync(
                "system.shutdown",
                new ShutdownParams(reason, Force: force),
                AppJsonContext.Default.ShutdownParams,
                AppJsonContext.Default.AcceptedResult,
                operationToken,
                AgentSession.NewCommandId());
            try
            {
                await _connection.WaitForDisconnectAsync(TimeSpan.FromSeconds(15), operationToken);
                if (requireDisconnect)
                {
                    await WaitForAgentProcessExitAsync(
                        agentProcessId,
                        TimeSpan.FromSeconds(15),
                        operationToken);
                }
            }
            catch (TimeoutException) when (!requireDisconnect)
            {
                // Agent 已确认接管退出；不能因为第三方浏览器驱动迟迟不释放句柄，
                // 再把桌面窗口锁成“永远关不上”。Agent 自身有有界清理与最终退出保障。
            }
        }
        catch
        {
            _suppressReconnect = false;
            throw;
        }
    }

    private int? ReadAgentProcessId()
    {
        try
        {
            using var document = JsonDocument.Parse(
                File.ReadAllText(Path.Combine(_paths.DataDirectory, "agent.lock")));
            return document.RootElement.TryGetProperty("pid", out var pid)
                && pid.TryGetInt32(out var value)
                && value > 0
                    ? value
                    : null;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private async Task WaitForAgentProcessExitAsync(
        int? processId,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (processId is not int pid)
        {
            // The IPC endpoint is already gone. Give shutdown's final repository/lock
            // cleanup one scheduler turn when an old or damaged diagnostic lock has no PID.
            await Task.Delay(100, cancellationToken);
            return;
        }

        var deadline = DateTime.UtcNow + timeout;
        while (AgentConnectionService.IsProcessAlive(pid) && DateTime.UtcNow < deadline)
        {
            await Task.Delay(50, cancellationToken);
        }
        if (AgentConnectionService.IsProcessAlive(pid))
        {
            throw new TimeoutException("Agent 未能在限定时间内释放数据目录");
        }
    }

    /// <summary>
    /// “退出全部”和安装更新会先尝试接回已有 Agent，但绝不为了退出而启动新进程。
    /// 数据库存在只说明该目录初始化过，不代表后台 Agent 仍在运行。
    /// </summary>
    private async Task<bool> TryReconnectToAgentAsync(CancellationToken cancellationToken = default)
    {
        if (_connection.IsConnected) return true;

        var operationToken = cancellationToken.CanBeCanceled
            ? cancellationToken
            : _lifetime.Token;
        var snapshot = await _connection.EnsureConnectedAsync(
            startWhenUnavailable: false,
            operationToken);
        ApplyConnection(snapshot);
        return snapshot.IsConnected;
    }

    /// <summary>当前数据目录是否已经初始化过。</summary>
    public bool DataDirectoryInitialized => File.Exists(_paths.DatabaseFile);

    /// <summary>
    /// 首次启动之后再导入旧项目。
    ///
    /// 迁移只能写进一个尚未建库的数据目录（它靠"keeper.db 不存在"来保证不覆盖
    /// 任何现有数据），所以这条路径先把新数据目录和待导入的旧项目根一起记下来，
    /// 重启后再由 InitializeAsync 接着做。当前数据目录一个字节都不会被改。
    /// </summary>
    public async Task ScheduleLegacyImportAsync(string legacyRoot, string dataDirectory)
    {
        try
        {
            var target = _dataLocation.Validate(dataDirectory);
            if (File.Exists(Path.Combine(target, "keeper.db")))
            {
                Toasts.Error($"所选目录已存在 keeper.db，不能作为导入目标：{target}");
                return;
            }
            if (PathsEqual(target, _paths.DataDirectory))
            {
                Toasts.Error("导入旧项目需要一个尚未建库的新数据目录，不能沿用当前目录");
                return;
            }

            // 先把旧数据目录的 Agent 停掉，之后才写任何配置。
            // IPC 端点按数据目录隔离，如果放着不管，重启后的新实例会另起一个
            // Agent，而旧 Agent 仍在后台对着旧数据目录跑调度和巡检。
            // 用非强制停止：有任务在跑时它会被拒绝，那时本来也不该换数据目录。
            if (_connection.IsConnected)
            {
                await ShutdownAgentAsync("data-directory-change", force: false, requireDisconnect: true);
            }

            await Behavior.RememberPendingLegacyImportAsync(legacyRoot);
            await _dataLocation.SaveAsync(target, _lifetime.Token);
            Toasts.Success($"已记录导入任务，正在重启到新数据目录：{target}");
            DataDirectoryRestartRequested?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Toasts.Error($"安排旧项目导入失败：{exception.Message}");
        }
    }

    public async Task<bool> ImportLegacyAsync(string legacyRoot)
    {
        var databaseExisted = File.Exists(_paths.DatabaseFile);
        if (_connection.IsConnected)
        {
            // 迁移发生在 Agent 建立 IPC 之前。先让当前 Agent 完整释放 SQLite、
            // 调度和 Profile 句柄，再用 --legacy-root 在同一数据目录重启。
            await ShutdownAgentAsync("legacy-import", force: false, requireDisconnect: true);
        }

        _suppressReconnect = true;
        var migrated = false;
        try
        {
            migrated = await _session.RunAsync("旧数据迁移", async () =>
            {
                Toasts.Info("正在校验旧配置并复制 Profile，请勿启动旧服务或使用相关 Chrome Profile");
                var snapshot = await _connection.StartWithLegacyMigrationAsync(legacyRoot, _lifetime.Token);
                ApplyConnection(snapshot);
                if (!snapshot.IsConnected)
                {
                    throw new InvalidOperationException(snapshot.Detail);
                }
                Overview.NeedsFirstRun = false;
                Overview.MigrationProgress = 1;
                await RefreshCoreAsync();
                Toasts.Success($"旧数据迁移完成：{Accounts.SummaryText}；旧目录未被修改，调度保持停止");
            }, ensureConnected: false);
        }
        finally
        {
            _suppressReconnect = false;
        }

        // 非空库会被迁移层拒绝。恢复原 Agent，避免一次被拒绝的导入让管理端
        // 留在离线状态；窗口随后仍可让用户改选一个新的空数据目录。
        if (!migrated && databaseExisted && !_connection.IsConnected)
        {
            await ConnectAsync(true);
        }
        return migrated;
    }

    public async Task<LegacyMigrationProbeResult> InspectLegacyAsync(
        string selectedRoot,
        CancellationToken cancellationToken = default)
    {
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            _lifetime.Token,
            cancellationToken);
        Overview.MigrationStage = "正在只读扫描旧项目；Profile 较大时可能需要几十秒";
        try
        {
            var preview = await _connection.InspectLegacyAsync(selectedRoot, linkedCancellation.Token);
            Overview.MigrationStage = preview.Ok
                ? $"扫描完成：{preview.Counts.Accounts} 个账号，{preview.Counts.Profiles} 个 Profile"
                : $"扫描失败 [{preview.Error?.Code}]：{preview.Error?.Message}";
            return preview;
        }
        catch (OperationCanceledException)
        {
            Overview.MigrationStage = "旧项目扫描已取消";
            throw;
        }
        catch (Exception exception)
        {
            Overview.MigrationStage = $"扫描失败：{exception.Message}";
            throw;
        }
    }

    public async Task UseDataDirectoryAsync(string directory)
    {
        if (File.Exists(_paths.DatabaseFile) || _connection.IsConnected)
        {
            Toasts.Error("只能在首次创建数据库前选择数据目录");
            return;
        }
        try
        {
            await _dataLocation.SaveAsync(directory, _lifetime.Token);
            Toasts.Success($"新数据目录已保存：{directory}。正在重启桌面程序以应用设置。");
            DataDirectoryRestartRequested?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Toasts.Error($"选择数据目录失败：{exception.Message}");
        }
    }

    public Task ShowHistoryForAccountAsync(string accountId)
    {
        SelectedPage = History;
        return History.ShowAccountAsync(accountId);
    }

    private Task RequestLegacyImportAsync()
    {
        LegacyFolderRequested?.Invoke(this, EventArgs.Empty);
        return Task.CompletedTask;
    }

    private Task RequestDataDirectoryAsync()
    {
        DataFolderRequested?.Invoke(this, EventArgs.Empty);
        return Task.CompletedTask;
    }

    private async Task ConnectAsync(bool startWhenUnavailable)
    {
        try
        {
            if (startWhenUnavailable && _connection.IsConnected)
            {
                ApplyConnection(_connection.Snapshot);
                Toasts.Info("Agent 已连接，无需重复启动");
                return;
            }

            var snapshot = await _connection.EnsureConnectedAsync(startWhenUnavailable, _lifetime.Token);
            ApplyConnection(snapshot);
            if (!snapshot.IsConnected) return;
            Overview.NeedsFirstRun = false;
            await RefreshCoreAsync();
            await ApplySchedulerLaunchPreferenceAsync();
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            Overview.ConnectionStatus = "连接失败";
            Overview.ConnectionDetail = exception.Message;
            Toasts.Error($"连接 Agent 失败：{exception.Message}");
        }
    }

    /// <summary>
    /// 本次桌面进程第一次成功连接 Agent 时应用一次启动偏好。连接失败后仍可在
    /// 用户重试时补做；一旦评估过，后续断线重连不会把手动停止的调度重新拉起。
    /// </summary>
    private async Task ApplySchedulerLaunchPreferenceAsync()
    {
        if (_schedulerLaunchPreferenceEvaluated || !IsAgentConnected) return;
        _schedulerLaunchPreferenceEvaluated = true;
        if (ShouldStartSchedulerOnLaunch(
                Behavior.AutoStartScheduler,
                agentConnected: true,
                Overview.SchedulerRunning))
        {
            await Overview.EnsureSchedulerStartedAsync();
        }
    }

    private async Task RefreshAsync()
    {
        if (!_connection.IsConnected)
        {
            await ConnectAsync(true);
            return;
        }
        await _session.RunAsync("同步数据", RefreshCoreAsync);
    }

    /// <summary>取一次全量快照并分发到各页面。断线重连和事件缺口才走这条路。</summary>
    private async Task RefreshCoreAsync()
    {
        var bootstrap = await _connection.CallAsync(
            "system.bootstrap",
            new EmptyParams(),
            AppJsonContext.Default.EmptyParams,
            AppJsonContext.Default.AgentBootstrapResult,
            _lifetime.Token);

        Accounts.ApplyAccounts(bootstrap.Accounts, bootstrap.Groups);
        Profiles.ApplyAccounts(bootstrap.Accounts);
        Proxies.ApplyState(bootstrap.Proxies, bootstrap.Groups, bootstrap.Accounts);
        Conversations.Apply(bootstrap.Conversations);
        History.ApplyAccounts(bootstrap.HistoryAccounts);
        Operations.ApplySnapshot(bootstrap.Operations);
        Settings.ApplyAgentSettings(bootstrap.Settings);
        Overview.ApplyBootstrap(bootstrap);

        if (bootstrap.Draining)
        {
            Toasts.Info("Agent 正在安全排空，暂不接受新的写操作");
        }
    }

    internal void ApplyConnection(AgentConnectionSnapshot snapshot)
    {
        Overview.ConnectionStatus = snapshot.Status;
        Overview.ConnectionDetail = snapshot.Detail;
        Overview.AgentVersion = snapshot.AgentVersion ?? "—";
        Overview.InstanceId = snapshot.InstanceId ?? "—";
        if (_isAgentConnected == snapshot.IsConnected) return;
        _isAgentConnected = snapshot.IsConnected;
        OnPropertyChanged(nameof(IsAgentConnected));
        OnPropertyChanged(nameof(AgentConnectionStatusColor));
        OnPropertyChanged(nameof(AgentActionText));
        (ConnectAgentCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (StartAgentCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static string ResolveDesktopVersion()
    {
        var assembly = typeof(ShellViewModel).Assembly;
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrWhiteSpace(version))
        {
            version = assembly.GetName().Version?.ToString(3) ?? "未知版本";
        }

        var metadataSeparator = version.IndexOf('+', StringComparison.Ordinal);
        if (metadataSeparator >= 0)
        {
            version = version[..metadataSeparator];
        }

        return $"v{version} · AOT";
    }

    private void OnConnectionChanged(object? sender, AgentConnectionSnapshot snapshot)
    {
        Dispatcher.UIThread.Post(() => ApplyConnection(snapshot));
        if (!snapshot.IsConnected && !_suppressReconnect && File.Exists(_paths.DatabaseFile))
        {
            QueueReconnect();
        }
    }

    private void OnResynchronizationRequired(object? sender, EventArgs e)
    {
        Dispatcher.UIThread.Post(() =>
        {
            Toasts.Info("检测到 Agent 事件序号缺口，正在重新获取完整快照");
            QueueRefresh();
        });
    }

    /// <summary>
    /// 事件分派。能增量应用的一律增量应用，只有真的拿不到足够信息时才排一次全量同步。
    /// </summary>
    private void OnAgentEvent(object? sender, AgentEvent agentEvent)
    {
        Dispatcher.UIThread.Post(() =>
        {
            var time = agentEvent.OccurredAt?.ToLocalTime().ToString("HH:mm:ss") ?? "刚刚";
            Overview.LastEvent = $"{time} · {agentEvent.Name}";
            try
            {
                if (ApplyEventIncrementally(agentEvent)) return;
            }
            catch (JsonException exception)
            {
                Toasts.Error($"事件解析失败（{agentEvent.Name}）：{exception.Message}");
            }
            QueueRefresh();
        });
    }

    private bool ApplyEventIncrementally(AgentEvent agentEvent)
    {
        switch (agentEvent.Name)
        {
            case "operation.changed":
                {
                    var operation = agentEvent.Payload.Deserialize(AppJsonContext.Default.AgentOperationDto);
                    if (operation is null) return false;
                    Operations.Upsert(operation);
                    Overview.ApplyActiveOperationCount(
                        Operations.Items.Count(item => !item.IsTerminal));
                    if (operation.State == "failed" || operation.State == "timed_out")
                    {
                        Toasts.Error($"{operation.KindText}{operation.StateText}：{operation.DetailText}");
                    }
                    // profile-scan 的结果就是扫描数据本身，直接喂给 Profile 页。
                    if (operation.Kind == "profile-scan" && operation.State == "succeeded")
                    {
                        Profiles.ApplyScan(operation.Result);
                        return true;
                    }
                    // 其它 Profile 操作改变了磁盘状态，需要重新扫描才知道新占用。
                    if (operation.State == "succeeded"
                        && operation.Kind.StartsWith("profile-", StringComparison.Ordinal))
                    {
                        Profiles.ScanCommand.Execute(null);
                    }
                    return true;
                }

            case "account.changed":
                {
                    var account = agentEvent.Payload.Deserialize(AppJsonContext.Default.AccountDto);
                    if (account is null) return false;
                    Profiles.ApplyAccount(account);
                    // 新建的账号还不在列表里：这时才需要一次全量同步。
                    return Accounts.ApplyAccount(account);
                }

            case "accountStatus.changed":
                {
                    // 状态事件只带状态字段，账号视图还需要出口和轮换信息；
                    // 交给 accounts.list 之外的轻量路径：直接更新那一行的状态部分。
                    var status = agentEvent.Payload.Deserialize(AppJsonContext.Default.AccountStatusEventDto);
                    if (status is null || !Accounts.ApplyStatus(status)) return false;
                    Profiles.ApplyAccountEmail(status.Id, status.Email);
                    return true;
                }

            case "account.removed":
                {
                    var removed = agentEvent.Payload.Deserialize(AppJsonContext.Default.IdParams);
                    return removed is not null && Accounts.RemoveAccount(removed.Id);
                }

            case "openPage.changed":
                {
                    var change = agentEvent.Payload.Deserialize(AppJsonContext.Default.OpenPageChangeDto);
                    if (change is null) return false;
                    return Accounts.ApplyOpenPage(change.AccountId, change.Open);
                }

            case "scheduler.accountChanged":
                {
                    var change = agentEvent.Payload.Deserialize(AppJsonContext.Default.SchedulerAccountChangeDto);
                    return change is not null && Accounts.ApplySchedule(change);
                }

            case "scheduler.changed":
                {
                    var state = agentEvent.Payload.Deserialize(AppJsonContext.Default.SchedulerStateDto);
                    if (state is null) return false;
                    Overview.SchedulerRunning = state.Running;
                    return true;
                }

            case "proxyNode.tested":
                {
                    var tested = agentEvent.Payload.Deserialize(AppJsonContext.Default.ProxyNodeTestedDto);
                    return tested is not null && Proxies.ApplyNodeTest(tested);
                }

            case "history.appended":
                {
                    var appended = agentEvent.Payload.Deserialize(AppJsonContext.Default.HistoryAppendedDto);
                    if (appended is null) return false;
                    // 不在看这个账号时忽略即可；历史列表下次进入自会重新载入。
                    History.ApplyAppended(appended);
                    return true;
                }

            case "agent.draining":
                Toasts.Info("Agent 正在安全排空，暂不接受新的写操作");
                return true;

            case "agent.readyForUpdate":
                Toasts.Info("Agent 已停下所有任务，可以安装更新");
                return true;

            default:
                // group/proxyState/conversation/settings 变化影响整块数据，走全量同步。
                return false;
        }
    }

    private void OnMigrationProgress(object? sender, MigrationProgressDto progress)
    {
        Dispatcher.UIThread.Post(() =>
        {
            Overview.MigrationProgress = Math.Clamp(progress.Progress ?? Overview.MigrationProgress, 0, 1);
            Overview.MigrationStage = progress.Message;
            if (progress.Error is not null)
            {
                Toasts.Error($"旧数据迁移失败 [{progress.Error.Code}]：{progress.Error.Message}；日志：{_paths.AgentLogFile}");
            }
        });
    }

    private void QueueRefresh()
    {
        if (Interlocked.Exchange(ref _refreshQueued, 1) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                // 合并短时间内的多条事件，避免一批账号同时变化时刷十几次。
                await Task.Delay(250, _lifetime.Token);
                await Dispatcher.UIThread.InvokeAsync(RefreshAsync);
            }
            catch (OperationCanceledException)
            {
            }
            finally
            {
                Interlocked.Exchange(ref _refreshQueued, 0);
            }
        });
    }

    private void QueueReconnect()
    {
        if (Interlocked.Exchange(ref _reconnectQueued, 1) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                foreach (var delay in new[] { 1, 2, 5, 10, 20, 30 })
                {
                    await Task.Delay(TimeSpan.FromSeconds(delay), _lifetime.Token);
                    if (_connection.IsConnected || _suppressReconnect) return;
                    await Dispatcher.UIThread.InvokeAsync(() => ConnectAsync(true));
                    if (_connection.IsConnected) return;
                }
            }
            catch (OperationCanceledException)
            {
            }
            finally
            {
                Interlocked.Exchange(ref _reconnectQueued, 0);
            }
        });
    }

    private Task InstallUpdateAsync() => InstallUpdateAsync(_lifetime.Token, null);

    private async Task InstallUpdateAsync(
        CancellationToken cancellationToken,
        IProgress<UpdateExecutionProgress>? progress)
    {
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            _lifetime.Token,
            cancellationToken);
        var operationToken = linkedCancellation.Token;

        progress?.Report(new UpdateExecutionProgress(
            "正在连接 Agent…",
            "正在确认本地 Agent 可响应更新安全检查。",
            Percent: null,
            CanCancel: true));
        var connection = await _connection.EnsureConnectedAsync(
            startWhenUnavailable: true,
            operationToken);
        ApplyConnection(connection);
        if (!connection.IsConnected)
        {
            throw new InvalidOperationException(connection.Detail);
        }

        progress?.Report(new UpdateExecutionProgress(
            "正在检查安装条件…",
            "正在检查 Chrome 窗口、运行任务和数据目录状态；此阶段可以取消。",
            Percent: null,
            CanCancel: true));
        var preflight = await _connection.CallAsync(
            "system.prepareUpdate",
            new PrepareUpdateParams(false, "desktop-update"),
            AppJsonContext.Default.PrepareUpdateParams,
            AppJsonContext.Default.PrepareUpdateResult,
            operationToken,
            AgentSession.NewCommandId());
        if (!preflight.Ready)
        {
            var blockers = string.Join("、", preflight.Blockers.Select(item => item.ResourceId ?? item.Kind));
            throw new InvalidOperationException($"仍有阻塞项：{blockers}");
        }

        operationToken.ThrowIfCancellationRequested();
        progress?.Report(new UpdateExecutionProgress(
            "正在安全排空 Agent…",
            "安全检查已通过，正在完成任务收尾和数据库检查点；从此阶段起不可取消。",
            Percent: null,
            CanCancel: false));
        var prepare = await _connection.CallAsync(
            "system.prepareUpdate",
            new PrepareUpdateParams(true, "desktop-update"),
            AppJsonContext.Default.PrepareUpdateParams,
            AppJsonContext.Default.PrepareUpdateResult,
            _lifetime.Token,
            AgentSession.NewCommandId());
        if (!prepare.Ready || !prepare.Committed)
        {
            var blockers = string.Join("、", prepare.Blockers.Select(item => item.ResourceId ?? item.Kind));
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(blockers)
                ? "Agent 未能进入更新排空状态"
                : $"仍有阻塞项：{blockers}");
        }

        // 提交排空后不再接受用户取消：Agent 已进入拒绝写入状态，必须完成退出，
        // 否则会把本次会话留在无法继续工作的半停机状态。
        progress?.Report(new UpdateExecutionProgress(
            "正在关闭 Agent…",
            "正在等待 Agent 完整释放数据库和 Profile 句柄。",
            Percent: null,
            CanCancel: false));
        await ShutdownAgentAsync(
            "desktop-update",
            force: false,
            requireDisconnect: true,
            cancellationToken: _lifetime.Token);
        progress?.Report(new UpdateExecutionProgress(
            "正在应用更新并重启…",
            "更新程序已经接管，ChatGPT Account Keeper 即将重新启动。",
            Percent: null,
            CanCancel: false));
        await Behavior.ApplyAndRestartAsync();
        ApplicationExitRequested?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>“安全空闲时安装”：等到没有登录窗口、打开网页和运行任务时才装。</summary>
    public void StartSafeInstallMonitor()
    {
        if (Interlocked.Exchange(ref _safeInstallLoop, 1) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                // 更新通常要在窗口打开 30 秒后才检查完成。监控必须持续存活，不能因为
                // 启动时尚无可安装版本就退出；下载完成后下一轮会立即进入安全点判断。
                while (!_lifetime.IsCancellationRequested)
                {
                    if (Behavior.CanInstallUpdate && Behavior.WantsSafePointInstall)
                    {
                        var activity = await GetActivityAsync();
                        if (activity is not null && activity.Blockers.Length == 0)
                        {
                            await Dispatcher.UIThread.InvokeAsync(InstallUpdateAsync);
                            return;
                        }
                    }
                    await Task.Delay(TimeSpan.FromSeconds(30), _lifetime.Token);
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception exception)
            {
                Dispatcher.UIThread.Post(() => Toasts.Error($"安全空闲安装失败：{exception.Message}"));
            }
            finally
            {
                Interlocked.Exchange(ref _safeInstallLoop, 0);
            }
        });
    }
}
