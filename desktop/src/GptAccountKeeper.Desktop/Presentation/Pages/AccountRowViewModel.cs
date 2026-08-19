using System.Windows.Input;
using Avalonia.Media;
using GptAccountKeeper.Desktop.Models;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

/// <summary>
/// 账号列表的一行。
///
/// 旧网页面板每行直接可编辑备注（失焦保存）、切换启用、改分组/轮换规则/窗口数，
/// 并显示出口、轮换进度、状态徽章和相对时间。之前的原生端把这些全收进右侧详情栏，
/// 管 26 个账号时任何批量意图都要点 26 次。这里把编辑放回行内。
///
/// 行内草稿用 <see cref="EditableField{T}"/> 承载：状态巡检事件每 15 分钟推一次，
/// 刷新时不能把用户正在输入的备注冲掉。
/// </summary>
internal sealed class AccountRowViewModel : ObservableObject
{
    private readonly EditableField<string> _note;
    private readonly EditableField<string?> _groupId;
    private readonly EditableField<string> _switchRule;
    private readonly EditableField<int> _minWindows;
    private readonly EditableField<int> _maxWindows;
    private readonly Func<AccountRowViewModel, AccountSaveRequest, Task<bool>> _saveDraft;
    private readonly Func<AccountRowViewModel, bool, Task<bool>> _setEnabled;
    private readonly SemaphoreSlim _saveGate = new(1, 1);
    private AccountDto _account;
    private bool _isSelected;

    public AccountRowViewModel(
        AccountDto account,
        IReadOnlyList<RouteChoiceViewModel> groupChoices,
        Func<AccountRowViewModel, AccountSaveRequest, Task<bool>> saveDraft,
        Func<AccountRowViewModel, bool, Task<bool>> setEnabled,
        Func<AccountRowViewModel, string, Task> runCommand)
    {
        _account = account;
        _saveDraft = saveDraft;
        _setEnabled = setEnabled;
        GroupChoices = groupChoices;
        _note = new EditableField<string>(account.Note ?? string.Empty, StringComparer.Ordinal);
        _groupId = new EditableField<string?>(account.GroupId, StringComparer.Ordinal);
        _switchRule = new EditableField<string>(account.SwitchRule, StringComparer.Ordinal);
        _minWindows = new EditableField<int>(account.MinWindows);
        _maxWindows = new EditableField<int>(account.MaxWindows);

        CommitNoteCommand = new AsyncRelayCommand(() => SaveDraftAsync(AccountSaveFields.All));
        ToggleEnabledCommand = new AsyncRelayCommand(() => _setEnabled(this, !Enabled));
        LoginCommand = new AsyncRelayCommand(() => runCommand(this, "login"));
        ForceLoginCommand = new AsyncRelayCommand(() => runCommand(this, "force-login"));
        OpenPageCommand = new AsyncRelayCommand(() => runCommand(this, "open-page"));
        ClosePageCommand = new AsyncRelayCommand(() => runCommand(this, "close-page"));
        RefreshStatusCommand = new AsyncRelayCommand(() => runCommand(this, "refresh-status"));
        RunNowCommand = new AsyncRelayCommand(() => runCommand(this, "run-now"));
        HistoryCommand = new AsyncRelayCommand(() => runCommand(this, "history"));
        RemoveCommand = new AsyncRelayCommand(() => runCommand(this, "remove"));
    }

    public AccountDto Account => _account;

    public string Id => _account.Id;

    public IReadOnlyList<RouteChoiceViewModel> GroupChoices { get; private set; }
    public IReadOnlyList<SwitchRuleOption> SwitchRules => SwitchRuleOption.All;

    public ICommand CommitNoteCommand { get; }
    public ICommand ToggleEnabledCommand { get; }
    public ICommand LoginCommand { get; }
    public ICommand ForceLoginCommand { get; }
    public ICommand OpenPageCommand { get; }
    public ICommand ClosePageCommand { get; }
    public ICommand RefreshStatusCommand { get; }
    public ICommand RunNowCommand { get; }
    public ICommand HistoryCommand { get; }
    public ICommand RemoveCommand { get; }

    /// <summary>批量操作的勾选状态。旧面板没有批量，管几十个账号只能逐个点。</summary>
    public bool IsSelected
    {
        get => _isSelected;
        set => SetProperty(ref _isSelected, value);
    }

    public string DisplayName => _account.DisplayName;

    public string Note
    {
        get => _note.Value;
        set
        {
            if (string.Equals(_note.Value, value ?? string.Empty, StringComparison.Ordinal)) return;
            _note.Value = value ?? string.Empty;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasPendingEdits));
        }
    }

    public string? GroupId
    {
        get => _groupId.Value;
        private set
        {
            if (string.Equals(_groupId.Value, value, StringComparison.Ordinal)) return;
            _groupId.Value = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasPendingEdits));
        }
    }

    /// <summary>下拉直接绑定选项对象，避免在 XAML 里做值转换。</summary>
    public RouteChoiceViewModel? SelectedGroup
    {
        get => GroupChoices.FirstOrDefault(choice => choice.Id == _groupId.Value) ?? GroupChoices.FirstOrDefault();
        set
        {
            if (value is null || string.Equals(value.Id, _groupId.Value, StringComparison.Ordinal)) return;
            GroupId = value.Id;
            OnPropertyChanged();
            // 分组决定出口，改完立刻保存，与旧面板的"选完即生效"一致。
            _ = SaveDraftAsync(AccountSaveFields.Group);
        }
    }

    public SwitchRuleOption SelectedSwitchRule
    {
        get => SwitchRuleOption.All.FirstOrDefault(option => option.Value == _switchRule.Value)
            ?? SwitchRuleOption.All[0];
        set
        {
            if (value is null || string.Equals(value.Value, _switchRule.Value, StringComparison.Ordinal)) return;
            _switchRule.Value = value.Value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasPendingEdits));
            _ = SaveDraftAsync(AccountSaveFields.SwitchRule);
        }
    }

    public int MinWindows
    {
        get => _minWindows.Value;
        set
        {
            if (_minWindows.Value == value) return;
            _minWindows.Value = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasPendingEdits));
        }
    }

    public int MaxWindows
    {
        get => _maxWindows.Value;
        set
        {
            if (_maxWindows.Value == value) return;
            _maxWindows.Value = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasPendingEdits));
        }
    }

    public bool HasPendingEdits =>
        _note.IsDirty || _groupId.IsDirty || _switchRule.IsDirty || _minWindows.IsDirty || _maxWindows.IsDirty;

    public bool Enabled => _account.Enabled;

    public string EnabledText => Enabled ? "已启用" : "已停用";

    public string ToggleText => Enabled ? "停用" : "启用";

    public bool LoggedIn => _account.LoggedIn;

    public bool PageOpen => _account.PageOpen;

    public bool NeedsReauth => _account.State == "reauth";

    public string StatusText => _account.StatusText + _account.StaleText;

    public IBrush StatusColor => _account.StatusColor;

    public string CheckedAtText => _account.CheckedAtText;

    public string CheckedAtTooltip => _account.CheckedAtTooltip;

    public string RouteText => _account.RouteText;

    public IBrush RouteColor => _account.RouteColor;

    public string RotationText => _account.RotationText;

    public double RotationProgress => _account.RotationProgress;

    public string ScheduleText => _account.ScheduleText;

    public string LastRunText => _account.LastRunText;

    public string LastRunTooltip => _account.LastRunTooltip;

    public bool IsLastRunFailed => _account.IsLastRunFailed;

    public IBrush LastRunColor => _account.LastRunColor;

    public string OpenPageText => PageOpen ? "已打开" : "打开网页";

    public string ValidationError => MinWindows < 1
        ? "最少窗口必须大于 0"
        : MaxWindows < MinWindows
            ? "最多窗口不能小于最少窗口"
            : string.Empty;

    public bool HasValidationError => ValidationError.Length > 0;

    public AccountPatchDto BuildPatch() => new()
    {
        Note = _note.Value.Trim(),
        GroupId = _groupId.Value,
        SwitchRule = _switchRule.Value,
        MinWindows = _minWindows.Value,
        MaxWindows = _maxWindows.Value,
    };

    public async Task<bool> SaveDraftAsync(AccountSaveFields requestedFields)
    {
        await _saveGate.WaitAsync();
        try
        {
            var request = CaptureSaveRequest(requestedFields);
            if (request.Fields == AccountSaveFields.None) return true;
            return await _saveDraft(this, request);
        }
        finally
        {
            _saveGate.Release();
        }
    }

    public AccountSaveRequest CaptureSaveRequest(AccountSaveFields requestedFields)
    {
        var fields = AccountSaveFields.None;
        if (requestedFields.HasFlag(AccountSaveFields.Note) && _note.IsDirty) fields |= AccountSaveFields.Note;
        if (requestedFields.HasFlag(AccountSaveFields.Group) && _groupId.IsDirty) fields |= AccountSaveFields.Group;
        if (requestedFields.HasFlag(AccountSaveFields.SwitchRule) && _switchRule.IsDirty) fields |= AccountSaveFields.SwitchRule;
        if (requestedFields.HasFlag(AccountSaveFields.MinWindows) && _minWindows.IsDirty) fields |= AccountSaveFields.MinWindows;
        if (requestedFields.HasFlag(AccountSaveFields.MaxWindows) && _maxWindows.IsDirty) fields |= AccountSaveFields.MaxWindows;

        // AccountPatchDto 为了表达“取消分组”总会序列化 groupId；把当前值纳入快照和确认范围，
        // 避免一个只改轮换规则的请求意外回滚并发的分组草稿。
        if (fields != AccountSaveFields.None) fields |= AccountSaveFields.Group;
        return new AccountSaveRequest(
            fields,
            _note.Value.Trim(),
            _groupId.Value,
            _switchRule.Value,
            _minWindows.Value,
            _maxWindows.Value,
            new AccountPatchDto
            {
                Note = fields.HasFlag(AccountSaveFields.Note) ? _note.Value.Trim() : null,
                GroupId = _groupId.Value,
                SwitchRule = fields.HasFlag(AccountSaveFields.SwitchRule) ? _switchRule.Value : null,
                MinWindows = fields.HasFlag(AccountSaveFields.MinWindows) ? _minWindows.Value : null,
                MaxWindows = fields.HasFlag(AccountSaveFields.MaxWindows) ? _maxWindows.Value : null,
            });
    }

    public void UpdateGroupChoices(IReadOnlyList<RouteChoiceViewModel> choices)
    {
        GroupChoices = choices;
        OnPropertyChanged(nameof(GroupChoices));
        OnPropertyChanged(nameof(SelectedGroup));
    }

    /// <summary>
    /// 应用服务端最新数据。脏草稿一律保留 —— 这正是"改备注时被巡检事件冲掉"的修复点。
    /// </summary>
    public void Apply(AccountDto account)
    {
        _account = account;
        if (_note.Refresh(account.Note ?? string.Empty)) OnPropertyChanged(nameof(Note));
        if (_groupId.Refresh(account.GroupId)) OnPropertyChanged(nameof(SelectedGroup));
        if (_switchRule.Refresh(account.SwitchRule)) OnPropertyChanged(nameof(SelectedSwitchRule));
        if (_minWindows.Refresh(account.MinWindows)) OnPropertyChanged(nameof(MinWindows));
        if (_maxWindows.Refresh(account.MaxWindows)) OnPropertyChanged(nameof(MaxWindows));
        RaiseDerived();
    }

    /// <summary>保存成功：以已提交的值作为新基线。</summary>
    public void CommitDraft(AccountDto account)
    {
        _account = account;
        _note.Commit(account.Note ?? string.Empty);
        _groupId.Commit(account.GroupId);
        _switchRule.Commit(account.SwitchRule);
        _minWindows.Commit(account.MinWindows);
        _maxWindows.Commit(account.MaxWindows);
        OnPropertyChanged(nameof(Note));
        OnPropertyChanged(nameof(SelectedGroup));
        OnPropertyChanged(nameof(SelectedSwitchRule));
        OnPropertyChanged(nameof(MinWindows));
        OnPropertyChanged(nameof(MaxWindows));
        RaiseDerived();
    }

    public void CommitSubmitted(AccountSaveRequest request, AccountDto account)
    {
        _account = account;
        if (request.Fields.HasFlag(AccountSaveFields.Note))
            _note.CommitSubmitted(request.Note, account.Note ?? string.Empty);
        else
            _note.Refresh(account.Note ?? string.Empty);
        if (request.Fields.HasFlag(AccountSaveFields.Group))
            _groupId.CommitSubmitted(request.GroupId, account.GroupId);
        else
            _groupId.Refresh(account.GroupId);
        if (request.Fields.HasFlag(AccountSaveFields.SwitchRule))
            _switchRule.CommitSubmitted(request.SwitchRule, account.SwitchRule);
        else
            _switchRule.Refresh(account.SwitchRule);
        if (request.Fields.HasFlag(AccountSaveFields.MinWindows))
            _minWindows.CommitSubmitted(request.MinWindows, account.MinWindows);
        else
            _minWindows.Refresh(account.MinWindows);
        if (request.Fields.HasFlag(AccountSaveFields.MaxWindows))
            _maxWindows.CommitSubmitted(request.MaxWindows, account.MaxWindows);
        else
            _maxWindows.Refresh(account.MaxWindows);

        OnPropertyChanged(nameof(Note));
        OnPropertyChanged(nameof(SelectedGroup));
        OnPropertyChanged(nameof(SelectedSwitchRule));
        OnPropertyChanged(nameof(MinWindows));
        OnPropertyChanged(nameof(MaxWindows));
        RaiseDerived();
    }

    public void RevertDraft()
    {
        _note.Revert();
        _groupId.Revert();
        _switchRule.Revert();
        _minWindows.Revert();
        _maxWindows.Revert();
        OnPropertyChanged(nameof(Note));
        OnPropertyChanged(nameof(SelectedGroup));
        OnPropertyChanged(nameof(SelectedSwitchRule));
        OnPropertyChanged(nameof(MinWindows));
        OnPropertyChanged(nameof(MaxWindows));
        OnPropertyChanged(nameof(HasPendingEdits));
    }

    private void RaiseDerived()
    {
        OnPropertyChanged(nameof(Account));
        OnPropertyChanged(nameof(DisplayName));
        OnPropertyChanged(nameof(Enabled));
        OnPropertyChanged(nameof(EnabledText));
        OnPropertyChanged(nameof(ToggleText));
        OnPropertyChanged(nameof(LoggedIn));
        OnPropertyChanged(nameof(PageOpen));
        OnPropertyChanged(nameof(NeedsReauth));
        OnPropertyChanged(nameof(StatusText));
        OnPropertyChanged(nameof(StatusColor));
        OnPropertyChanged(nameof(CheckedAtText));
        OnPropertyChanged(nameof(CheckedAtTooltip));
        OnPropertyChanged(nameof(RouteText));
        OnPropertyChanged(nameof(RouteColor));
        OnPropertyChanged(nameof(RotationText));
        OnPropertyChanged(nameof(RotationProgress));
        OnPropertyChanged(nameof(ScheduleText));
        OnPropertyChanged(nameof(LastRunText));
        OnPropertyChanged(nameof(LastRunTooltip));
        OnPropertyChanged(nameof(LastRunColor));
        OnPropertyChanged(nameof(IsLastRunFailed));
        OnPropertyChanged(nameof(OpenPageText));
        OnPropertyChanged(nameof(HasPendingEdits));
        OnPropertyChanged(nameof(ValidationError));
        OnPropertyChanged(nameof(HasValidationError));
    }
}

[Flags]
internal enum AccountSaveFields
{
    None = 0,
    Note = 1,
    Group = 2,
    SwitchRule = 4,
    MinWindows = 8,
    MaxWindows = 16,
    All = Note | Group | SwitchRule | MinWindows | MaxWindows,
}

internal sealed record AccountSaveRequest(
    AccountSaveFields Fields,
    string Note,
    string? GroupId,
    string SwitchRule,
    int MinWindows,
    int MaxWindows,
    AccountPatchDto Patch);

/// <summary>
/// 轮换方式选项。之前下拉直接显示 random / sequential，中英混排；
/// 而筛选器又用中文字符串当模型值，改文案就会静默失效。这里把两者分开。
/// </summary>
internal sealed record SwitchRuleOption(string Value, string Title)
{
    public static readonly IReadOnlyList<SwitchRuleOption> All =
    [
        new("random", "随机切换"),
        new("sequential", "顺序切换"),
    ];
}
