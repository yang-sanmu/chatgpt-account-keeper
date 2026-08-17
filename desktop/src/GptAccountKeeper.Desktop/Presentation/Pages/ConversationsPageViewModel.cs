using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal sealed class ConversationsPageViewModel : PageViewModel
{
    private readonly AgentSession _session;
    private ConversationSetDto? _selected;
    private bool _isCreating;
    private string _name = string.Empty;
    private string _topic = string.Empty;
    private int _minRounds = 2;
    private int _maxRounds = 6;

    public ConversationsPageViewModel(AgentSession session)
        : base("conversations", "✎", "会话", "对话主题和轮换范围")
    {
        _session = session;
        BeginNewCommand = new AsyncRelayCommand(BeginNewAsync);
        SaveCommand = new AsyncRelayCommand(SaveAsync);
        RemoveCommand = new AsyncRelayCommand(RemoveAsync, () => Selected is not null);
    }

    public ObservableCollection<ConversationSetDto> Items { get; } = [];

    public ICommand BeginNewCommand { get; }
    public ICommand SaveCommand { get; }
    public ICommand RemoveCommand { get; }

    public bool IsCreating
    {
        get => _isCreating;
        private set
        {
            if (SetProperty(ref _isCreating, value))
            {
                OnPropertyChanged(nameof(FormTitle));
                OnPropertyChanged(nameof(SaveText));
            }
        }
    }

    public string FormTitle => IsCreating
        ? "新建会话集"
        : Selected is null ? "选择或新建会话集" : $"编辑会话集：{Selected.Name}";

    public string SaveText => IsCreating ? "创建会话集" : "保存会话集";

    public bool CanEdit => IsCreating || Selected is not null;

    public ConversationSetDto? Selected
    {
        get => _selected;
        set
        {
            if (!SetProperty(ref _selected, value)) return;
            if (value is not null)
            {
                IsCreating = false;
                Name = value.Name;
                Topic = value.Topic;
                MinRounds = value.MinRounds;
                MaxRounds = value.MaxRounds;
            }
            OnPropertyChanged(nameof(CanEdit));
            OnPropertyChanged(nameof(FormTitle));
            (RemoveCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }
    }

    public string Name
    {
        get => _name;
        set => SetProperty(ref _name, value);
    }

    public string Topic
    {
        get => _topic;
        set => SetProperty(ref _topic, value);
    }

    public int MinRounds
    {
        get => _minRounds;
        set
        {
            if (SetProperty(ref _minRounds, value))
            {
                OnPropertyChanged(nameof(ValidationError));
                OnPropertyChanged(nameof(HasValidationError));
            }
        }
    }

    public int MaxRounds
    {
        get => _maxRounds;
        set
        {
            if (SetProperty(ref _maxRounds, value))
            {
                OnPropertyChanged(nameof(ValidationError));
                OnPropertyChanged(nameof(HasValidationError));
            }
        }
    }

    public string ValidationError => MinRounds < 1
        ? "最少轮数必须大于 0"
        : MaxRounds < MinRounds
            ? "最多轮数不能小于最少轮数"
            : string.Empty;

    public bool HasValidationError => ValidationError.Length > 0;

    public string Summary => $"{Items.Count} 个会话主题";

    public bool IsEmpty => Items.Count == 0;

    public void Apply(IReadOnlyDictionary<string, ConversationSetDto> sets)
    {
        var incoming = sets
            .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .Select(pair =>
            {
                pair.Value.Name = pair.Key;
                return pair.Value;
            })
            .ToList();
        var selectedName = Selected?.Name;
        CollectionSync.Apply(
            Items,
            incoming,
            item => item.Name,
            static (left, right) => left.Topic == right.Topic
                && left.MinRounds == right.MinRounds
                && left.MaxRounds == right.MaxRounds);
        var restored = Items.FirstOrDefault(item => item.Name == selectedName);
        if (restored is not null && !ReferenceEquals(restored, Selected)) Selected = restored;
        else if (selectedName is not null && restored is null) Selected = null;
        OnPropertyChanged(nameof(Summary));
        OnPropertyChanged(nameof(IsEmpty));
    }

    private Task BeginNewAsync()
    {
        IsCreating = true;
        Selected = null;
        Name = string.Empty;
        Topic = string.Empty;
        MinRounds = 2;
        MaxRounds = 6;
        OnPropertyChanged(nameof(CanEdit));
        return Task.CompletedTask;
    }

    private async Task SaveAsync()
    {
        var name = Name.Trim();
        var topic = Topic.Trim();
        if (name.Length == 0 || topic.Length == 0)
        {
            _session.Toasts.Error("会话集名称和对话主题都不能为空");
            return;
        }
        if (ValidationError.Length > 0)
        {
            _session.Toasts.Error(ValidationError);
            return;
        }

        var previousName = IsCreating ? null : Selected?.Name;
        var renaming = previousName is not null && !string.Equals(previousName, name, StringComparison.Ordinal);
        if (renaming && !await _session.ConfirmDestructiveAsync(
            "重命名会话集",
            $"将“{previousName}”重命名为“{name}”。重命名会先创建新名称再删除旧名称，"
                + "如果中途失败可能同时留下两份，需要手动删除多余的一份。确认继续？"))
        {
            return;
        }

        await _session.RunAsync(IsCreating ? "新建会话集" : "保存会话集", async () =>
        {
            await _session.CallAsync(
                "conversations.upsert",
                new ConversationUpsertParams(name, new ConversationSetDto
                {
                    Topic = topic,
                    MinRounds = MinRounds,
                    MaxRounds = MaxRounds,
                }),
                AppJsonContext.Default.ConversationUpsertParams,
                AppJsonContext.Default.ConversationSetDto,
                AgentSession.NewCommandId());
            if (renaming)
            {
                await _session.CallAsync(
                    "conversations.remove",
                    new NameParams(previousName!),
                    AppJsonContext.Default.NameParams,
                    AppJsonContext.Default.OkResult,
                    AgentSession.NewCommandId());
            }
            IsCreating = false;
            await _session.RefreshAsync();
        }, renaming ? $"会话集已重命名为“{name}”" : $"会话集“{name}”已保存");
    }

    private async Task RemoveAsync()
    {
        var set = Selected;
        if (set is null) return;
        if (!await _session.ConfirmDestructiveAsync(
            "删除会话集",
            $"确认删除会话集“{set.Name}”？正在使用该主题的账号会在下一轮改用其它主题，历史记录不会删除。"))
        {
            return;
        }
        await _session.RunAsync("删除会话集", async () =>
        {
            await _session.CallAsync(
                "conversations.remove",
                new NameParams(set.Name),
                AppJsonContext.Default.NameParams,
                AppJsonContext.Default.OkResult,
                AgentSession.NewCommandId());
            await _session.RefreshAsync();
        }, $"会话集“{set.Name}”已删除");
    }
}
