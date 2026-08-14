using System.Collections.ObjectModel;
using System.Windows.Input;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;

namespace GptAccountKeeper.Desktop.Presentation.Pages;

internal sealed class ProxiesPageViewModel : PageViewModel
{
    private readonly AgentSession _session;
    private GroupDto? _selectedGroup;
    private ProxyNodeDto? _selectedNode;
    private bool _isCreatingGroup;
    private string _groupName = string.Empty;
    private string _groupTimezone = string.Empty;
    private string _groupLocale = string.Empty;
    private RouteChoiceViewModel? _groupProxy;
    private string _subscriptionUrl = string.Empty;
    private string _runtimeDirectory = string.Empty;
    private string _nodeSearch = string.Empty;
    private string _subscriptionSummary = "尚未配置订阅";
    private string _runtimeSummary = "尚未检测 mihomo 内核";
    private ProxyNodeDto[] _allNodes = [];

    public ProxiesPageViewModel(AgentSession session)
        : base("proxies", "⇄", "分组与代理", "节点、出口与 mihomo 运行状态")
    {
        _session = session;
        ProxyChoices.Add(new RouteChoiceViewModel(null, "系统网络"));
        _groupProxy = ProxyChoices[0];

        BeginNewGroupCommand = new AsyncRelayCommand(BeginNewGroupAsync);
        SaveGroupCommand = new AsyncRelayCommand(SaveGroupAsync);
        RemoveGroupCommand = new AsyncRelayCommand(RemoveGroupAsync, () => SelectedGroup is not null);
        ImportSubscriptionCommand = new AsyncRelayCommand(ImportSubscriptionAsync);
        RefreshSubscriptionCommand = new AsyncRelayCommand(RefreshSubscriptionAsync);
        TestNodeCommand = new AsyncRelayCommand(TestNodeAsync, () => SelectedNode is not null);
        TestAllCommand = new AsyncRelayCommand(TestAllAsync);
        ToggleNodeCommand = new AsyncRelayCommand(ToggleNodeAsync, () => SelectedNode is not null);
        SaveRuntimeDirectoryCommand = new AsyncRelayCommand(SaveRuntimeDirectoryAsync);
    }

    public ObservableCollection<GroupDto> Groups { get; } = [];

    public ObservableCollection<ProxyNodeDto> Nodes { get; } = [];

    public ObservableCollection<RouteChoiceViewModel> ProxyChoices { get; } = [];

    public ICommand BeginNewGroupCommand { get; }
    public ICommand SaveGroupCommand { get; }
    public ICommand RemoveGroupCommand { get; }
    public ICommand ImportSubscriptionCommand { get; }
    public ICommand RefreshSubscriptionCommand { get; }
    public ICommand TestNodeCommand { get; }
    public ICommand TestAllCommand { get; }
    public ICommand ToggleNodeCommand { get; }
    public ICommand SaveRuntimeDirectoryCommand { get; }

    /// <summary>
    /// 新建与编辑分开。之前共用一个表单、用 SelectedGroup == null 表示新建：
    /// 点了“新建”后再碰一下列表就会静默变成编辑那个分组。
    /// </summary>
    public bool IsCreatingGroup
    {
        get => _isCreatingGroup;
        private set
        {
            if (SetProperty(ref _isCreatingGroup, value))
            {
                OnPropertyChanged(nameof(GroupFormTitle));
                OnPropertyChanged(nameof(GroupSaveText));
            }
        }
    }

    public string GroupFormTitle => IsCreatingGroup ? "新建分组" : SelectedGroup is null ? "选择或新建分组" : $"编辑分组：{SelectedGroup.Name}";

    public string GroupSaveText => IsCreatingGroup ? "创建分组" : "保存分组";

    public bool CanEditGroup => IsCreatingGroup || SelectedGroup is not null;

    public GroupDto? SelectedGroup
    {
        get => _selectedGroup;
        set
        {
            if (!SetProperty(ref _selectedGroup, value)) return;
            if (value is not null)
            {
                // 选中一个已有分组即离开"新建"模式，表单内容明确对应该分组。
                IsCreatingGroup = false;
                GroupName = value.Name;
                GroupTimezone = value.Timezone ?? string.Empty;
                GroupLocale = value.Locale ?? string.Empty;
                GroupProxy = ProxyChoices.FirstOrDefault(choice => choice.Id == value.ProxyId)
                    ?? ProxyChoices.FirstOrDefault();
            }
            OnPropertyChanged(nameof(CanEditGroup));
            OnPropertyChanged(nameof(GroupFormTitle));
            (RemoveGroupCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }
    }

    public ProxyNodeDto? SelectedNode
    {
        get => _selectedNode;
        set
        {
            if (!SetProperty(ref _selectedNode, value)) return;
            OnPropertyChanged(nameof(ToggleNodeText));
            OnPropertyChanged(nameof(HasSelectedNode));
            (TestNodeCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (ToggleNodeCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }
    }

    public bool HasSelectedNode => SelectedNode is not null;

    public string ToggleNodeText => SelectedNode?.Enabled == true ? "停用节点" : "启用节点";

    public string GroupName
    {
        get => _groupName;
        set => SetProperty(ref _groupName, value);
    }

    public string GroupTimezone
    {
        get => _groupTimezone;
        set => SetProperty(ref _groupTimezone, value);
    }

    public string GroupLocale
    {
        get => _groupLocale;
        set => SetProperty(ref _groupLocale, value);
    }

    public RouteChoiceViewModel? GroupProxy
    {
        get => _groupProxy;
        set => SetProperty(ref _groupProxy, value);
    }

    public string SubscriptionUrl
    {
        get => _subscriptionUrl;
        set => SetProperty(ref _subscriptionUrl, value);
    }

    public string RuntimeDirectory
    {
        get => _runtimeDirectory;
        set => SetProperty(ref _runtimeDirectory, value);
    }

    public string NodeSearch
    {
        get => _nodeSearch;
        set
        {
            if (SetProperty(ref _nodeSearch, value)) ApplyNodeFilter();
        }
    }

    public string SubscriptionSummary
    {
        get => _subscriptionSummary;
        private set => SetProperty(ref _subscriptionSummary, value);
    }

    public string RuntimeSummary
    {
        get => _runtimeSummary;
        private set => SetProperty(ref _runtimeSummary, value);
    }

    public string GroupSummary => $"{Groups.Count} 个分组";

    public string NodeSummary =>
        $"共 {_allNodes.Length} 个节点 · {_allNodes.Count(node => node.Enabled && !node.Missing)} 个可用 · "
        + $"{_allNodes.Count(node => node.Missing)} 个已失效 · 显示 {Nodes.Count} 个";

    public bool HasNodes => _allNodes.Length > 0;

    public bool HasGroups => Groups.Count > 0;

    public bool IsNodeListEmpty => Nodes.Count == 0;

    public string NodeEmptyText => _allNodes.Length == 0
        ? "还没有代理节点。填入 Clash 订阅地址后点“导入订阅”，节点会按订阅顺序保存。"
        : "没有符合当前搜索条件的代理节点。";

    public void ApplyState(ProxyStateDto state, IReadOnlyList<GroupDto> groups, IReadOnlyList<AccountDto> accounts)
    {
        _allNodes = state.Nodes;
        var nodeNames = state.Nodes.ToDictionary(node => node.Id, node => node.Name, StringComparer.Ordinal);
        var accountCounts = accounts
            .Where(account => !string.IsNullOrWhiteSpace(account.GroupId))
            .GroupBy(account => account.GroupId!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
        foreach (var group in groups)
        {
            group.ProxyName = group.ProxyId is not null && nodeNames.TryGetValue(group.ProxyId, out var name)
                ? name
                : group.ProxyId;
            group.AccountCount = accountCounts.TryGetValue(group.Id, out var count) ? count : 0;
        }

        var selectedGroupId = SelectedGroup?.Id;
        CollectionSync.Apply(Groups, groups, group => group.Id);
        var restoredGroup = Groups.FirstOrDefault(group => group.Id == selectedGroupId);
        if (restoredGroup is not null && !ReferenceEquals(restoredGroup, SelectedGroup))
        {
            SelectedGroup = restoredGroup;
        }
        else if (selectedGroupId is not null && restoredGroup is null)
        {
            SelectedGroup = null;
        }

        var wanted = new List<RouteChoiceViewModel> { new(null, "系统网络") };
        foreach (var node in state.Nodes.Where(node => node.Enabled && !node.Missing))
        {
            wanted.Add(new RouteChoiceViewModel(node.Id, node.Name));
        }
        var previousProxy = GroupProxy?.Id;
        CollectionSync.Apply(
            ProxyChoices,
            wanted,
            choice => choice.Id ?? " none",
            static (left, right) => left.Title == right.Title);
        GroupProxy = ProxyChoices.FirstOrDefault(choice => choice.Id == previousProxy)
            ?? ProxyChoices.FirstOrDefault();

        ApplyNodeFilter();
        SubscriptionSummary = state.Subscription is null
            ? "尚未配置订阅"
            : $"订阅主机 {state.Subscription.Host} · 更新于 {RelativeTime.Describe(state.Subscription.UpdatedAt)}";
        RuntimeSummary = DescribeRuntime(state.Runtime);
        var directory = ReadString(state.Runtime, "clashVergeDir");
        if (!string.IsNullOrWhiteSpace(directory) && string.IsNullOrWhiteSpace(RuntimeDirectory))
        {
            RuntimeDirectory = directory;
        }
        OnPropertyChanged(nameof(GroupSummary));
        OnPropertyChanged(nameof(HasGroups));
        OnPropertyChanged(nameof(NodeSummary));
        OnPropertyChanged(nameof(HasNodes));
        OnPropertyChanged(nameof(IsNodeListEmpty));
        OnPropertyChanged(nameof(NodeEmptyText));
    }

    /// <summary>单节点测速结果：立刻回填到那一行，不必等整批任务结束。</summary>
    public bool ApplyNodeTest(ProxyNodeTestedDto tested)
    {
        var index = Array.FindIndex(_allNodes, node => node.Id == tested.Id);
        if (index < 0) return false;
        var updated = _allNodes[index] with
        {
            LatencyOk = tested.Ok,
            LatencyMs = tested.Ok ? tested.Delay : null,
            LatencyMessage = tested.Ok ? null : tested.Message,
            LatencyTestedAt = tested.TestedAt ?? DateTimeOffset.Now,
        };
        _allNodes[index] = updated;
        CollectionSync.Replace(Nodes, updated, node => node.Id);
        if (SelectedNode?.Id == tested.Id) SelectedNode = updated;
        return true;
    }

    private void ApplyNodeFilter()
    {
        var query = NodeSearch.Trim();
        var filtered = _allNodes
            .Where(node => query.Length == 0
                || node.Name.Contains(query, StringComparison.OrdinalIgnoreCase)
                || node.Server?.Contains(query, StringComparison.OrdinalIgnoreCase) == true
                || node.Type?.Contains(query, StringComparison.OrdinalIgnoreCase) == true)
            .ToList();
        var selectedId = SelectedNode?.Id;
        CollectionSync.Apply(Nodes, filtered, node => node.Id);
        var restored = Nodes.FirstOrDefault(node => node.Id == selectedId);
        if (!ReferenceEquals(restored, SelectedNode)) SelectedNode = restored;
        OnPropertyChanged(nameof(NodeSummary));
        OnPropertyChanged(nameof(IsNodeListEmpty));
        OnPropertyChanged(nameof(NodeEmptyText));
    }

    private static string DescribeRuntime(System.Text.Json.JsonElement runtime)
    {
        var found = runtime.ValueKind == System.Text.Json.JsonValueKind.Object
            && runtime.TryGetProperty("found", out var element)
            && element.ValueKind == System.Text.Json.JsonValueKind.True;
        var path = ReadString(runtime, "path");
        return found
            ? $"mihomo 内核可用：{path}"
            : "未找到可独立启动的 mihomo 内核，请设置 Clash Verge 安装目录";
    }

    private static string? ReadString(System.Text.Json.JsonElement element, string name) =>
        element.ValueKind == System.Text.Json.JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == System.Text.Json.JsonValueKind.String
            ? value.GetString()
            : null;

    private Task BeginNewGroupAsync()
    {
        IsCreatingGroup = true;
        SelectedGroup = null;
        GroupName = string.Empty;
        GroupTimezone = string.Empty;
        GroupLocale = string.Empty;
        GroupProxy = ProxyChoices.FirstOrDefault();
        OnPropertyChanged(nameof(CanEditGroup));
        return Task.CompletedTask;
    }

    private async Task SaveGroupAsync()
    {
        var name = GroupName.Trim();
        if (name.Length == 0)
        {
            _session.Toasts.Error("分组名称不能为空");
            return;
        }
        if (!IsCreatingGroup && SelectedGroup is null)
        {
            _session.Toasts.Info("请先选择要编辑的分组，或点“新建分组”");
            return;
        }

        var creating = IsCreatingGroup;
        await _session.RunAsync(creating ? "新建分组" : "保存分组", async () =>
        {
            if (creating)
            {
                await _session.CallAsync(
                    "groups.create",
                    new GroupCreateParams(name, GroupProxy?.Id, EmptyToNull(GroupTimezone), EmptyToNull(GroupLocale)),
                    AppJsonContext.Default.GroupCreateParams,
                    AppJsonContext.Default.GroupDto,
                    AgentSession.NewCommandId());
                IsCreatingGroup = false;
            }
            else
            {
                await _session.CallAsync(
                    "groups.update",
                    new GroupUpdateParams(SelectedGroup!.Id, new GroupPatchDto
                    {
                        Name = name,
                        ProxyId = GroupProxy?.Id,
                        Timezone = EmptyToNull(GroupTimezone),
                        Locale = EmptyToNull(GroupLocale),
                    }),
                    AppJsonContext.Default.GroupUpdateParams,
                    AppJsonContext.Default.GroupDto,
                    AgentSession.NewCommandId());
            }
            await _session.RefreshAsync();
        }, creating ? $"分组“{name}”已创建" : $"分组“{name}”已保存");
    }

    private async Task RemoveGroupAsync()
    {
        var group = SelectedGroup;
        if (group is null) return;
        if (!await _session.ConfirmDestructiveAsync(
            "删除分组",
            $"确认删除分组“{group.Name}”？组内 {group.AccountCount} 个账号会变为不分组并跟随系统网络，Profile 不会删除。"))
        {
            return;
        }
        await _session.RunAsync("删除分组", async () =>
        {
            await _session.CallAsync(
                "groups.remove",
                new IdParams(group.Id),
                AppJsonContext.Default.IdParams,
                AppJsonContext.Default.OkResult,
                AgentSession.NewCommandId());
            await _session.RefreshAsync();
        }, $"分组“{group.Name}”已删除");
    }

    private async Task ImportSubscriptionAsync()
    {
        var url = SubscriptionUrl.Trim();
        if (url.Length == 0)
        {
            _session.Toasts.Error("请输入代理订阅地址；地址只发送给本机 Agent，不会回显或写入普通日志");
            return;
        }
        await _session.RunAsync("导入代理订阅", async () =>
        {
            await _session.CallAsync(
                "proxies.importSubscription",
                new ProxySubscriptionParams(url),
                AppJsonContext.Default.ProxySubscriptionParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
            SubscriptionUrl = string.Empty;
        }, "订阅导入已开始，进度见任务页");
    }

    private Task RefreshSubscriptionAsync() => _session.RunAsync("刷新代理订阅", async () =>
    {
        await _session.CallAsync(
            "proxies.refreshSubscription",
            new EmptyParams(),
            AppJsonContext.Default.EmptyParams,
            AppJsonContext.Default.AgentOperationDto,
            AgentSession.NewCommandId());
    }, "订阅刷新已开始");

    private Task TestNodeAsync()
    {
        var node = SelectedNode;
        if (node is null) return Task.CompletedTask;
        return _session.RunAsync($"测速 {node.Name}", async () =>
        {
            await _session.CallAsync(
                "proxies.testNode",
                new IdParams(node.Id),
                AppJsonContext.Default.IdParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
        });
    }

    private Task TestAllAsync() => _session.RunAsync("全部节点测速", async () =>
    {
        await _session.CallAsync(
            "proxies.testAll",
            new EmptyParams(),
            AppJsonContext.Default.EmptyParams,
            AppJsonContext.Default.AgentOperationDto,
            AgentSession.NewCommandId());
    }, "已开始逐个测速，结果会实时回填到节点列表");

    private Task ToggleNodeAsync()
    {
        var node = SelectedNode;
        if (node is null) return Task.CompletedTask;
        return _session.RunAsync(node.Enabled ? $"停用 {node.Name}" : $"启用 {node.Name}", async () =>
        {
            await _session.CallAsync(
                "proxies.setNodeEnabled",
                new ProxyNodeEnabledParams(node.Id, !node.Enabled),
                AppJsonContext.Default.ProxyNodeEnabledParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
        });
    }

    private async Task SaveRuntimeDirectoryAsync()
    {
        var directory = RuntimeDirectory.Trim();
        if (directory.Length == 0)
        {
            _session.Toasts.Error("请输入 Clash Verge 或 mihomo 的安装目录");
            return;
        }
        await _session.RunAsync("设置代理运行目录", async () =>
        {
            await _session.CallAsync(
                "proxies.setRuntimeDirectory",
                new ProxyRuntimeDirectoryParams(directory),
                AppJsonContext.Default.ProxyRuntimeDirectoryParams,
                AppJsonContext.Default.AgentOperationDto,
                AgentSession.NewCommandId());
        }, "运行目录已保存，正在重新检测 mihomo 内核");
    }

    private static string? EmptyToNull(string value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
