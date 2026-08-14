using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal enum HistoryResultFilter
{
    All,
    Succeeded,
    Failed,
}

internal sealed record HistoryResultFilterOption(HistoryResultFilter Value, string Title)
{
    public static readonly IReadOnlyList<HistoryResultFilterOption> All =
    [
        new(HistoryResultFilter.All, "全部结果"),
        new(HistoryResultFilter.Succeeded, "仅成功"),
        new(HistoryResultFilter.Failed, "仅失败"),
    ];
}

internal sealed class HistoryPageViewModel : PageViewModel
{
    private const int PageSize = 100;
    private readonly AgentSession _session;
    private HistoryAccountDto? _selectedAccount;
    private HistoryEntryDto? _selectedEntry;
    private HistoryResultFilterOption _resultFilter = HistoryResultFilterOption.All[0];
    private string _search = string.Empty;
    private HistoryEntryDto[] _allEntries = [];
    private string _summary = "选择左侧账号查看运行历史";
    private long _loadGeneration;
    private Task _currentLoad = Task.CompletedTask;

    public HistoryPageViewModel(AgentSession session)
        : base("history", "◷", "历史", "包括已删除账号的运行记录")
    {
        _session = session;
        ReloadCommand = new AsyncRelayCommand(ReloadAsync);
        CopyAnswerCommand = new AsyncRelayCommand(CopySelectedAnswerAsync, () => SelectedEntry?.HasRounds == true);
    }

    public ObservableCollection<HistoryAccountDto> Accounts { get; } = [];

    public ObservableCollection<HistoryEntryDto> Entries { get; } = [];

    public IReadOnlyList<HistoryResultFilterOption> ResultFilters => HistoryResultFilterOption.All;

    public ICommand ReloadCommand { get; }

    public ICommand CopyAnswerCommand { get; }

    /// <summary>复制到剪贴板由窗口提供：ViewModel 不直接依赖 Avalonia 顶层控件。</summary>
    public Func<string, Task>? CopyRequested { get; set; }

    public HistoryAccountDto? SelectedAccount
    {
        get => _selectedAccount;
        set
        {
            if (!SetProperty(ref _selectedAccount, value)) return;
            OnPropertyChanged(nameof(HasSelectedAccount));
            // 切换账号立刻载入，不必再手点“载入”。
            var generation = Interlocked.Increment(ref _loadGeneration);
            if (value is null)
            {
                _currentLoad = Task.CompletedTask;
                _allEntries = [];
                ApplyFilter();
            }
            else
            {
                _currentLoad = LoadAsync(value.AccountId, generation);
            }
        }
    }

    public bool HasSelectedAccount => SelectedAccount is not null;

    public bool HasHistoryAccounts => Accounts.Count > 0;

    public HistoryEntryDto? SelectedEntry
    {
        get => _selectedEntry;
        set
        {
            if (!SetProperty(ref _selectedEntry, value)) return;
            OnPropertyChanged(nameof(HasSelectedEntry));
            (CopyAnswerCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }
    }

    public bool HasSelectedEntry => SelectedEntry is not null;

    public HistoryResultFilterOption ResultFilter
    {
        get => _resultFilter;
        set
        {
            if (value is not null && SetProperty(ref _resultFilter, value)) ApplyFilter();
        }
    }

    public string Search
    {
        get => _search;
        set
        {
            if (SetProperty(ref _search, value)) ApplyFilter();
        }
    }

    public string Summary
    {
        get => _summary;
        private set => SetProperty(ref _summary, value);
    }

    public bool IsEmpty => Entries.Count == 0;

    public string EmptyText => SelectedAccount is null
        ? "选择左侧账号查看运行历史。"
        : _allEntries.Length == 0
            ? "该账号还没有运行记录。"
            : "没有符合当前搜索和筛选条件的记录。";

    public void ApplyAccounts(IReadOnlyList<HistoryAccountDto> accounts)
    {
        var selectedId = SelectedAccount?.AccountId;
        CollectionSync.Apply(
            Accounts,
            accounts,
            account => account.AccountId,
            static (left, right) => left.EntryCount == right.EntryCount
                && left.LastAt == right.LastAt
                && left.Deleted == right.Deleted);
        var restored = Accounts.FirstOrDefault(account => account.AccountId == selectedId);
        if (restored is not null && !ReferenceEquals(restored, SelectedAccount))
        {
            _selectedAccount = restored;
            OnPropertyChanged(nameof(SelectedAccount));
        }
        else if (selectedId is not null && restored is null)
        {
            SelectedAccount = null;
        }
        OnPropertyChanged(nameof(HasHistoryAccounts));
    }

    /// <summary>从账号页跳转过来：定位到该账号并载入。</summary>
    public async Task ShowAccountAsync(string accountId)
    {
        var target = Accounts.FirstOrDefault(account => account.AccountId == accountId);
        if (target is null)
        {
            _session.Toasts.Info("该账号还没有运行记录");
            return;
        }
        if (!ReferenceEquals(SelectedAccount, target))
        {
            SelectedAccount = target;
            await _currentLoad;
        }
        else
        {
            await ReloadAsync();
        }
    }

    /// <summary>history.appended 事件：当前正看着这个账号就把新记录插到最前。</summary>
    public bool ApplyAppended(HistoryAppendedDto appended)
    {
        if (SelectedAccount?.AccountId != appended.AccountId) return false;
        _allEntries = [appended.Entry, .. _allEntries];
        if (_allEntries.Length > PageSize) _allEntries = _allEntries[..PageSize];
        ApplyFilter();
        return true;
    }

    private Task ReloadAsync()
    {
        var accountId = SelectedAccount?.AccountId;
        if (string.IsNullOrWhiteSpace(accountId))
        {
            _session.Toasts.Info("请先选择一个历史账号");
            return Task.CompletedTask;
        }
        var generation = Interlocked.Increment(ref _loadGeneration);
        _currentLoad = LoadAsync(accountId, generation);
        return _currentLoad;
    }

    private async Task LoadAsync(string accountId, long generation)
    {
        await _session.RunAsync("读取运行历史", async () =>
        {
            var entries = await _session.CallAsync(
                "history.query",
                new HistoryQueryParams(accountId, PageSize),
                AppJsonContext.Default.HistoryQueryParams,
                AppJsonContext.Default.HistoryEntryDtoArray);
            if (generation != Volatile.Read(ref _loadGeneration)
                || SelectedAccount?.AccountId != accountId)
            {
                return;
            }
            _allEntries = entries;
            ApplyFilter();
        });
    }

    private void ApplyFilter()
    {
        var query = Search.Trim();
        var filtered = _allEntries.Where(entry =>
        {
            var matchesResult = ResultFilter.Value switch
            {
                HistoryResultFilter.Succeeded => entry.Ok == true,
                HistoryResultFilter.Failed => entry.Ok != true,
                _ => true,
            };
            if (!matchesResult) return false;
            if (query.Length == 0) return true;
            return Contains(entry.SetName, query)
                || Contains(entry.Topic, query)
                || Contains(entry.Error, query)
                || entry.Rounds.Any(round => Contains(round.Question, query) || Contains(round.Answer, query));
        }).ToList();

        var selectedKey = KeyOf(SelectedEntry);
        CollectionSync.Apply(Entries, filtered, KeyOf);
        var restored = Entries.FirstOrDefault(entry => KeyOf(entry) == selectedKey);
        SelectedEntry = restored ?? Entries.FirstOrDefault();
        Summary = _allEntries.Length == 0
            ? "该账号还没有运行记录"
            : $"最近 {_allEntries.Length} 条 · 成功 {_allEntries.Count(entry => entry.Ok == true)} 条 · "
                + $"失败 {_allEntries.Count(entry => entry.Ok != true)} 条 · 显示 {Entries.Count} 条";
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(EmptyText));
    }

    private static bool Contains(string? value, string query) =>
        value?.Contains(query, StringComparison.OrdinalIgnoreCase) == true;

    // 历史记录没有服务端 id，用时间 + 主题 + 轮数组合成稳定 key。
    private static string KeyOf(HistoryEntryDto? entry) => entry is null
        ? string.Empty
        : $"{entry.Time:O}|{entry.SetName}|{entry.TotalRounds}|{entry.Error}";

    private async Task CopySelectedAnswerAsync()
    {
        var entry = SelectedEntry;
        if (entry is null || CopyRequested is null) return;
        var text = string.Join(
            Environment.NewLine + Environment.NewLine,
            entry.Rounds.Select((round, index) =>
                $"# 第 {index + 1} 轮{Environment.NewLine}问：{round.QuestionText}{Environment.NewLine}答：{round.AnswerText}"));
        if (text.Length == 0)
        {
            _session.Toasts.Info("这条记录没有问答内容");
            return;
        }
        await CopyRequested(text);
        _session.Toasts.Success($"已复制 {entry.Rounds.Length} 轮问答到剪贴板");
    }
}
