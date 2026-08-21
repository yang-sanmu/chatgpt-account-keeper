using System.ComponentModel;
using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

/// <summary>状态筛选项。值是枚举而不是中文字符串，改文案不会静默失效。</summary>
internal enum AccountStatusFilter
{
    All,
    Enabled,
    Disabled,
    LoggedIn,
    LoggedOut,
    NeedsReauth,
    PageOpen,
    Abnormal,
    PendingEdits,
}

internal sealed record AccountStatusFilterOption(AccountStatusFilter Value, string Title)
{
    public static readonly IReadOnlyList<AccountStatusFilterOption> All =
    [
        new(AccountStatusFilter.All, "全部状态"),
        new(AccountStatusFilter.Enabled, "已启用"),
        new(AccountStatusFilter.Disabled, "已停用"),
        new(AccountStatusFilter.LoggedIn, "已登录"),
        new(AccountStatusFilter.LoggedOut, "未登录"),
        new(AccountStatusFilter.NeedsReauth, "需重新登录"),
        new(AccountStatusFilter.PageOpen, "Chrome 已打开"),
        new(AccountStatusFilter.Abnormal, "状态异常"),
        new(AccountStatusFilter.PendingEdits, "有未保存修改"),
    ];
}

internal sealed class AccountsPageViewModel : PageViewModel
{
    private readonly AgentSession _session;
    private readonly List<AccountRowViewModel> _all = [];
    private string _search = string.Empty;
    private AccountStatusFilterOption _statusFilter = AccountStatusFilterOption.All[0];
    private RouteChoiceViewModel _groupFilter;
    private string _newAccountNote = string.Empty;
    private RouteChoiceViewModel? _newAccountGroup;
    private bool _applyingAccounts;

    public AccountsPageViewModel(AgentSession session)
        : base("accounts", "◉", "账号", "登录、状态、自动对话与真实 Chrome")
    {
        _session = session;
        GroupChoices.Add(new RouteChoiceViewModel(null, "不分组 / 系统网络"));
        GroupFilterChoices.Add(new RouteChoiceViewModel(null, "全部分组"));
        _groupFilter = GroupFilterChoices[0];
        _newAccountGroup = GroupChoices[0];

        CreateAccountCommand = new AsyncRelayCommand(CreateAccountAsync);
        SaveAllEditsCommand = new AsyncRelayCommand(SaveAllEditsAsync, () => PendingEditCount > 0);
        RevertAllEditsCommand = new AsyncRelayCommand(RevertAllEditsAsync, () => PendingEditCount > 0);
        SelectAllCommand = new AsyncRelayCommand(() => SetSelectionAsync(true));
        ClearSelectionCommand = new AsyncRelayCommand(() => SetSelectionAsync(false));
        BatchEnableCommand = new AsyncRelayCommand(() => BatchSetEnabledAsync(true));
        BatchDisableCommand = new AsyncRelayCommand(() => BatchSetEnabledAsync(false));
        BatchRefreshStatusCommand = new AsyncRelayCommand(() => BatchOperationAsync("刷新登录状态", "refresh-status"));
        BatchRunNowCommand = new AsyncRelayCommand(() => BatchOperationAsync("立即运行", "run-now"));
        BatchRemoveCommand = new AsyncRelayCommand(BatchRemoveAsync);
    }

    public ObservableCollection<AccountRowViewModel> Rows { get; } = [];

    public ObservableCollection<RouteChoiceViewModel> GroupChoices { get; } = [];

    public ObservableCollection<RouteChoiceViewModel> GroupFilterChoices { get; } = [];

    public IReadOnlyList<AccountStatusFilterOption> StatusFilters => AccountStatusFilterOption.All;

    public IReadOnlyList<SwitchRuleOption> SwitchRules => SwitchRuleOption.All;

    public ICommand CreateAccountCommand { get; }
    public ICommand SaveAllEditsCommand { get; }
    public ICommand RevertAllEditsCommand { get; }
    public ICommand SelectAllCommand { get; }
    public ICommand ClearSelectionCommand { get; }
    public ICommand BatchEnableCommand { get; }
    public ICommand BatchDisableCommand { get; }
    public ICommand BatchRefreshStatusCommand { get; }
    public ICommand BatchRunNowCommand { get; }
    public ICommand BatchRemoveCommand { get; }

    /// <summary>删除账号需要选择 Profile 处理方式，由窗口提供对话框。</summary>
    public Func<AccountDto, Task<string?>>? AccountRemovalRequested { get; set; }

    /// <summary>“历史”按钮跳转到历史页并定位到该账号。</summary>
    public Func<string, Task>? HistoryRequested { get; set; }

    /// <summary>登录进度窗：登录需要用户在真实 Chrome 里操作，必须有前台反馈。</summary>
    public Func<AccountDto, bool, Task>? LoginRequested { get; set; }

    public string Search
    {
        get => _search;
        set
        {
            if (SetProperty(ref _search, value)) ApplyFilter();
        }
    }

    public AccountStatusFilterOption StatusFilter
    {
        get => _statusFilter;
        set
        {
            if (value is not null && SetProperty(ref _statusFilter, value)) ApplyFilter();
        }
    }

    public RouteChoiceViewModel GroupFilter
    {
        get => _groupFilter;
        set
        {
            if (value is not null && SetProperty(ref _groupFilter, value)) ApplyFilter();
        }
    }

    public string NewAccountNote
    {
        get => _newAccountNote;
        set => SetProperty(ref _newAccountNote, value);
    }

    public RouteChoiceViewModel? NewAccountGroup
    {
        get => _newAccountGroup;
        set => SetProperty(ref _newAccountGroup, value);
    }

    public int SelectedCount => Rows.Count(row => row.IsSelected);

    public bool HasSelection => SelectedCount > 0;

    public int PendingEditCount => _all.Count(row => row.HasPendingEdits);

    public bool HasPendingEdits => PendingEditCount > 0;

    public string PendingEditText => PendingEditCount == 0
        ? "没有未保存的修改"
        : $"{PendingEditCount} 个账号有未保存的修改";

    public string SummaryText =>
        $"共 {_all.Count} 个账号 · {_all.Count(row => row.Enabled)} 个已启用 · "
        + $"{_all.Count(row => row.LoggedIn)} 个已登录 · 显示 {Rows.Count} 个";

    public bool IsEmpty => Rows.Count == 0;

    public string EmptyText => _all.Count == 0
        ? "还没有账号。填写备注后点“新增账号”，创建后再登录。"
        : "没有符合当前搜索和筛选条件的账号。";

    /// <summary>
    /// 应用一次全量账号快照。按 id 增量更新：未变化的行保持同一实例，
    /// 选中项、滚动位置和正在编辑的草稿都不受影响。
    /// </summary>
    public void ApplyAccounts(IReadOnlyList<AccountDto> accounts, IReadOnlyList<GroupDto> groups)
    {
        _applyingAccounts = true;
        try
        {
            SyncGroupChoices(groups);
            var existing = _all.ToDictionary(row => row.Id, StringComparer.Ordinal);
            var next = new List<AccountRowViewModel>(accounts.Count);
            foreach (var account in accounts)
            {
                if (existing.TryGetValue(account.Id, out var row))
                {
                    row.Apply(account);
                    row.UpdateGroupChoices(GroupChoices);
                    next.Add(row);
                }
                else
                {
                    next.Add(CreateRow(account));
                }
            }
            foreach (var removed in existing.Values.Where(row => !next.Contains(row)))
            {
                removed.PropertyChanged -= OnRowPropertyChanged;
            }
            _all.Clear();
            _all.AddRange(next);
        }
        finally
        {
            _applyingAccounts = false;
        }
        ApplyFilter();
    }

    /// <summary>单个账号事件的增量应用，不触发整表重建。</summary>
    public bool ApplyAccount(AccountDto account)
    {
        var row = _all.FirstOrDefault(item => item.Id == account.Id);
        if (row is null) return false;
        row.Apply(account);
        ApplyFilter();
        return true;
    }

    /// <summary>状态事件会改变登录、重登和异常筛选，因此更新后必须重新套用筛选。</summary>
    public bool ApplyStatus(AccountStatusEventDto status)
    {
        var row = _all.FirstOrDefault(item => item.Id == status.Id);
        if (row is null) return false;
        row.Apply(row.Account with
        {
            State = status.State,
            LoggedIn = status.LoggedIn,
            StatusDetail = status.Detail,
            CheckedAt = status.CheckedAt,
            Stale = status.Stale,
            Email = status.Email ?? row.Account.Email,
            LastCheckState = status.LastCheckState,
            LastCheckDetail = status.LastCheckDetail,
            ConfirmedState = status.ConfirmedState,
            ConfirmedAt = status.ConfirmedAt,
        });
        ApplyFilter();
        return true;
    }

    public bool RemoveAccount(string accountId)
    {
        var row = _all.FirstOrDefault(item => item.Id == accountId);
        if (row is null) return false;
        row.PropertyChanged -= OnRowPropertyChanged;
        _all.Remove(row);
        ApplyFilter();
        return true;
    }

    /// <summary>单账号调度变化：只更新那一行的下次/上次时间。</summary>
    public bool ApplySchedule(SchedulerAccountChangeDto change)
    {
        var row = _all.FirstOrDefault(item => item.Id == change.AccountId);
        if (row is null) return false;
        row.Apply(row.Account with
        {
            NextRunAt = change.NextAt,
            LastRunAt = change.LastAt ?? row.Account.LastRunAt,
            Running = change.Busy,
            LastRunOk = change.LastResultState switch
            {
                "succeeded" => true,
                "failed" => false,
                _ => row.Account.LastRunOk,
            },
        });
        return true;
    }

    public bool ApplyOpenPage(string accountId, bool open)
    {
        var row = _all.FirstOrDefault(item => item.Id == accountId);
        if (row is null) return false;
        row.Apply(row.Account with { PageOpen = open });
        ApplyFilter();
        return true;
    }

    private AccountRowViewModel CreateRow(AccountDto account)
    {
        var row = new AccountRowViewModel(
            account,
            GroupChoices,
            SaveRowAsync,
            SetRowEnabledAsync,
            RunRowCommandAsync);
        row.PropertyChanged += OnRowPropertyChanged;
        return row;
    }

    private void OnRowPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_applyingAccounts) return;
        if (e.PropertyName == nameof(AccountRowViewModel.IsSelected))
        {
            RaiseSummary();
            return;
        }
        if (e.PropertyName == nameof(AccountRowViewModel.HasPendingEdits))
        {
            if (StatusFilter.Value == AccountStatusFilter.PendingEdits) ApplyFilter();
            else RaiseSummary();
            return;
        }
        if (Search.Length > 0 && e.PropertyName is nameof(AccountRowViewModel.Note) or nameof(AccountRowViewModel.SelectedGroup))
        {
            ApplyFilter();
        }
    }

    private void SyncGroupChoices(IReadOnlyList<GroupDto> groups)
    {
        var wanted = new List<RouteChoiceViewModel> { new(null, "不分组 / 系统网络") };
        foreach (var group in groups) wanted.Add(new RouteChoiceViewModel(group.Id, group.Name));
        CollectionSync.Apply(
            GroupChoices,
            wanted,
            choice => choice.Id ?? "\u0000none",
            static (left, right) => left.Title == right.Title);

        var filters = new List<RouteChoiceViewModel> { new(null, "全部分组"), new("\u0000ungrouped", "未分组") };
        foreach (var group in groups) filters.Add(new RouteChoiceViewModel(group.Id, group.Name));
        var previousFilter = _groupFilter.Id;
        CollectionSync.Apply(
            GroupFilterChoices,
            filters,
            choice => choice.Id ?? "\u0000all",
            static (left, right) => left.Title == right.Title);
        var restored = GroupFilterChoices.FirstOrDefault(choice => choice.Id == previousFilter)
            ?? GroupFilterChoices[0];
        if (!ReferenceEquals(restored, _groupFilter))
        {
            _groupFilter = restored;
            OnPropertyChanged(nameof(GroupFilter));
        }
        if (NewAccountGroup is null || !GroupChoices.Contains(NewAccountGroup))
        {
            NewAccountGroup = GroupChoices.FirstOrDefault(choice => choice.Id == NewAccountGroup?.Id)
                ?? GroupChoices.FirstOrDefault();
        }
    }

    private void ApplyFilter()
    {
        var query = Search.Trim();
        var filtered = _all.Where(row => MatchesSearch(row, query) && MatchesStatus(row) && MatchesGroup(row)).ToList();
        CollectionSync.Apply(Rows, filtered, row => row.Id, static (left, right) => ReferenceEquals(left, right));
        RaiseSummary();
    }

    private bool MatchesSearch(AccountRowViewModel row, string query)
    {
        if (query.Length == 0) return true;
        var account = row.Account;
        return Contains(account.Id, query)
            || Contains(account.Email, query)
            || Contains(account.GptName, query)
            || Contains(row.Note, query)
            // 分组名从本地分组表解析，不依赖 Agent 是否在账号上带了 groupName：
            // 用户记得的是"美国组"而不是 g1。
            || Contains(row.SelectedGroup?.Title, query)
            || Contains(account.GroupName, query);
    }

    private static bool Contains(string? value, string query) =>
        value?.Contains(query, StringComparison.OrdinalIgnoreCase) == true;

    private bool MatchesStatus(AccountRowViewModel row) => StatusFilter.Value switch
    {
        AccountStatusFilter.Enabled => row.Enabled,
        AccountStatusFilter.Disabled => !row.Enabled,
        AccountStatusFilter.LoggedIn => row.LoggedIn,
        AccountStatusFilter.LoggedOut => !row.LoggedIn,
        AccountStatusFilter.NeedsReauth => row.NeedsReauth,
        AccountStatusFilter.PageOpen => row.PageOpen,
        AccountStatusFilter.Abnormal => row.Account.State is "waf" or "unknown" || row.Account.Stale,
        AccountStatusFilter.PendingEdits => row.HasPendingEdits,
        _ => true,
    };

    private bool MatchesGroup(AccountRowViewModel row) => GroupFilter.Id switch
    {
        null => true,
        "\u0000ungrouped" => string.IsNullOrWhiteSpace(row.Account.GroupId),
        var id => row.Account.GroupId == id,
    };

    private void RaiseSummary()
    {
        OnPropertyChanged(nameof(SummaryText));
        OnPropertyChanged(nameof(SelectedCount));
        OnPropertyChanged(nameof(HasSelection));
        OnPropertyChanged(nameof(PendingEditCount));
        OnPropertyChanged(nameof(HasPendingEdits));
        OnPropertyChanged(nameof(PendingEditText));
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(EmptyText));
        (SaveAllEditsCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (RevertAllEditsCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
    }

    private async Task CreateAccountAsync()
    {
        var note = string.IsNullOrWhiteSpace(NewAccountNote) ? "新账号" : NewAccountNote.Trim();
        AccountDto? created = null;
        var ok = await _session.RunAsync("新增账号", async () =>
        {
            created = await _session.CallAsync(
                "accounts.create",
                new AccountCreateParams(note, NewAccountGroup?.Id),
                AppJsonContext.Default.AccountCreateParams,
                AppJsonContext.Default.AccountDto,
                AgentSession.NewCommandId());
            NewAccountNote = string.Empty;
            await _session.RefreshAsync();
        }, $"账号“{note}”已创建，正在打开登录窗口");

        // 新账号唯一有意义的下一步就是登录，旧网页面板也是创建后立刻拉起登录。
        // 少了这一步用户会盯着一个空账号，不知道还要再点一次"登录"。
        if (ok && created is not null && LoginRequested is not null)
        {
            await LoginRequested(created, false);
        }
    }

    private async Task<bool> SaveRowAsync(AccountRowViewModel row, AccountSaveRequest request)
    {
        if (request.Fields.HasFlag(AccountSaveFields.MinWindows)
            || request.Fields.HasFlag(AccountSaveFields.MaxWindows))
        {
            if (request.MinWindows < 1 || request.MaxWindows < request.MinWindows)
            {
                var message = request.MinWindows < 1
                    ? "最少窗口必须大于 0"
                    : "最多窗口不能小于最少窗口";
                _session.Toasts.Error($"{row.DisplayName}：{message}");
                return false;
            }
        }
        return await _session.RunAsync($"保存 {row.DisplayName}", async () =>
        {
            var updated = await _session.CallAsync(
                "accounts.update",
                new AccountUpdateParams(row.Id, request.Patch),
                AppJsonContext.Default.AccountUpdateParams,
                AppJsonContext.Default.AccountDto,
                AgentSession.NewCommandId());
            row.CommitSubmitted(request, updated);
            RaiseSummary();
        });
    }

    private async Task<bool> SetRowEnabledAsync(AccountRowViewModel row, bool enabled)
    {
        return await _session.RunAsync(enabled ? $"启用 {row.DisplayName}" : $"停用 {row.DisplayName}", async () =>
        {
            var updated = await _session.CallAsync(
                "accounts.update",
                new AccountToggleParams(row.Id, new AccountEnabledPatchDto { Enabled = enabled }),
                AppJsonContext.Default.AccountToggleParams,
                AppJsonContext.Default.AccountDto,
                AgentSession.NewCommandId());
            row.Apply(updated);
            ApplyFilter();
        });
    }

    private async Task RunRowCommandAsync(AccountRowViewModel row, string command)
    {
        switch (command)
        {
            case "login":
            case "force-login":
                if (LoginRequested is not null)
                {
                    await LoginRequested(row.Account, command == "force-login");
                }
                return;
            case "history":
                if (HistoryRequested is not null) await HistoryRequested(row.Id);
                return;
            case "remove":
                await RemoveRowAsync(row);
                return;
            case "close-page":
                await _session.RunAsync($"关闭 {row.DisplayName} 的 Chrome", async () =>
                {
                    await _session.CallAsync(
                        "browser.closePage",
                        new AccountIdParams(row.Id),
                        AppJsonContext.Default.AccountIdParams,
                        AppJsonContext.Default.OkResult,
                        AgentSession.NewCommandId());
                }, $"已请求关闭 {row.DisplayName} 的窗口");
                return;
            default:
                await SubmitOperationAsync(row, command);
                return;
        }
    }

    private async Task<AgentOperationDto?> SubmitOperationAsync(
        AccountRowViewModel row,
        string command,
        bool announceStart = true)
    {
        var (method, action) = command switch
        {
            "open-page" => ("browser.openPage", "打开真实 Chrome"),
            "refresh-status" => ("accounts.refreshStatus", "刷新登录状态"),
            "run-now" => ("accounts.runNow", "立即运行"),
            "check-selectors" => ("accounts.checkSelectors", "检查选择器"),
            _ => (string.Empty, string.Empty),
        };
        if (method.Length == 0) return null;

        AgentOperationDto? operation = null;
        var submitted = await _session.RunAsync($"{action}（{row.DisplayName}）", async () =>
        {
            if (method == "browser.openPage")
            {
                operation = await _session.CallAsync(
                    method,
                    new AccountIdParams(row.Id),
                    AppJsonContext.Default.AccountIdParams,
                    AppJsonContext.Default.AgentOperationDto,
                    AgentSession.NewCommandId());
            }
            else if (method == "accounts.checkSelectors")
            {
                // 默认只读探测：不在用户账号里留下探测对话。
                operation = await _session.CallAsync(
                    method,
                    new SelectorCheckParams(row.Id, false),
                    AppJsonContext.Default.SelectorCheckParams,
                    AppJsonContext.Default.AgentOperationDto,
                    AgentSession.NewCommandId());
            }
            else
            {
                operation = await _session.CallAsync(
                    method,
                    new IdParams(row.Id),
                    AppJsonContext.Default.IdParams,
                    AppJsonContext.Default.AgentOperationDto,
                    AgentSession.NewCommandId());
            }
        }, announceStart ? $"{action}已开始：{row.DisplayName}" : null);
        return submitted ? operation : null;
    }

    private async Task<AgentOperationDto> WaitForTerminalAsync(AgentOperationDto operation)
    {
        while (!operation.IsTerminal)
        {
            await Task.Delay(500, _session.Lifetime);
            operation = await _session.CallAsync(
                "operations.get",
                new IdParams(operation.Id),
                AppJsonContext.Default.IdParams,
                AppJsonContext.Default.AgentOperationDto);
        }
        return operation;
    }

    private async Task RemoveRowAsync(AccountRowViewModel row)
    {
        var action = AccountRemovalRequested is null ? null : await AccountRemovalRequested(row.Account);
        if (action is null) return;
        await _session.RunAsync($"删除 {row.DisplayName}", async () =>
        {
            await _session.CallAsync(
                "accounts.remove",
                new AccountRemoveParams(row.Id, action),
                AppJsonContext.Default.AccountRemoveParams,
                AppJsonContext.Default.OkResult,
                AgentSession.NewCommandId());
            RemoveAccount(row.Id);
        }, $"账号 {row.DisplayName} 已删除");
    }

    private Task SetSelectionAsync(bool selected)
    {
        foreach (var row in Rows) row.IsSelected = selected;
        RaiseSummary();
        return Task.CompletedTask;
    }

    private async Task SaveAllEditsAsync()
    {
        var dirty = _all.Where(row => row.HasPendingEdits).ToList();
        if (dirty.Count == 0) return;
        var invalid = dirty.FirstOrDefault(row => row.HasValidationError);
        if (invalid is not null)
        {
            _session.Toasts.Error($"{invalid.DisplayName}：{invalid.ValidationError}");
            return;
        }
        var saved = 0;
        foreach (var row in dirty)
        {
            if (await row.SaveDraftAsync(AccountSaveFields.All)) saved++;
        }
        if (saved == dirty.Count) _session.Toasts.Success($"已保存 {saved} 个账号的修改");
        else _session.Toasts.Error($"保存完成：成功 {saved} 个，失败 {dirty.Count - saved} 个");
    }

    private Task RevertAllEditsAsync()
    {
        foreach (var row in _all.Where(row => row.HasPendingEdits)) row.RevertDraft();
        RaiseSummary();
        _session.Toasts.Info("已放弃未保存的修改");
        return Task.CompletedTask;
    }

    private async Task BatchSetEnabledAsync(bool enabled)
    {
        var targets = Rows.Where(row => row.IsSelected && row.Enabled != enabled).ToList();
        if (targets.Count == 0)
        {
            _session.Toasts.Info("所选账号已经是目标状态");
            return;
        }
        var changed = 0;
        foreach (var row in targets)
        {
            if (await SetRowEnabledAsync(row, enabled)) changed++;
        }
        if (changed == targets.Count)
            _session.Toasts.Success($"已{(enabled ? "启用" : "停用")} {changed} 个账号");
        else
            _session.Toasts.Error($"批量{(enabled ? "启用" : "停用")}完成：成功 {changed} 个，失败 {targets.Count - changed} 个");
    }

    private async Task BatchOperationAsync(string action, string command)
    {
        var targets = Rows.Where(row => row.IsSelected).ToList();
        if (targets.Count == 0)
        {
            _session.Toasts.Info("请先勾选账号");
            return;
        }
        // 不把“逐个提交 RPC”误当成串行：Operation 收到后会立刻在 Agent 后台运行，
        // 而账号锁只隔离同一账号。这里等当前任务结束后再提交下一项，既限制 Chrome
        // 峰值，也让最终提示反映真实成功数而不是仅反映“提交成功”。
        var outcomes = await RunSequentiallyAsync(targets, async row =>
        {
            var operation = await SubmitOperationAsync(row, command, announceStart: false);
            if (operation is null) return false;

            AgentOperationDto? terminal = null;
            var observed = await _session.RunAsync($"等待{action}（{row.DisplayName}）", async () =>
            {
                terminal = await WaitForTerminalAsync(operation);
            });
            return observed && terminal?.State == "succeeded";
        });
        var succeeded = outcomes.Count(value => value);
        if (succeeded == targets.Count)
            _session.Toasts.Success($"“{action}”完成：{succeeded} 个账号全部成功");
        else
            _session.Toasts.Error($"“{action}”完成：成功 {succeeded} 个，失败 {targets.Count - succeeded} 个；详情见任务页");
    }

    internal static async Task<IReadOnlyList<TResult>> RunSequentiallyAsync<TItem, TResult>(
        IReadOnlyList<TItem> items,
        Func<TItem, Task<TResult>> action)
    {
        var results = new List<TResult>(items.Count);
        foreach (var item in items) results.Add(await action(item));
        return results;
    }

    private async Task BatchRemoveAsync()
    {
        var targets = Rows.Where(row => row.IsSelected).ToList();
        if (targets.Count == 0)
        {
            _session.Toasts.Info("请先勾选账号");
            return;
        }
        var names = string.Join("、", targets.Take(5).Select(row => row.DisplayName));
        var suffix = targets.Count > 5 ? $" 等 {targets.Count} 个账号" : string.Empty;
        if (!await _session.ConfirmDestructiveAsync(
            "批量删除账号",
            $"将删除 {names}{suffix}。Profile 一律保留（变为孤儿目录），可稍后在 Profile 页归档或永久删除。确认继续？"))
        {
            return;
        }

        var removed = 0;
        foreach (var row in targets)
        {
            var ok = await _session.RunAsync($"删除 {row.DisplayName}", async () =>
            {
                await _session.CallAsync(
                    "accounts.remove",
                    new AccountRemoveParams(row.Id, "detach"),
                    AppJsonContext.Default.AccountRemoveParams,
                    AppJsonContext.Default.OkResult,
                    AgentSession.NewCommandId());
                RemoveAccount(row.Id);
            });
            if (ok) removed++;
        }
        if (removed == targets.Count)
            _session.Toasts.Success($"已删除 {removed} 个账号，Profile 已保留");
        else
            _session.Toasts.Error($"批量删除完成：成功 {removed} 个，失败 {targets.Count - removed} 个；成功项的 Profile 已保留");
    }
}
