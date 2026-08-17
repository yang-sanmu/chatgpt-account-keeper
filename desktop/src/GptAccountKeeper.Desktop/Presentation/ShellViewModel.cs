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

        Overview = new OverviewPageViewModel(_session, paths);
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
        bool requireDisconnect = false)
    {
        if (!await TryReconnectToAgentAsync()) return;
        _suppressReconnect = true;
        try
        {
            await _connection.CallAsync(
                "system.shutdown",
                new ShutdownParams(reason, Force: force),
                AppJsonContext.Default.ShutdownParams,
                AppJsonContext.Default.AcceptedResult,
                _lifetime.Token,
                AgentSession.NewCommandId());
            try
            {
                await _connection.WaitForDisconnectAsync(TimeSpan.FromSeconds(15), _lifetime.Token);
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

    /// <summary>
    /// “退出全部”和安装更新会先尝试接回已有 Agent，但绝不为了退出而启动新进程。
    /// 数据库存在只说明该目录初始化过，不代表后台 Agent 仍在运行。
    /// </summary>
    private async Task<bool> TryReconnectToAgentAsync()
    {
        if (_connection.IsConnected) return true;

        var snapshot = await _connection.EnsureConnectedAsync(
            startWhenUnavailable: false,
            _lifetime.Token);
        ApplyConnection(snapshot);
        return snapshot.IsConnected;
    }

    public async Task ImportLegacyAsync(string legacyRoot)
    {
        if (File.Exists(_paths.DatabaseFile))
        {
            Toasts.Error("当前数据目录已经初始化，不能覆盖导入；请在首次创建数据库前迁移");
            return;
        }

        await _session.RunAsync("旧数据迁移", async () =>
        {
            Toasts.Info("正在校验旧配置并复制 Profile，请勿启动旧服务或使用相关 Chrome Profile");
            var snapshot = await _connection.StartWithLegacyMigrationAsync(legacyRoot, _lifetime.Token);
            ApplyConnection(snapshot);
            if (!snapshot.IsConnected) return;
            Overview.NeedsFirstRun = false;
            Overview.MigrationProgress = 1;
            await RefreshCoreAsync();
            Toasts.Success($"旧数据迁移完成：{Accounts.SummaryText}；旧目录未被修改，调度保持停止");
        });
    }

    public async Task<LegacyMigrationProbeResult> InspectLegacyAsync(string selectedRoot)
    {
        Overview.MigrationStage = "正在只读扫描旧项目；Profile 较大时可能需要几十秒";
        var preview = await _connection.InspectLegacyAsync(selectedRoot, _lifetime.Token);
        Overview.MigrationStage = preview.Ok
            ? $"扫描完成：{preview.Counts.Accounts} 个账号，{preview.Counts.Profiles} 个 Profile"
            : $"扫描失败 [{preview.Error?.Code}]：{preview.Error?.Message}";
        return preview;
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

    private async Task InstallUpdateAsync()
    {
        await _session.RunAsync("准备安装更新", async () =>
        {
            var prepare = await _connection.CallAsync(
                "system.prepareUpdate",
                new PrepareUpdateParams(true, "desktop-update"),
                AppJsonContext.Default.PrepareUpdateParams,
                AppJsonContext.Default.PrepareUpdateResult,
                _lifetime.Token,
                AgentSession.NewCommandId());
            if (!prepare.Ready)
            {
                var blockers = string.Join("、", prepare.Blockers.Select(item => item.ResourceId ?? item.Kind));
                throw new InvalidOperationException($"仍有阻塞项：{blockers}");
            }

            // 安装更新仍必须坚持安全点语义：不绕过阻塞，也必须确认旧 Agent
            // 已彻底退出后才能替换文件。这里只放宽用户主动“退出全部”。
            await ShutdownAgentAsync("desktop-update", force: false, requireDisconnect: true);
            await Behavior.ApplyAndRestartAsync();
            ApplicationExitRequested?.Invoke(this, EventArgs.Empty);
        });
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
