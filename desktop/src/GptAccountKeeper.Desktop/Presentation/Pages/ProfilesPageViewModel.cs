using System.Collections.ObjectModel;
using System.Text.Json;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal sealed class ProfilesPageViewModel : PageViewModel
{
    private readonly AgentSession _session;
    private ProfileEntryDto? _selected;
    private bool _scanned;
    private bool _onlyOrphans;
    private string _summary = "首次进入会自动扫描 Profile 占用";
    private ProfileEntryDto[] _all = [];

    public ProfilesPageViewModel(AgentSession session)
        : base("profiles", "▣", "Profile", "扫描、缓存清理和孤儿处理")
    {
        _session = session;
        ScanCommand = new AsyncRelayCommand(ScanAsync);
        CleanAllCommand = new AsyncRelayCommand(CleanAllAsync);
        CleanSelectedCommand = new AsyncRelayCommand(CleanSelectedAsync, () => Selected is not null);
        ArchiveOrphanCommand = new AsyncRelayCommand(ArchiveOrphanAsync, () => CanOperateOrphan);
        PurgeOrphanCommand = new AsyncRelayCommand(PurgeOrphanAsync, () => CanOperateOrphan);
    }

    public ObservableCollection<ProfileEntryDto> Items { get; } = [];

    public ICommand ScanCommand { get; }
    public ICommand CleanAllCommand { get; }
    public ICommand CleanSelectedCommand { get; }
    public ICommand ArchiveOrphanCommand { get; }
    public ICommand PurgeOrphanCommand { get; }

    public ProfileEntryDto? Selected
    {
        get => _selected;
        set
        {
            if (!SetProperty(ref _selected, value)) return;
            OnPropertyChanged(nameof(HasSelected));
            OnPropertyChanged(nameof(CanOperateOrphan));
            OnPropertyChanged(nameof(OrphanHint));
            (CleanSelectedCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (ArchiveOrphanCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (PurgeOrphanCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }
    }

    public bool HasSelected => Selected is not null;

    public bool CanOperateOrphan => Selected is { Linked: false, Busy: false };

    public string OrphanHint => Selected is null
        ? "选择一个 Profile 查看详情"
        : Selected.Busy
            ? "该 Profile 正在被 Chrome 使用，先关闭窗口再操作"
            : Selected.Linked
                ? "该 Profile 仍关联账号，只能清理缓存"
                : "孤儿 Profile：可归档保留登录数据，或永久删除";

    public bool OnlyOrphans
    {
        get => _onlyOrphans;
        set
        {
            if (SetProperty(ref _onlyOrphans, value)) ApplyFilter();
        }
    }

    public string Summary
    {
        get => _summary;
        private set => SetProperty(ref _summary, value);
    }

    public bool IsEmpty => Items.Count == 0;

    public string EmptyText => _scanned
        ? OnlyOrphans ? "没有孤儿 Profile。" : "profiles 目录下没有 Profile。"
        : "正在扫描 Profile 占用…";

    /// <summary>
    /// 首次进入自动扫描。之前每次进来都是空列表，必须先手点“扫描”才有内容。
    /// </summary>
    public override async Task ActivateAsync()
    {
        if (_scanned || !_session.IsConnected) return;
        await ScanAsync();
    }

    public void ApplyScan(JsonElement result)
    {
        if (result.ValueKind != JsonValueKind.Object) return;
        var scan = result.Deserialize(AppJsonContext.Default.ProfileScanResultDto);
        if (scan is null) return;
        _scanned = true;
        _all = scan.Profiles;
        ApplyFilter();
        Summary = $"{scan.Totals.Profiles} 个 Profile · {scan.Totals.Linked} 个已关联 · "
            + $"{scan.Totals.Orphans} 个孤儿 · 可清理缓存 {FormatBytes(scan.Totals.CacheBytes)} · "
            + $"已归档 {scan.Totals.ArchiveCount} 个（{FormatBytes(scan.Totals.ArchiveBytes)}） · "
            + $"删除残留 {scan.Totals.TrashCount} 个（{FormatBytes(scan.Totals.TrashBytes)}）";
    }

    private void ApplyFilter()
    {
        var filtered = (OnlyOrphans ? _all.Where(profile => !profile.Linked) : _all).ToList();
        var selectedName = Selected?.Name;
        CollectionSync.Apply(Items, filtered, profile => profile.Name);
        var restored = Items.FirstOrDefault(profile => profile.Name == selectedName);
        Selected = restored ?? Items.FirstOrDefault();
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(EmptyText));
    }

    private Task ScanAsync() => _session.RunAsync("扫描 Profile", async () =>
    {
        await _session.CallAsync(
            "profiles.scan",
            new EmptyParams(),
            AppJsonContext.Default.EmptyParams,
            AppJsonContext.Default.AgentOperationDto,
            AgentSession.NewCommandId());
    });

    private Task CleanCacheAsync(string? name, string action, string success) =>
        _session.RunAsync(action, async () =>
        {
            await _session.CallAsync(
                "profiles.cleanCache",
                new ProfileCleanParams("all", name),
                AppJsonContext.Default.ProfileCleanParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
        }, success);

    private Task CleanAllAsync() => CleanCacheAsync(
        null,
        "清理全部可重建缓存",
        "已开始清理，Cookie、Local Storage、IndexedDB 和 Service Worker 数据会保留");

    private Task CleanSelectedAsync()
    {
        var profile = Selected;
        if (profile is null) return Task.CompletedTask;
        return CleanCacheAsync(
            profile.Name,
            $"清理 {profile.Name} 的缓存",
            $"已开始清理 {profile.Name} 的可重建缓存");
    }

    private async Task ArchiveOrphanAsync()
    {
        var profile = Selected;
        if (profile is null || !CanOperateOrphan) return;
        if (!await _session.ConfirmDestructiveAsync(
            "归档孤儿 Profile",
            $"将“{profile.Name}”（{profile.SizeText}）移动到归档目录。登录数据完整保留，但当前路径会消失。确认继续？"))
        {
            return;
        }
        await SubmitNameOperationAsync("profiles.archiveOrphan", profile.Name, "归档孤儿 Profile");
    }

    private async Task PurgeOrphanAsync()
    {
        var profile = Selected;
        if (profile is null || !CanOperateOrphan) return;
        if (!await _session.ConfirmDestructiveAsync(
            "永久删除孤儿 Profile",
            $"将永久删除“{profile.Name}”（{profile.SizeText}）及其中的 Cookie、Local Storage 和登录态。"
                + "此操作不可恢复。如果只是想腾出空间，建议改用“归档”。确认永久删除？"))
        {
            return;
        }
        await SubmitNameOperationAsync("profiles.purgeOrphan", profile.Name, "永久删除孤儿 Profile");
    }

    private Task SubmitNameOperationAsync(string method, string name, string action) =>
        _session.RunAsync(action, async () =>
        {
            await _session.CallAsync(
                method,
                new NameParams(name),
                AppJsonContext.Default.NameParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
        }, $"{action}已开始：{name}");

    private static string FormatBytes(long bytes)
    {
        var value = (double)Math.Max(0, bytes);
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var index = 0;
        while (value >= 1024 && index < units.Length - 1) { value /= 1024; index++; }
        return $"{value:0.##} {units[index]}";
    }
}
