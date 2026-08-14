using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal enum OperationFilter
{
    All,
    Active,
    Failed,
}

internal sealed record OperationFilterOption(OperationFilter Value, string Title)
{
    public static readonly IReadOnlyList<OperationFilterOption> All =
    [
        new(OperationFilter.All, "全部任务"),
        new(OperationFilter.Active, "仅进行中"),
        new(OperationFilter.Failed, "仅失败"),
    ];
}

internal sealed class OperationsPageViewModel : PageViewModel
{
    private const int MaxTracked = 200;
    private readonly AgentSession _session;
    private readonly List<AgentOperationDto> _all = [];
    private AgentOperationDto? _selected;
    private OperationFilterOption _filter = OperationFilterOption.All[0];

    public OperationsPageViewModel(AgentSession session)
        : base("operations", "▶", "任务", "后台 Operation 进度与错误")
    {
        _session = session;
        ReloadCommand = new AsyncRelayCommand(ReloadAsync);
        CopyErrorCommand = new AsyncRelayCommand(CopyErrorAsync, () => Selected?.HasError == true);
    }

    public ObservableCollection<AgentOperationDto> Items { get; } = [];

    public IReadOnlyList<OperationFilterOption> Filters => OperationFilterOption.All;

    public ICommand ReloadCommand { get; }

    public ICommand CopyErrorCommand { get; }

    public Func<string, Task>? CopyRequested { get; set; }

    public AgentOperationDto? Selected
    {
        get => _selected;
        set
        {
            if (!SetProperty(ref _selected, value)) return;
            OnPropertyChanged(nameof(HasSelected));
            (CopyErrorCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }
    }

    public bool HasSelected => Selected is not null;

    public OperationFilterOption Filter
    {
        get => _filter;
        set
        {
            if (value is not null && SetProperty(ref _filter, value)) ApplyFilter();
        }
    }

    public string Summary =>
        $"共 {_all.Count} 项 · 进行中 {_all.Count(item => !item.IsTerminal)} 项 · "
        + $"失败 {_all.Count(item => item.State is "failed" or "timed_out")} 项 · 显示 {Items.Count} 项";

    public bool IsEmpty => Items.Count == 0;

    public string EmptyText => _all.Count == 0
        ? "还没有后台任务。登录、立即运行、测速和 Profile 操作都会在这里留下记录。"
        : "没有符合当前筛选条件的任务。";

    /// <summary>
    /// 用一次快照替换列表。Agent 现在把任务写进 SQLite，重连或 Agent 重启后
    /// 已结束任务的错误详情仍然查得到。
    /// </summary>
    public void ApplySnapshot(IReadOnlyList<AgentOperationDto> operations)
    {
        _all.Clear();
        _all.AddRange(operations.OrderByDescending(item => item.StartedAt));
        Trim();
        ApplyFilter();
    }

    public void Upsert(AgentOperationDto operation)
    {
        var index = _all.FindIndex(item => item.Id == operation.Id);
        if (index >= 0) _all[index] = operation;
        else _all.Insert(0, operation);
        Trim();
        ApplyFilter();
    }

    private void Trim()
    {
        while (_all.Count > MaxTracked) _all.RemoveAt(_all.Count - 1);
    }

    private void ApplyFilter()
    {
        var filtered = _all.Where(item => Filter.Value switch
        {
            OperationFilter.Active => !item.IsTerminal,
            OperationFilter.Failed => item.State is "failed" or "timed_out",
            _ => true,
        }).ToList();
        var selectedId = Selected?.Id;
        CollectionSync.Apply(
            Items,
            filtered,
            item => item.Id,
            static (left, right) => left.State == right.State
                && left.Stage == right.Stage
                && left.Message == right.Message
                && left.Progress == right.Progress);
        var restored = Items.FirstOrDefault(item => item.Id == selectedId);
        Selected = restored ?? Items.FirstOrDefault();
        OnPropertyChanged(nameof(Summary));
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(EmptyText));
    }

    private Task ReloadAsync() => _session.RunAsync("读取任务列表", async () =>
    {
        var operations = await _session.CallAsync(
            "operations.list",
            new OperationListParams(MaxTracked),
            AppJsonContext.Default.OperationListParams,
            AppJsonContext.Default.AgentOperationDtoArray);
        ApplySnapshot(operations);
    });

    private async Task CopyErrorAsync()
    {
        var operation = Selected;
        if (operation?.Error is null || CopyRequested is null) return;
        var text = $"任务：{operation.KindText}（{operation.Kind}）"
            + $"{Environment.NewLine}资源：{operation.ResourceId ?? "—"}"
            + $"{Environment.NewLine}状态：{operation.StateText}"
            + $"{Environment.NewLine}错误码：{operation.Error.Code}"
            + $"{Environment.NewLine}错误信息：{operation.Error.Message}"
            + $"{Environment.NewLine}任务 ID：{operation.Id}";
        await CopyRequested(text);
        _session.Toasts.Success("错误详情已复制到剪贴板");
    }
}
