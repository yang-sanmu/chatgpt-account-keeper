using System.Text.Json;
using System.Runtime.ExceptionServices;
using System.Text;
using GptAccountKeeper.Desktop.Application;
using GptAccountKeeper.Desktop.Infrastructure.Agent;
using GptAccountKeeper.Desktop.Infrastructure.Ipc;
using GptAccountKeeper.Desktop.Infrastructure.Settings;
using GptAccountKeeper.Desktop.Infrastructure.Updates;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Presentation;
using GptAccountKeeper.Desktop.Presentation.Pages;
using GptAccountKeeper.Desktop.Serialization;
using Xunit;

[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]

namespace GptAccountKeeper.Desktop.Tests;

public sealed class DesktopUsabilityTests
{
    [Fact]
    public async Task ConnectionProbeDoesNotThrowWhenNamedPipeHasNotBeenCreated()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var root = NewTemporaryDirectory();
        var paths = TestPaths(root);
        var endpoint = new AgentEndpoint(
            AgentTransport.NamedPipe,
            $@"\\.\pipe\keeper-probe-unavailable-{Guid.NewGuid():N}");
        await using var connection = new AgentConnectionService(
            endpoint,
            new AgentProcessLauncher(paths, "probe-token"),
            "probe-token",
            paths.DataDirectory);
        var firstChanceTimeouts = 0;
        void OnFirstChance(object? _, FirstChanceExceptionEventArgs args)
        {
            if (args.Exception is TimeoutException)
            {
                Interlocked.Increment(ref firstChanceTimeouts);
            }
        }

        AppDomain.CurrentDomain.FirstChanceException += OnFirstChance;
        try
        {
            var snapshot = await connection.EnsureConnectedAsync(startWhenUnavailable: false);
            Assert.False(snapshot.IsConnected);
            Assert.Contains("尚未就绪", snapshot.Detail);
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= OnFirstChance;
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }

        Assert.Equal(0, Volatile.Read(ref firstChanceTimeouts));
    }

    [Fact]
    public void ProductionLauncherDoesNotUseSourceAgentOrPathNode()
    {
        var root = NewTemporaryDirectory();
        var previousExecutable = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE");
        var previousEntry = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY");
        var previousNode = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_NODE");
        try
        {
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE", null);
            Environment.SetEnvironmentVariable(
                "GPTACCOUNTKEEPER_AGENT_ENTRY",
                Path.Combine(FindRepositoryRoot(), "src", "agent", "launcher.js"));
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_NODE", null);
            var paths = TestPaths(root, development: false);
            var launcher = new AgentProcessLauncher(paths, "production-token");
            var endpoint = OperatingSystem.IsWindows()
                ? new AgentEndpoint(AgentTransport.NamedPipe, $@"\\.\pipe\keeper-production-launch-{Guid.NewGuid():N}")
                : new AgentEndpoint(AgentTransport.UnixDomainSocket, ShortSocketPath("a"));

            var result = launcher.TryStart(endpoint);

            Assert.False(result.Started);
            Assert.Contains("私有 Node", result.Message);
            Assert.False(Directory.Exists(paths.StateDirectory));
        }
        finally
        {
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE", previousExecutable);
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY", previousEntry);
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_NODE", previousNode);
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task AgentActionsFollowThePublishedConnectionState()
    {
        await using var fixture = CreateShellFixture();
        Assert.False(fixture.Shell.IsAgentConnected);
        Assert.Same(Palette.Muted, fixture.Shell.AgentConnectionStatusColor);
        Assert.Equal("启动 Agent", fixture.Shell.AgentActionText);
        Assert.EndsWith(" · AOT", fixture.Shell.DesktopVersion, StringComparison.Ordinal);
        Assert.True(fixture.Shell.StartAgentCommand.CanExecute(null));
        Assert.True(fixture.Shell.ConnectAgentCommand.CanExecute(null));

        fixture.Shell.ApplyConnection(new AgentConnectionSnapshot(
            true,
            "Agent 已连接",
            "test connection",
            "1.0.0",
            Guid.NewGuid().ToString()));

        Assert.True(fixture.Shell.IsAgentConnected);
        Assert.Same(Palette.Ok, fixture.Shell.AgentConnectionStatusColor);
        Assert.Equal("Agent 已连接", fixture.Shell.Overview.ConnectionStatus);
        Assert.Equal("Agent 已连接", fixture.Shell.AgentActionText);
        Assert.False(fixture.Shell.StartAgentCommand.CanExecute(null));
        Assert.False(fixture.Shell.ConnectAgentCommand.CanExecute(null));

        fixture.Shell.ApplyConnection(new AgentConnectionSnapshot(false, "未连接", "test disconnect"));
        Assert.False(fixture.Shell.IsAgentConnected);
        Assert.Same(Palette.Muted, fixture.Shell.AgentConnectionStatusColor);
        Assert.Equal("未连接", fixture.Shell.Overview.ConnectionStatus);
        Assert.Equal("启动 Agent", fixture.Shell.AgentActionText);
        Assert.True(fixture.Shell.StartAgentCommand.CanExecute(null));
    }

    [Fact]
    public async Task UnavailableNamedPipeTimeoutDoesNotUseCancellationException()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var firstChanceCancellations = 0;
        void OnFirstChance(object? _, FirstChanceExceptionEventArgs args)
        {
            if (args.Exception is OperationCanceledException)
            {
                Interlocked.Increment(ref firstChanceCancellations);
            }
        }

        AppDomain.CurrentDomain.FirstChanceException += OnFirstChance;
        try
        {
            await using var client = new AgentIpcClient(new AgentEndpoint(
                AgentTransport.NamedPipe,
                $@"\\.\pipe\keeper-unavailable-{Guid.NewGuid():N}"));
            await Assert.ThrowsAsync<TimeoutException>(() =>
                client.ConnectAsync(TimeSpan.FromMilliseconds(100), CancellationToken.None));
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= OnFirstChance;
        }

        Assert.Equal(0, Volatile.Read(ref firstChanceCancellations));
    }

    [Fact]
    public async Task MigrationProgressReadsCanRunAlongsideJsonlAppendsOnWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var root = NewTemporaryDirectory();
        var file = Path.Combine(root, "migration-progress.json");
        await File.WriteAllTextAsync(file, "{\"state\":\"running\",\"stage\":\"start\",\"message\":\"start\"}\n");
        var firstChanceIoExceptions = 0;
        void OnFirstChance(object? _, FirstChanceExceptionEventArgs args)
        {
            if (args.Exception is IOException)
            {
                Interlocked.Increment(ref firstChanceIoExceptions);
            }
        }

        AppDomain.CurrentDomain.FirstChanceException += OnFirstChance;
        try
        {
            var writer = Task.Run(async () =>
            {
                for (var index = 0; index < 250; index++)
                {
                    await File.AppendAllTextAsync(
                        file,
                        $"{{\"state\":\"running\",\"stage\":\"copy\",\"message\":\"{index}\"}}\n");
                }
            });
            string? lastPayload = null;
            while (!writer.IsCompleted)
            {
                _ = AgentConnectionService.ReadMigrationProgress(file, ref lastPayload, force: true);
                await Task.Yield();
            }
            await writer;
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= OnFirstChance;
            Directory.Delete(root, recursive: true);
        }

        Assert.Equal(0, Volatile.Read(ref firstChanceIoExceptions));
    }

    [Fact]
    public void MigrationProgressParserIgnoresAnIncompleteAppendedRecord()
    {
        const string completed = "{\"state\":\"running\",\"stage\":\"profiles-promoted\",\"message\":\"done\"}";
        var payload = AgentConnectionService.LastCompleteProgressPayload(
            $"{completed}\n{{\"state\":\"succeeded\"");
        Assert.Equal(completed, payload);

        Assert.Equal(
            completed,
            AgentConnectionService.LastCompleteProgressPayload(completed));
    }

    [Fact]
    public void MissingMigrationProcessDoesNotUseArgumentExceptionForControlFlow()
    {
        var firstChanceArgumentExceptions = 0;
        void OnFirstChance(object? _, FirstChanceExceptionEventArgs args)
        {
            if (args.Exception is ArgumentException)
            {
                Interlocked.Increment(ref firstChanceArgumentExceptions);
            }
        }

        AppDomain.CurrentDomain.FirstChanceException += OnFirstChance;
        try
        {
            Assert.False(AgentConnectionService.IsProcessAlive(int.MaxValue));
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= OnFirstChance;
        }

        Assert.Equal(0, Volatile.Read(ref firstChanceArgumentExceptions));
    }

    [Fact]
    public async Task EveryNavigationEntryIsADistinctPage()
    {
        await using var fixture = CreateShellFixture();
        var shell = fixture.Shell;
        var expected = new[] { "overview", "accounts", "operations", "proxies", "conversations", "profiles", "history", "settings" };
        Assert.Equal(expected, shell.Pages.Select(page => page.Key));
        // 每个导航项是一个独立 ViewModel 实例，而不是同一棵可见性树的分支。
        Assert.Equal(expected.Length, shell.Pages.Distinct().Count());
        foreach (var key in expected)
        {
            var page = shell.Pages.Single(item => item.Key == key);
            shell.SelectedPage = page;
            Assert.Same(page, shell.SelectedPage);
            Assert.False(string.IsNullOrWhiteSpace(page.Title));
            Assert.False(string.IsNullOrWhiteSpace(page.Description));
        }
    }

    [Fact]
    public async Task AccountSearchStatusAndGroupFiltersChangeTheDisplayedRows()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts(
            [
                Account("one", note: "alpha", enabled: true, loggedIn: true, groupId: "g1"),
                Account("two", note: "beta", enabled: false, loggedIn: false),
            ],
            [new GroupDto { Id = "g1", Name = "美国组" }]);

        accounts.Search = "alpha";
        Assert.Equal("one", Assert.Single(accounts.Rows).Id);

        accounts.Search = string.Empty;
        accounts.StatusFilter = accounts.StatusFilters.Single(option => option.Value == AccountStatusFilter.Disabled);
        Assert.Equal("two", Assert.Single(accounts.Rows).Id);

        accounts.StatusFilter = accounts.StatusFilters.Single(option => option.Value == AccountStatusFilter.All);
        accounts.GroupFilter = accounts.GroupFilterChoices.Single(choice => choice.Id == "g1");
        Assert.Equal("one", Assert.Single(accounts.Rows).Id);

        // 分组名也参与搜索：用户记得的是"美国组"而不是 g1。
        accounts.GroupFilter = accounts.GroupFilterChoices[0];
        accounts.Search = "美国";
        Assert.Equal("one", Assert.Single(accounts.Rows).Id);
    }

    [Fact]
    public async Task IncrementalStatusAndOpenPageEventsReapplyTheActiveFilter()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts([Account("one"), Account("two", loggedIn: true)], []);

        accounts.StatusFilter = accounts.StatusFilters.Single(
            option => option.Value == AccountStatusFilter.LoggedIn);
        Assert.Equal("two", Assert.Single(accounts.Rows).Id);

        // 隐藏行变为已登录后应进入结果；之前 ApplyStatus 只查可见 Rows，必须全量刷新才出现。
        Assert.True(accounts.ApplyStatus(new AccountStatusEventDto
        {
            Id = "one",
            State = "ok",
            LoggedIn = true,
        }));
        Assert.Equal(["one", "two"], accounts.Rows.Select(row => row.Id).Order());

        // 可见行不再匹配时应立即移除。
        Assert.True(accounts.ApplyStatus(new AccountStatusEventDto
        {
            Id = "two",
            State = "out",
            LoggedIn = false,
        }));
        Assert.Equal("one", Assert.Single(accounts.Rows).Id);

        accounts.StatusFilter = accounts.StatusFilters.Single(
            option => option.Value == AccountStatusFilter.PageOpen);
        Assert.Empty(accounts.Rows);
        Assert.True(accounts.ApplyOpenPage("one", true));
        Assert.Equal("one", Assert.Single(accounts.Rows).Id);
        Assert.True(accounts.ApplyOpenPage("one", false));
        Assert.Empty(accounts.Rows);
    }

    /// <summary>
    /// 核心回归：状态巡检事件每 15 分钟就来一次，不能把用户正在编辑的备注冲掉。
    /// </summary>
    [Fact]
    public async Task RefreshDoesNotDiscardAnInFlightNoteEdit()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts([Account("one", note: "服务端备注")], []);
        var row = Assert.Single(accounts.Rows);

        row.Note = "我正在输入";
        Assert.True(row.HasPendingEdits);

        // 服务端推来一次刷新，同时改了状态和备注。
        accounts.ApplyAccounts(
            [Account("one", note: "别人改的备注", loggedIn: true)],
            []);

        var refreshed = Assert.Single(accounts.Rows);
        Assert.Same(row, refreshed);
        Assert.Equal("我正在输入", refreshed.Note);
        Assert.True(refreshed.LoggedIn);
        Assert.True(refreshed.HasPendingEdits);

        // 保存后以提交值为新基线，草稿变干净。
        refreshed.CommitDraft(Account("one", note: "我正在输入", loggedIn: true));
        Assert.False(refreshed.HasPendingEdits);
        accounts.ApplyAccounts([Account("one", note: "服务端又改了", loggedIn: true)], []);
        Assert.Equal("服务端又改了", Assert.Single(accounts.Rows).Note);
    }

    [Fact]
    public async Task AccountBatchSummaryTracksDirectRowSelectionAndEdits()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts([Account("one")], []);
        var row = Assert.Single(accounts.Rows);

        row.IsSelected = true;
        Assert.Equal(1, accounts.SelectedCount);
        Assert.True(accounts.HasSelection);

        row.Note = "尚未保存";
        Assert.Equal(1, accounts.PendingEditCount);
        Assert.True(accounts.HasPendingEdits);
        Assert.True(accounts.SaveAllEditsCommand.CanExecute(null));
    }

    [Fact]
    public async Task AccountBatchWorkerNeverRunsTwoItemsConcurrently()
    {
        var active = 0;
        var maximum = 0;
        var results = await AccountsPageViewModel.RunSequentiallyAsync(
            new[] { "one", "two", "three" },
            async item =>
            {
                var current = Interlocked.Increment(ref active);
                maximum = Math.Max(maximum, current);
                await Task.Delay(10);
                Interlocked.Decrement(ref active);
                return item;
            });

        Assert.Equal(1, maximum);
        Assert.Equal(["one", "two", "three"], results);
    }

    [Fact]
    public async Task ImmediateGroupSaveDoesNotOverwriteAChangeMadeWhileItIsInFlight()
    {
        var started = new TaskCompletionSource<AccountSaveRequest>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        AccountRowViewModel? row = null;
        var choices = new List<RouteChoiceViewModel>
        {
            new(null, "不分组"),
            new("g1", "第一组"),
        };
        row = new AccountRowViewModel(
            Account("one", note: "旧备注"),
            choices,
            async (candidate, request) =>
            {
                started.TrySetResult(request);
                await release.Task;
                candidate.CommitSubmitted(
                    request,
                    Account("one", note: "旧备注") with { GroupId = request.GroupId });
                finished.TrySetResult(true);
                return true;
            },
            (_, _) => Task.FromResult(true),
            (_, _) => Task.CompletedTask);

        row.SelectedGroup = choices[1];
        var submitted = await started.Task;
        Assert.Equal(AccountSaveFields.Group, submitted.Fields);
        Assert.Null(submitted.Patch.Note);

        row.Note = "请求期间输入的新备注";
        release.SetResult(true);
        await finished.Task;

        Assert.Equal("请求期间输入的新备注", row.Note);
        Assert.True(row.HasPendingEdits);
    }

    /// <summary>
    /// 增量更新必须保留行实例：Clear/Add 会让选中项、滚动位置和勾选状态一起丢失。
    /// </summary>
    [Fact]
    public async Task IncrementalUpdatesPreserveRowInstancesAndSelection()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts([Account("one"), Account("two"), Account("three")], []);
        var second = accounts.Rows.Single(row => row.Id == "two");
        second.IsSelected = true;

        accounts.ApplyAccounts([Account("one"), Account("two", loggedIn: true), Account("three")], []);

        Assert.Same(second, accounts.Rows.Single(row => row.Id == "two"));
        Assert.True(second.IsSelected);
        Assert.True(second.LoggedIn);

        // 删除一个账号只移除那一行。
        var first = accounts.Rows.Single(row => row.Id == "one");
        Assert.True(accounts.RemoveAccount("three"));
        Assert.Equal(["one", "two"], accounts.Rows.Select(row => row.Id));
        Assert.Same(first, accounts.Rows.Single(row => row.Id == "one"));
        Assert.Same(second, accounts.Rows.Single(row => row.Id == "two"));
    }

    [Fact]
    public async Task SchedulerAndOpenPageEventsUpdateOnlyTheAffectedRow()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts([Account("one"), Account("two")], []);
        var first = accounts.Rows.Single(row => row.Id == "one");
        var second = accounts.Rows.Single(row => row.Id == "two");

        var next = DateTimeOffset.Now.AddMinutes(30);
        Assert.True(accounts.ApplySchedule(new SchedulerAccountChangeDto
        {
            AccountId = "one",
            NextAt = next,
            LastResultState = "succeeded",
        }));
        Assert.Equal(next, first.Account.NextRunAt);
        Assert.True(first.Account.LastRunOk);
        Assert.Null(second.Account.NextRunAt);

        Assert.True(accounts.ApplyOpenPage("two", true));
        Assert.True(second.PageOpen);
        Assert.False(first.PageOpen);

        // 未知账号不应静默成功；壳层据此排一次全量同步。
        Assert.False(accounts.ApplyOpenPage("missing", true));
    }

    [Fact]
    public async Task AccountRowsExposeRouteRotationAndStaleState()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts(
            [
                Account("one", loggedIn: true) with
                {
                    Stale = true,
                    GroupId = "g1",
                    GroupName = "美国组",
                    ProxyId = "px1",
                    ProxyName = "US-1",
                    RotationCurrentSet = "C# 架构",
                    RotationWindowsDone = 2,
                    RotationWindowsTarget = 4,
                    CheckedAt = DateTimeOffset.Now.AddMinutes(-3),
                },
            ],
            [new GroupDto { Id = "g1", Name = "美国组", ProxyId = "px1" }]);

        var row = Assert.Single(accounts.Rows);
        Assert.Equal("出口：US-1", row.RouteText);
        Assert.Contains("C# 架构", row.RotationText);
        Assert.Contains("2/4", row.RotationText);
        Assert.Equal(0.5, row.RotationProgress);
        // 旧网页面板的"· 待复核"和相对时间都要在原生端保留。
        Assert.Contains("待复核", row.StatusText);
        Assert.Equal("3 分钟前", row.CheckedAtText);
    }

    [Fact]
    public async Task MissingProxyNodeIsSurfacedOnTheAccountRow()
    {
        await using var fixture = CreateShellFixture();
        var accounts = fixture.Shell.Accounts;
        accounts.ApplyAccounts(
            [Account("one") with { GroupId = "g1", ProxyId = "gone", ProxyMissing = true }],
            [new GroupDto { Id = "g1", Name = "组", ProxyId = "gone" }]);
        Assert.Equal("出口：节点已失效", Assert.Single(accounts.Rows).RouteText);
    }

    [Fact]
    public async Task ProxyTestResultIsWrittenBackOntoTheNodeRow()
    {
        await using var fixture = CreateShellFixture();
        var proxies = fixture.Shell.Proxies;
        proxies.ApplyState(
            new ProxyStateDto
            {
                Nodes =
                [
                    new ProxyNodeDto { Id = "px1", Name = "US-1", Enabled = true, Server = "a.example", Port = 443 },
                    new ProxyNodeDto { Id = "px2", Name = "JP-1", Enabled = true },
                ],
            },
            [],
            []);

        Assert.Equal("未测速", proxies.Nodes.Single(node => node.Id == "px1").LatencyText);
        Assert.Equal("a.example:443", proxies.Nodes.Single(node => node.Id == "px1").ServerText);

        Assert.True(proxies.ApplyNodeTest(new ProxyNodeTestedDto { Id = "px1", Ok = true, Delay = 180 }));
        Assert.Equal("180 ms", proxies.Nodes.Single(node => node.Id == "px1").LatencyText);
        Assert.Equal("未测速", proxies.Nodes.Single(node => node.Id == "px2").LatencyText);

        Assert.True(proxies.ApplyNodeTest(new ProxyNodeTestedDto { Id = "px2", Ok = false, Message = "超时" }));
        Assert.Equal("测速失败", proxies.Nodes.Single(node => node.Id == "px2").LatencyText);
    }

    [Fact]
    public async Task GroupCreateAndEditModesAreDistinct()
    {
        await using var fixture = CreateShellFixture();
        var proxies = fixture.Shell.Proxies;
        proxies.ApplyState(
            new ProxyStateDto(),
            [new GroupDto { Id = "g1", Name = "现有组" }],
            [Account("one") with { GroupId = "g1" }]);

        proxies.SelectedGroup = proxies.Groups.Single();
        Assert.False(proxies.IsCreatingGroup);
        Assert.Equal("现有组", proxies.GroupName);
        Assert.Equal("1 个账号 · 系统网络", proxies.Groups.Single().SummaryText);

        proxies.BeginNewGroupCommand.Execute(null);
        Assert.True(proxies.IsCreatingGroup);
        Assert.Null(proxies.SelectedGroup);
        Assert.Equal(string.Empty, proxies.GroupName);

        // 之前"新建"和"编辑"共用一个表单，点回列表就会静默变成编辑那个分组。
        proxies.SelectedGroup = proxies.Groups.Single();
        Assert.False(proxies.IsCreatingGroup);
        Assert.Contains("现有组", proxies.GroupFormTitle);

        proxies.ApplyState(new ProxyStateDto(), [], []);
        Assert.Null(proxies.SelectedGroup);
        Assert.False(proxies.HasGroups);
    }

    [Fact]
    public async Task RemovedConversationCannotRemainAsAnEditableSelection()
    {
        await using var fixture = CreateShellFixture();
        var conversations = fixture.Shell.Conversations;
        conversations.Apply(new Dictionary<string, ConversationSetDto>
        {
            ["现有主题"] = new() { Topic = "内容", MinRounds = 1, MaxRounds = 2 },
        });
        conversations.Selected = Assert.Single(conversations.Items);
        Assert.True(conversations.CanEdit);

        conversations.Apply(new Dictionary<string, ConversationSetDto>());
        Assert.Null(conversations.Selected);
        Assert.False(conversations.CanEdit);
    }

    [Fact]
    public async Task HistoryEntriesExposeStructuredRounds()
    {
        await using var fixture = CreateShellFixture();
        var entry = new HistoryEntryDto
        {
            Time = DateTimeOffset.Parse("2026-01-01T10:00:00Z"),
            Ok = true,
            SetName = "C# 架构",
            TotalRounds = 2,
            Rounds =
            [
                new HistoryRoundDto { Question = "问题一", Answer = "回答一" },
                new HistoryRoundDto { Question = null, Answer = null },
            ],
        };
        Assert.Equal("成功", entry.ResultText);
        Assert.Equal("C# 架构 · 2 轮", entry.SummaryText);
        Assert.True(entry.HasRounds);
        // 取不到内容时给明确占位，而不是把原始 JSON 铺给用户。
        Assert.Equal("（无提问内容）", entry.Rounds[1].QuestionText);

        var history = fixture.Shell.History;
        history.ApplyAccounts([new HistoryAccountDto { AccountId = "one", EntryCount = 1 }]);
        Assert.Single(history.Accounts);
    }

    [Fact]
    public void LinkedProfileDisplaysItsAccountAndOnlyReportsMultipleLinksAsAnError()
    {
        var linked = new ProfileEntryDto
        {
            Name = "acc_internal_id",
            Linked = true,
            AccountIds = ["acc_internal_id"],
            AccountLabels = ["owner@example.com"],
        };
        var invalidShared = new ProfileEntryDto
        {
            Name = "shared",
            Linked = true,
            AccountIds = ["one", "two"],
            AccountLabels = ["one@example.com", "two@example.com"],
        };
        var unnamed = new ProfileEntryDto
        {
            Name = "acc_internal_id",
            Linked = true,
            AccountIds = ["acc_internal_id"],
        };

        Assert.Equal("owner@example.com", linked.DisplayName);
        Assert.Equal("已关联", linked.StateText);
        Assert.Equal("异常：关联 2 个账号", invalidShared.StateText);
        Assert.Equal("未命名账号", unnamed.DisplayName);
    }

    [Fact]
    public async Task ProfileScanFromAnOlderAgentWithoutAccountLabelsStillOpens()
    {
        await using var fixture = CreateShellFixture();
        using var document = JsonDocument.Parse("""
            {
              "profiles": [
                {
                  "name": "acc_internal_id",
                  "linked": true,
                  "accountIds": ["acc_internal_id"],
                  "busy": false,
                  "bytes": 10,
                  "files": 1,
                  "cacheBytes": 0
                }
              ],
              "orphans": [],
              "totals": { "profiles": 1, "linked": 1, "orphans": 0 }
            }
            """);

        fixture.Shell.Profiles.ApplyAccounts(
        [
            new AccountDto
            {
                Id = "acc_internal_id",
                Email = "owner@example.com",
            },
        ]);
        fixture.Shell.Profiles.ApplyScan(document.RootElement);

        var profile = Assert.Single(fixture.Shell.Profiles.Items);
        Assert.Equal("owner@example.com", profile.DisplayName);
        Assert.Equal("已关联", profile.StateText);
    }

    [Fact]
    public async Task ProfileStopsShowingThePreviousNameAfterTheAccountNameIsCleared()
    {
        await using var fixture = CreateShellFixture();
        using var document = JsonDocument.Parse("""
            {
              "profiles": [
                {
                  "name": "profile-one",
                  "linked": true,
                  "accountIds": ["account-one"],
                  "accountLabels": ["旧名称"],
                  "busy": false,
                  "bytes": 10,
                  "files": 1,
                  "cacheBytes": 0
                }
              ],
              "orphans": [],
              "totals": { "profiles": 1, "linked": 1, "orphans": 0 }
            }
            """);

        fixture.Shell.Profiles.ApplyAccounts(
        [
            new AccountDto { Id = "account-one", Note = "旧名称" },
        ]);
        fixture.Shell.Profiles.ApplyScan(document.RootElement);
        Assert.Equal("旧名称", Assert.Single(fixture.Shell.Profiles.Items).DisplayName);

        fixture.Shell.Profiles.ApplyAccount(new AccountDto { Id = "account-one" });

        Assert.Equal("未命名账号", Assert.Single(fixture.Shell.Profiles.Items).DisplayName);
    }

    [Fact]
    public async Task OperationSnapshotRetainsTerminalFailuresAndFilters()
    {
        await using var fixture = CreateShellFixture();
        var operations = fixture.Shell.Operations;
        operations.ApplySnapshot(
            [
                Operation("op1", "account-run", "succeeded", DateTimeOffset.Parse("2026-01-01T10:00:00Z")),
                Operation("op2", "proxy-test-all", "failed", DateTimeOffset.Parse("2026-01-01T11:00:00Z"),
                    new AgentErrorDto("PROXY_UNAVAILABLE", "没有可测试的启用节点", false, default)),
                Operation("op3", "profile-scan", "running", DateTimeOffset.Parse("2026-01-01T12:00:00Z")),
            ]);

        Assert.Equal(["op3", "op2", "op1"], operations.Items.Select(item => item.Id));
        Assert.Equal("全部节点测速", operations.Items.Single(item => item.Id == "op2").KindText);

        operations.Filter = operations.Filters.Single(option => option.Value == OperationFilter.Failed);
        Assert.Equal("op2", Assert.Single(operations.Items).Id);
        Assert.Equal("PROXY_UNAVAILABLE", operations.Items[0].Error?.Code);

        operations.Filter = operations.Filters.Single(option => option.Value == OperationFilter.Active);
        Assert.Equal("op3", Assert.Single(operations.Items).Id);
    }

    [Fact]
    public async Task AgentSettingsKeepInFlightEditsAcrossARefresh()
    {
        await using var fixture = CreateShellFixture();
        var settings = fixture.Shell.Settings;
        settings.ApplyAgentSettings(new AgentSettingsDto { IntervalMinutes = 180, StatusCheckMinutes = 15 });
        Assert.False(settings.HasPendingEdits);

        settings.IntervalMinutes = 240;
        Assert.True(settings.HasPendingEdits);

        settings.ApplyAgentSettings(new AgentSettingsDto { IntervalMinutes = 90, StatusCheckMinutes = 30 });
        Assert.Equal(240, settings.IntervalMinutes);
        Assert.Equal(30, settings.StatusCheckMinutes);

        settings.IntervalMinutes = 0;
        Assert.True(settings.HasValidationError);
        settings.RevertAgentSettingsCommand.Execute(null);
        Assert.Equal(90, settings.IntervalMinutes);
        Assert.False(settings.HasPendingEdits);
    }

    [Fact]
    public async Task ToastsSurfaceFeedbackAndRetainTheLastMessage()
    {
        await using var fixture = CreateShellFixture();
        var toasts = new ToastHost((_, _) => { });
        toasts.Success("已保存");
        toasts.Error("保存失败 [VALIDATION_FAILED]：窗口范围无效");
        Assert.Equal(2, toasts.Items.Count);
        Assert.Equal(ToastKind.Error, toasts.Items[0].Kind);
        Assert.Contains("VALIDATION_FAILED", toasts.LastMessage);

        // 批量操作不该把界面刷满。
        for (var index = 0; index < 10; index++) toasts.Info($"第 {index} 条");
        Assert.Equal(4, toasts.Items.Count);
        Assert.NotNull(fixture.Shell.Toasts);
    }

    [Fact]
    public async Task CloseChoiceAndWindowPlacementArePersisted()
    {
        await using var fixture = CreateShellFixture();
        await fixture.Shell.Behavior.RememberCloseChoiceAsync(CloseChoice.HideToTray);
        await fixture.Shell.Behavior.SaveWindowPlacementAsync(120, 80, 1280, 840, maximized: true);

        var settings = await new DesktopSettingsStore(fixture.Paths).LoadAsync();
        Assert.Equal(CloseBehavior.MinimizeToTray, settings.CloseBehavior);
        Assert.Equal(120, settings.WindowX);
        Assert.Equal(80, settings.WindowY);
        Assert.Equal(1280, settings.WindowWidth);
        Assert.Equal(840, settings.WindowHeight);
        Assert.True(settings.WindowMaximized);
    }

    [Fact]
    public void SingleInstanceGuardAdmitsOnlyOneOwnerPerDataDirectory()
    {
        var scope = $"single-instance-test-{Guid.NewGuid():N}";
        Assert.True(SingleInstanceGuard.TryAcquire(scope));
        try
        {
            // 同一进程内重复取用是幂等的；跨进程由命名互斥量保证。
            Assert.True(SingleInstanceGuard.TryAcquire(scope));
        }
        finally
        {
            SingleInstanceGuard.Release();
        }
        Assert.True(SingleInstanceGuard.TryAcquire(scope));
        SingleInstanceGuard.Release();
    }

    /// <summary>
    /// macOS 的 sun_path 只有 104 字节，而 Path.GetTempPath() 在 macOS 上是
    /// /var/folders/xx/&lt;32 字符哈希&gt;/T/。开发模式的默认端点原本算出来 106 字节，
    /// 已经越界；生产模式 102 字节，只剩两字节余量。
    /// </summary>
    [Fact]
    public void DefaultUnixEndpointStaysInsideTheSunPathLimit()
    {
        if (OperatingSystem.IsWindows()) return;

        var longDataRoot = Path.Combine(
            "/Users/a-fairly-long-account-name/Library/Application Support",
            "GptAccountKeeper");
        var endpoint = AgentEndpointResolver.ResolveDefault(longDataRoot);

        Assert.Equal(AgentTransport.UnixDomainSocket, endpoint.Transport);
        var bytes = Encoding.UTF8.GetByteCount(endpoint.Address);
        Assert.True(
            bytes < AgentEndpointResolver.UnixSocketPathLimit(),
            $"端点 {bytes} 字节，超出 {AgentEndpointResolver.UnixSocketPathLimit()}：{endpoint.Address}");

        if (OperatingSystem.IsMacOS())
        {
            Assert.StartsWith("/tmp/", endpoint.Address);
            Assert.Equal(104, AgentEndpointResolver.UnixSocketPathLimit());
        }

        Assert.Throws<InvalidOperationException>(
            () => AgentEndpointResolver.EnsureUnixSocketPathFits("/tmp/" + new string('x', 120) + ".sock"));
    }

    [Fact]
    public void SingleInstanceActivationSignalIsScopedToTheDataDirectory()
    {
        if (!OperatingSystem.IsWindows()) return;
        var scope = Path.Combine(Path.GetTempPath(), $"single-instance-activation-{Guid.NewGuid():N}");
        var equivalentScope = scope.ToUpperInvariant();
        var other = Path.Combine(Path.GetTempPath(), $"single-instance-activation-{Guid.NewGuid():N}");
        Assert.NotEqual(scope, equivalentScope);
        Assert.True(SingleInstanceGuard.TryAcquire(scope));
        using var activated = new ManualResetEventSlim();
        try
        {
            SingleInstanceGuard.RegisterActivationHandler(activated.Set);
            Assert.False(SingleInstanceGuard.TrySignalExistingWindow(other));
            Assert.True(SingleInstanceGuard.TrySignalExistingWindow(equivalentScope));
            Assert.True(activated.Wait(TimeSpan.FromSeconds(2)));
        }
        finally
        {
            SingleInstanceGuard.Release();
        }
    }

    [Fact]
    public async Task SafeInstallMonitorStaysAliveBeforeAnUpdateHasDownloaded()
    {
        await using var fixture = CreateShellFixture();
        Assert.False(fixture.Shell.Behavior.CanInstallUpdate);
        fixture.Shell.StartSafeInstallMonitor();
        await Task.Delay(50);
        Assert.True(fixture.Shell.IsSafeInstallMonitorRunning);
    }

    /// <summary>
    /// 启动后必须立刻检查一次，不能再等 30 秒。开发/便携运行下 Velopack 报告
    /// 未安装，首检会落在 portable 状态；关键是它得在启动后很快发生。
    /// </summary>
    [Fact]
    public async Task TheFirstUpdateCheckStartsImmediatelyAtLaunch()
    {
        using var updates = new UpdateService();
        using var checked_ = new ManualResetEventSlim();
        updates.Changed += (_, snapshot) =>
        {
            if (snapshot.State is not "idle") checked_.Set();
        };

        updates.Start(UpdatePolicy.NotifyOnly);

        Assert.True(checked_.Wait(TimeSpan.FromSeconds(10)));
        Assert.NotEqual("idle", updates.Snapshot.State);
        await Task.CompletedTask;
    }

    /// <summary>
    /// 下载完成后再检查一次更新，不能把"可安全安装"降级成"需要再下载一次"。
    /// 这正是"点下载更新、下载完还得再点一次才能安装"的根因。
    /// </summary>
    [Fact]
    public void ARecheckAfterDownloadKeepsTheUpdateInstallable()
    {
        var gate = new UpdateGate();
        gate.MarkDownloaded("1.4.0");

        var recheck = gate.Coalesce(new UpdateSnapshot(
            "available",
            "发现新版本 1.4.0",
            "1.4.0",
            CanDownload: true));

        Assert.Equal("downloaded", recheck.State);
        Assert.True(recheck.CanInstall);
    }

    /// <summary>Velopack 的进度回调是异步的，迟到那一次不能把状态推回 downloading。</summary>
    [Fact]
    public void ALateDownloadProgressCallbackDoesNotRevokeInstallability()
    {
        var gate = new UpdateGate();
        gate.MarkDownloaded("1.4.0");

        var late = gate.Coalesce(new UpdateSnapshot("downloading", "正在下载 1.4.0 · 99%", "1.4.0", 99));

        Assert.Equal("downloaded", late.State);
        Assert.True(late.CanInstall);
        Assert.Equal(100, late.Progress);
    }

    /// <summary>
    /// 每 6 小时一轮的后台检查会先发 checking、失败时再发 error，两者都不带版本号。
    /// 它们不能把已下载的更新变成不可安装 —— 否则一次断网就让"安全安装"永久变灰。
    /// </summary>
    [Fact]
    public void VersionlessCheckingAndErrorStatesKeepADownloadedUpdateInstallable()
    {
        var gate = new UpdateGate();
        gate.MarkDownloaded("1.4.0");

        var checking = gate.Coalesce(new UpdateSnapshot("checking", "正在后台检查更新…"));
        Assert.True(checking.CanInstall);
        Assert.Equal("1.4.0", checking.Version);

        var failed = gate.Coalesce(new UpdateSnapshot("error", "更新检查失败：网络不可达"));
        Assert.True(failed.CanInstall);
        // 错误信息必须保留，用户要靠它判断是不是断网。
        Assert.Contains("网络不可达", failed.Message);
    }

    [Fact]
    public void ANewerVersionIsStillOfferedForDownloadAfterAnEarlierOneWasStaged()
    {
        var gate = new UpdateGate();
        gate.MarkDownloaded("1.4.0");

        var newer = gate.Coalesce(new UpdateSnapshot(
            "available",
            "发现新版本 1.5.0",
            "1.5.0",
            CanDownload: true));

        Assert.Equal("available", newer.State);
        Assert.True(newer.CanDownload);
        Assert.False(newer.CanInstall);
    }

    [Fact]
    public void IgnoringAVersionSuppressesOnlyThatVersionAndNeverAManualCheck()
    {
        var gate = new UpdateGate();
        gate.Ignore("1.4.0");

        Assert.False(gate.ShouldPrompt("1.4.0", manual: false));
        Assert.True(gate.ShouldPrompt("1.5.0", manual: false));
        // 手动点“检查更新”必须仍然给出提示，否则界面上什么都不发生。
        Assert.True(gate.ShouldPrompt("1.4.0", manual: true));
    }

    /// <summary>
    /// 只有真的要弹窗时才能记 MarkPrompted。之前是先记后下载，"后台下载后提醒"
    /// 策略下一次下载异常就会让这个版本在本次会话里再也不提示。
    /// </summary>
    [Fact]
    public void AVersionIsStillPromptableUntilItHasActuallyBeenPrompted()
    {
        var gate = new UpdateGate();
        // 预下载失败的那条路径不调用 MarkPrompted，提示资格必须还在。
        Assert.True(gate.ShouldPrompt("1.4.0", manual: false));
        gate.MarkPrompted("1.4.0");
        Assert.False(gate.ShouldPrompt("1.4.0", manual: false));
    }

    /// <summary>“下次启动提醒”只压制本次会话：新的 UpdateGate 代表新进程。</summary>
    [Fact]
    public void DeferringAVersionSuppressesThisSessionOnly()
    {
        var session = new UpdateGate();
        session.Defer("1.4.0");
        Assert.False(session.ShouldPrompt("1.4.0", manual: false));

        var nextLaunch = new UpdateGate();
        Assert.True(nextLaunch.ShouldPrompt("1.4.0", manual: false));
    }

    /// <summary>自动检查只在同一版本第一次出现时弹窗，之后每 6 小时一轮不再重复打扰。</summary>
    [Fact]
    public void AnAutomaticRecheckDoesNotPromptTwiceForTheSameVersion()
    {
        var gate = new UpdateGate();
        Assert.True(gate.ShouldPrompt("1.4.0", manual: false));
        gate.MarkPrompted("1.4.0");
        Assert.False(gate.ShouldPrompt("1.4.0", manual: false));
    }

    [Fact]
    public void ConfirmingThereIsNoUpdateClearsThePendingInstall()
    {
        var gate = new UpdateGate();
        gate.MarkDownloaded("1.4.0");
        gate.ClearDownloaded();

        var snapshot = gate.Coalesce(new UpdateSnapshot(
            "available",
            "发现新版本 1.4.0",
            "1.4.0",
            CanDownload: true));

        Assert.Equal("available", snapshot.State);
    }

    /// <summary>忽略的版本号要落到 desktop.json，否则重启后又会弹同一个版本。</summary>
    [Fact]
    public async Task TheIgnoredUpdateVersionAndPendingImportSurviveARestart()
    {
        var root = NewTemporaryDirectory();
        try
        {
            var store = new DesktopSettingsStore(TestPaths(root));
            await store.SaveAsync(new DesktopSettings
            {
                IgnoredUpdateVersion = "1.4.0",
                PendingLegacyImportRoot = Path.Combine(root, "legacy"),
            });

            var reloaded = await store.LoadAsync();

            Assert.Equal("1.4.0", reloaded.IgnoredUpdateVersion);
            Assert.Equal(Path.Combine(root, "legacy"), reloaded.PendingLegacyImportRoot);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DisablingStartupToleratesAMissingRegistrationDirectory()
    {
        var root = NewTemporaryDirectory();
        try
        {
            var registration = Path.Combine(root, "missing", "autostart", "keeper.desktop");

            StartupRegistrationService.DeleteIfPresent(registration);

            Assert.False(File.Exists(registration));
            Assert.False(Directory.Exists(Path.GetDirectoryName(registration)));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DisablingStartupRemovesAnExistingRegistration()
    {
        var root = NewTemporaryDirectory();
        try
        {
            var registration = Path.Combine(root, "autostart", "keeper.desktop");
            Directory.CreateDirectory(Path.GetDirectoryName(registration)!);
            File.WriteAllText(registration, "registration");

            StartupRegistrationService.DeleteIfPresent(registration);

            Assert.False(File.Exists(registration));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LinuxAppImageStartupUsesTheStableImagePath()
    {
        var appImage = Path.GetFullPath(
            Path.Combine(Path.GetTempPath(), "Applications", "ChatGPT Account Keeper.AppImage"));
        var resolved = StartupRegistrationService.ResolveExecutableForStartup(
            "/tmp/.mount_keeper/usr/bin/GptAccountKeeper.Desktop",
            appImage,
            isLinux: true);

        Assert.Equal(appImage, resolved);
    }

    [Fact]
    public void NonAppImageStartupUsesTheProcessPath()
    {
        const string processPath = "/opt/gpt-account-keeper/GptAccountKeeper.Desktop";
        Assert.Equal(
            processPath,
            StartupRegistrationService.ResolveExecutableForStartup(
                processPath,
                appImagePath: null,
                isLinux: true));
    }

    [Fact]
    public void DesktopExecEscapesQuotedAndFieldCodeCharacters()
    {
        Assert.Equal(
            "/home/user/Cost\\$5/100%%/\\`keeper\\`/\\\"app\\\"",
            StartupRegistrationService.EscapeDesktopExecArgument(
                "/home/user/Cost$5/100%/`keeper`/\"app\""));
    }

    /// <summary>
    /// 首次启动没导入不该变成"永远不能导入"：数据目录已建库时导入入口仍然存在，
    /// 只是要先安排一个新的数据目录，重启后继续。
    /// </summary>
    [Fact]
    public async Task LegacyImportRemainsReachableAfterTheDataDirectoryHasBeenInitialized()
    {
        await using var fixture = CreateShellFixture();
        Directory.CreateDirectory(Path.GetDirectoryName(fixture.Paths.DatabaseFile)!);
        await File.WriteAllBytesAsync(fixture.Paths.DatabaseFile, []);
        Assert.True(fixture.Shell.DataDirectoryInitialized);
        Assert.NotNull(fixture.Shell.Settings.ImportLegacyCommand);

        var legacy = Path.Combine(fixture.Paths.DataDirectory, "..", "legacy-source");
        Directory.CreateDirectory(legacy);
        var target = Path.Combine(Path.GetFullPath(Path.Combine(fixture.Paths.DataDirectory, "..")), "imported-data");
        var restartRequested = 0;
        fixture.Shell.DataDirectoryRestartRequested += (_, _) => Interlocked.Increment(ref restartRequested);

        await fixture.Shell.Behavior.LoadAsync(fixture.Shell.Lifetime);
        await fixture.Shell.ScheduleLegacyImportAsync(Path.GetFullPath(legacy), target);

        Assert.Equal(1, Volatile.Read(ref restartRequested));
        var settings = await new DesktopSettingsStore(fixture.Paths).LoadAsync();
        Assert.Equal(Path.GetFullPath(legacy), settings.PendingLegacyImportRoot);
        var pointer = await File.ReadAllTextAsync(fixture.Paths.BootstrapFile);
        Assert.Contains("imported-data", pointer);
    }

    /// <summary>安排导入时绝不能选中当前目录：那会让迁移撞上已存在的 keeper.db。</summary>
    [Fact]
    public async Task SchedulingALegacyImportRefusesToReuseTheCurrentDataDirectory()
    {
        await using var fixture = CreateShellFixture();
        Directory.CreateDirectory(Path.GetDirectoryName(fixture.Paths.DatabaseFile)!);
        await File.WriteAllBytesAsync(fixture.Paths.DatabaseFile, []);
        var legacy = Path.Combine(Path.GetFullPath(Path.Combine(fixture.Paths.DataDirectory, "..")), "legacy-same");
        Directory.CreateDirectory(legacy);
        var restartRequested = 0;
        fixture.Shell.DataDirectoryRestartRequested += (_, _) => Interlocked.Increment(ref restartRequested);

        await fixture.Shell.Behavior.LoadAsync(fixture.Shell.Lifetime);
        await fixture.Shell.ScheduleLegacyImportAsync(legacy, fixture.Paths.DataDirectory);

        Assert.Equal(0, Volatile.Read(ref restartRequested));
        Assert.False(File.Exists(fixture.Paths.BootstrapFile));
    }

    /// <summary>
    /// 重启到新数据目录后，导入任务要被自动接着做，并且必须先从 desktop.json 清除，
    /// 否则一旦导入失败就会每次启动都重试同一个目录。
    /// </summary>
    [Fact]
    public async Task APendingLegacyImportResumesOnceAndIsClearedBeforeRunning()
    {
        await using var fixture = CreateShellFixture();
        var legacy = Path.Combine(Path.GetFullPath(Path.Combine(fixture.Paths.DataDirectory, "..")), "legacy-resume");
        Directory.CreateDirectory(legacy);
        await new DesktopSettingsStore(fixture.Paths).SaveAsync(new DesktopSettings
        {
            PendingLegacyImportRoot = legacy,
        });

        var resumed = new List<string>();
        fixture.Shell.LegacyImportResumeRequested += (_, root) => resumed.Add(root);
        await fixture.Shell.InitializeAsync();

        Assert.Equal([legacy], resumed);
        Assert.True(fixture.Shell.Overview.NeedsFirstRun);
        var settings = await new DesktopSettingsStore(fixture.Paths).LoadAsync();
        Assert.Null(settings.PendingLegacyImportRoot);
    }

    /// <summary>
    /// 待导入目录里已经有 keeper.db 时必须放弃这次导入。迁移本身也会拒绝，
    /// 但那要等到 Agent 启动之后；提前挡掉可以不打扰用户的现有数据。
    /// </summary>
    [Fact]
    public async Task APendingLegacyImportIsAbandonedWhenTheTargetIsAlreadyInitialized()
    {
        await using var fixture = CreateShellFixture();
        var previousExecutable = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE");
        try
        {
            var legacy = Path.Combine(Path.GetFullPath(Path.Combine(fixture.Paths.DataDirectory, "..")), "legacy-occupied");
            Directory.CreateDirectory(legacy);
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.Paths.DatabaseFile)!);
            await File.WriteAllBytesAsync(fixture.Paths.DatabaseFile, []);
            await new DesktopSettingsStore(fixture.Paths).SaveAsync(new DesktopSettings
            {
                PendingLegacyImportRoot = legacy,
            });
            // 放弃导入后 InitializeAsync 会继续走"已建库"分支去连 Agent，
            // 那会真的拉起一个 node 进程并在测试结束后残留，它加载的
            // better-sqlite3 原生模块会让后续 npm ci 无法删除文件。
            // 指向不存在的可执行文件，让启动这一步干净地失败。
            Environment.SetEnvironmentVariable(
                "GPTACCOUNTKEEPER_AGENT_EXECUTABLE",
                Path.Combine(Path.GetDirectoryName(fixture.Paths.ConfigurationDirectory)!, "missing-agent.exe"));

            var resumed = 0;
            fixture.Shell.LegacyImportResumeRequested += (_, _) => Interlocked.Increment(ref resumed);
            await fixture.Shell.InitializeAsync();

            Assert.Equal(0, Volatile.Read(ref resumed));
            Assert.False(fixture.Shell.IsAgentConnected);
            var settings = await new DesktopSettingsStore(fixture.Paths).LoadAsync();
            Assert.Null(settings.PendingLegacyImportRoot);
        }
        finally
        {
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE", previousExecutable);
        }
    }

    /// <summary>“立即更新”要一步走完：尚未下载时先下载，然后直接进入安装流程。</summary>
    [Fact]
    public async Task ChoosingUpdateNowDownloadsAndInstallsWithoutASecondClick()
    {
        await using var fixture = CreateShellFixture();
        var installs = 0;
        fixture.Shell.Behavior.InstallRequested = () =>
        {
            Interlocked.Increment(ref installs);
            return Task.CompletedTask;
        };
        fixture.Shell.Behavior.UpdatePromptRequested = _ => Task.FromResult(UpdateChoice.UpdateNow);

        await fixture.Shell.Behavior.HandleUpdatePromptAsync(
            new UpdatePrompt("1.4.0", Manual: true, AlreadyDownloaded: true));

        Assert.Equal(1, Volatile.Read(ref installs));
    }

    /// <summary>
    /// 一次“立即更新”的下载可能跨过下一轮后台检查。第二个提示不能叠出第二个
    /// 模态窗，否则第一个会被挡在后面，界面看起来像卡住了。
    /// </summary>
    [Fact]
    public async Task ASecondUpdatePromptIsSuppressedWhileTheFirstDialogIsStillOpen()
    {
        await using var fixture = CreateShellFixture();
        var opened = 0;
        var firstDialogShown = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        fixture.Shell.Behavior.InstallRequested = () => Task.CompletedTask;
        fixture.Shell.Behavior.UpdatePromptRequested = async _ =>
        {
            if (Interlocked.Increment(ref opened) == 1) firstDialogShown.TrySetResult();
            await release.Task;
            return UpdateChoice.Dismiss;
        };

        var first = fixture.Shell.Behavior.HandleUpdatePromptAsync(
            new UpdatePrompt("1.4.0", Manual: false, AlreadyDownloaded: false));
        await firstDialogShown.Task.WaitAsync(TimeSpan.FromSeconds(10));

        // 加了闩之后这一次会立刻返回；没有闩时它会停在第二个对话框上，
        // 所以这里必须限时等待，让缺陷表现为断言失败而不是整个测试挂住。
        var second = fixture.Shell.Behavior.HandleUpdatePromptAsync(
            new UpdatePrompt("1.4.0", Manual: false, AlreadyDownloaded: false));
        var returnedImmediately = second == await Task.WhenAny(second, Task.Delay(TimeSpan.FromSeconds(2)));

        release.TrySetResult();
        await first;
        Assert.True(returnedImmediately, "第二次提示应当立即返回，而不是再开一个模态窗");
        Assert.Equal(1, Volatile.Read(ref opened));
    }

    [Fact]
    public async Task ChoosingIgnorePersistsTheVersionAndSkipsInstalling()
    {
        await using var fixture = CreateShellFixture();
        var installs = 0;
        fixture.Shell.Behavior.InstallRequested = () =>
        {
            Interlocked.Increment(ref installs);
            return Task.CompletedTask;
        };
        fixture.Shell.Behavior.UpdatePromptRequested = _ => Task.FromResult(UpdateChoice.IgnoreThisVersion);
        await fixture.Shell.Behavior.LoadAsync(fixture.Shell.Lifetime);

        await fixture.Shell.Behavior.HandleUpdatePromptAsync(
            new UpdatePrompt("1.4.0", Manual: false, AlreadyDownloaded: false));

        Assert.Equal(0, Volatile.Read(ref installs));
        var settings = await new DesktopSettingsStore(fixture.Paths).LoadAsync();
        Assert.Equal("1.4.0", settings.IgnoredUpdateVersion);
    }

    [Fact]
    public void DefaultAgentEndpointIsScopedToTheCanonicalDataDirectory()
    {
        var root = Path.Combine(Path.GetTempPath(), $"keeper-endpoint-{Guid.NewGuid():N}");
        var same = Path.Combine(root, ".", "data");
        var other = Path.Combine(root, "other-data");

        Assert.Equal(
            AgentEndpointResolver.ResolveDefault(Path.Combine(root, "data")),
            AgentEndpointResolver.ResolveDefault(same));
        Assert.NotEqual(
            AgentEndpointResolver.ResolveDefault(Path.Combine(root, "data")),
            AgentEndpointResolver.ResolveDefault(other));
    }

    [Fact]
    public void DefaultDataDirectoryCanKeepTheV1EndpointDuringAgentUpgrade()
    {
        var root = Path.Combine(Path.GetTempPath(), $"keeper-endpoint-upgrade-{Guid.NewGuid():N}");
        var scoped = AgentEndpointResolver.ResolveDefault(root);
        var compatible = AgentEndpointResolver.ResolveDefault(root, useLegacyEndpoint: true);

        Assert.NotEqual(scoped.Address, compatible.Address);
        Assert.False(scoped.UseLegacyHandshake);
        Assert.True(compatible.UseLegacyHandshake);
    }

    [Fact]
    public void CollectionSyncMovesReordersWithoutRebuildingItems()
    {
        var target = new System.Collections.ObjectModel.ObservableCollection<AccountDto>();
        var one = Account("one");
        var two = Account("two");
        var three = Account("three");
        CollectionSync.Apply(target, [one, two, three], account => account.Id);
        Assert.Equal(["one", "two", "three"], target.Select(item => item.Id));

        CollectionSync.Apply(target, [three, one, two], account => account.Id);
        Assert.Equal(["three", "one", "two"], target.Select(item => item.Id));
        Assert.Same(one, target.Single(item => item.Id == "one"));

        CollectionSync.Apply(target, [one], account => account.Id);
        Assert.Same(one, Assert.Single(target));
    }

    private static AccountDto Account(
        string id,
        string? note = null,
        bool enabled = true,
        bool loggedIn = false,
        string? groupId = null) => new()
        {
            Id = id,
            Note = note,
            Enabled = enabled,
            LoggedIn = loggedIn,
            GroupId = groupId,
            SwitchRule = "random",
            MinWindows = 1,
            MaxWindows = 3,
        };

    private static AgentOperationDto Operation(
        string id,
        string kind,
        string state,
        DateTimeOffset startedAt,
        AgentErrorDto? error = null) => new()
        {
            Id = id,
            Kind = kind,
            State = state,
            StartedAt = startedAt,
            UpdatedAt = startedAt,
            Error = error,
        };

    [Fact]
    public async Task BootstrapPointerIsWrittenAtomicallyWithCamelCaseContract()
    {
        var root = NewTemporaryDirectory();
        try
        {
            var paths = TestPaths(root);
            var target = Path.Combine(root, "chosen-data");
            var service = new DataLocationService(paths);
            await service.SaveAsync(target);
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(paths.BootstrapFile));
            Assert.Equal(1, document.RootElement.GetProperty("version").GetInt32());
            Assert.Equal(Path.GetFullPath(target), document.RootElement.GetProperty("dataRoot").GetString());
            Assert.Empty(Directory.GetFiles(paths.ConfigurationDirectory, "*.tmp"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task NativeClientCompletesPrimaryWorkflowsAgainstTheSourceAgent()
    {
        var root = NewTemporaryDirectory();
        var paths = TestPaths(root);
        var endpoint = OperatingSystem.IsWindows()
            ? new AgentEndpoint(AgentTransport.NamedPipe, $@"\\.\pipe\keeper-desktop-integration-{Guid.NewGuid():N}")
            : new AgentEndpoint(AgentTransport.UnixDomainSocket, ShortSocketPath("a"));
        var entry = Path.Combine(FindRepositoryRoot(), "src", "agent", "launcher.js");
        var previousEntry = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY");
        Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY", entry);
        var connection = new AgentConnectionService(
            endpoint,
            new AgentProcessLauncher(paths, "integration-token"),
            "integration-token",
            paths.DataDirectory);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var connected = await connection.EnsureConnectedAsync(true, timeout.Token);
            Assert.True(connected.IsConnected, connected.Detail);

            var initial = await connection.CallAsync(
                "system.bootstrap",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.AgentBootstrapResult,
                timeout.Token);
            Assert.Empty(initial.Accounts);

            var group = await connection.CallAsync(
                "groups.create",
                new GroupCreateParams("integration", null, "Asia/Shanghai", "zh-CN"),
                AppJsonContext.Default.GroupCreateParams,
                AppJsonContext.Default.GroupDto,
                timeout.Token,
                Guid.NewGuid().ToString());
            var account = await connection.CallAsync(
                "accounts.create",
                new AccountCreateParams("desktop integration"),
                AppJsonContext.Default.AccountCreateParams,
                AppJsonContext.Default.AccountDto,
                timeout.Token,
                Guid.NewGuid().ToString());
            var updated = await connection.CallAsync(
                "accounts.update",
                new AccountUpdateParams(account.Id, new AccountPatchDto { GroupId = group.Id, MinWindows = 2, MaxWindows = 4 }),
                AppJsonContext.Default.AccountUpdateParams,
                AppJsonContext.Default.AccountDto,
                timeout.Token,
                Guid.NewGuid().ToString());
            Assert.Equal(group.Id, updated.GroupId);

            var conversation = await connection.CallAsync(
                "conversations.upsert",
                new ConversationUpsertParams("integration", new ConversationSetDto { Topic = "integration topic", MinRounds = 2, MaxRounds = 3 }),
                AppJsonContext.Default.ConversationUpsertParams,
                AppJsonContext.Default.ConversationSetDto,
                timeout.Token,
                Guid.NewGuid().ToString());
            Assert.Equal("integration topic", conversation.Topic);

            var settings = await connection.CallAsync(
                "settings.update",
                new SettingsUpdateParams(new AgentSettingsPatchDto
                {
                    IntervalMinutes = 120,
                    JitterMinutes = 15,
                    Headless = true,
                    StatusCheckMinutes = 20,
                    StatusCheckOnStartup = false,
                    OpenPageTimeoutMinutes = 0,
                    ProfileAutoCleanEnabled = true,
                }),
                AppJsonContext.Default.SettingsUpdateParams,
                AppJsonContext.Default.AgentSettingsDto,
                timeout.Token,
                Guid.NewGuid().ToString());
            Assert.Equal(120, settings.IntervalMinutes);

            var scheduler = await connection.CallAsync(
                "scheduler.getState",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.SchedulerStateDto,
                timeout.Token);
            Assert.False(scheduler.Running);
            var proxyState = await connection.CallAsync(
                "proxies.getState",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.ProxyStateDto,
                timeout.Token);
            Assert.Empty(proxyState.Nodes);
            var historyAccounts = await connection.CallAsync(
                "history.listAccounts",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.HistoryAccountDtoArray,
                timeout.Token);
            Assert.Empty(historyAccounts);

            var operation = await connection.CallAsync(
                "profiles.scan",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.AgentOperationDto,
                timeout.Token,
                Guid.NewGuid().ToString());
            while (operation.State is not ("succeeded" or "failed" or "timed_out" or "cancelled"))
            {
                await Task.Delay(50, timeout.Token);
                operation = await connection.CallAsync(
                    "operations.get",
                    new IdParams(operation.Id),
                    AppJsonContext.Default.IdParams,
                    AppJsonContext.Default.AgentOperationDto,
                    timeout.Token);
            }
            Assert.Equal("succeeded", operation.State);

            var final = await connection.CallAsync(
                "system.bootstrap",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.AgentBootstrapResult,
                timeout.Token);
            Assert.Single(final.Accounts);
            Assert.Single(final.Groups);
            Assert.True(final.Conversations.ContainsKey("integration"));

            await connection.CallAsync(
                "system.shutdown",
                new ShutdownParams("user-exit-all"),
                AppJsonContext.Default.ShutdownParams,
                AppJsonContext.Default.AcceptedResult,
                timeout.Token,
                Guid.NewGuid().ToString());
            await connection.WaitForDisconnectAsync(TimeSpan.FromSeconds(10), timeout.Token);
        }
        finally
        {
            await connection.DisposeAsync();
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY", previousEntry);
            for (var attempt = 0; attempt < 20 && Directory.Exists(root); attempt++)
            {
                try { Directory.Delete(root, recursive: true); }
                catch (IOException) { await Task.Delay(100); }
                catch (UnauthorizedAccessException) { await Task.Delay(100); }
            }
        }
    }

    [Fact]
    public async Task ExitAllReconnectsBeforeStoppingAnExistingAgent()
    {
        var root = NewTemporaryDirectory();
        var paths = TestPaths(root);
        var endpoint = OperatingSystem.IsWindows()
            ? new AgentEndpoint(AgentTransport.NamedPipe, $@"\\.\pipe\keeper-exit-all-integration-{Guid.NewGuid():N}")
            : new AgentEndpoint(AgentTransport.UnixDomainSocket, ShortSocketPath("x"));
        var previousEntry = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY");
        Environment.SetEnvironmentVariable(
            "GPTACCOUNTKEEPER_AGENT_ENTRY",
            Path.Combine(FindRepositoryRoot(), "src", "agent", "launcher.js"));

        var ownerConnection = new AgentConnectionService(
            endpoint,
            new AgentProcessLauncher(paths, "exit-all-token"),
            "exit-all-token",
            paths.DataDirectory);
        var lifecycleConnection = new AgentConnectionService(
            endpoint,
            new AgentProcessLauncher(paths, "exit-all-token"),
            "exit-all-token",
            paths.DataDirectory);
        using var updates = new UpdateService();
        var shell = new ShellViewModel(
            lifecycleConnection,
            new DesktopSettingsStore(paths),
            new DataLocationService(paths),
            new StartupRegistrationService(),
            updates,
            paths);

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var started = await ownerConnection.EnsureConnectedAsync(true, timeout.Token);
            Assert.True(started.IsConnected, started.Detail);
            Assert.False(lifecycleConnection.IsConnected);

            var activity = await shell.GetActivityAsync();
            Assert.NotNull(activity);
            Assert.True(lifecycleConnection.IsConnected);

            await shell.ShutdownAgentAsync();
            await ownerConnection.WaitForDisconnectAsync(TimeSpan.FromSeconds(10), timeout.Token);
            Assert.False(lifecycleConnection.IsConnected);
        }
        finally
        {
            shell.Stop();
            await lifecycleConnection.DisposeAsync();
            await ownerConnection.DisposeAsync();
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY", previousEntry);
            for (var attempt = 0; attempt < 20 && Directory.Exists(root); attempt++)
            {
                try { Directory.Delete(root, recursive: true); }
                catch (IOException) { await Task.Delay(100); }
                catch (UnauthorizedAccessException) { await Task.Delay(100); }
            }
        }
    }

    [Fact]
    public async Task ExitLifecycleDoesNotStartAnUnavailableAgent()
    {
        await using var fixture = CreateShellFixture();
        var previousExecutable = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE");
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.Paths.DatabaseFile)!);
            await File.WriteAllBytesAsync(fixture.Paths.DatabaseFile, []);
            Environment.SetEnvironmentVariable(
                "GPTACCOUNTKEEPER_AGENT_EXECUTABLE",
                Path.Combine(Path.GetDirectoryName(fixture.Paths.ConfigurationDirectory)!, "missing-agent.exe"));

            Assert.Null(await fixture.Shell.GetActivityAsync());
            await fixture.Shell.ShutdownAgentAsync();

            Assert.False(fixture.Shell.IsAgentConnected);
            Assert.False(Directory.Exists(fixture.Paths.StateDirectory));
        }
        finally
        {
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_EXECUTABLE", previousExecutable);
        }
    }

    [Fact]
    public async Task NativeClientPreviewsAndImportsALegacyProjectWithoutMutatingIt()
    {
        var root = NewTemporaryDirectory();
        var source = Path.Combine(root, "legacy");
        var paths = TestPaths(Path.Combine(root, "desktop"));
        WriteLegacyFixture(source);
        var endpoint = OperatingSystem.IsWindows()
            ? new AgentEndpoint(AgentTransport.NamedPipe, $@"\\.\pipe\keeper-migration-integration-{Guid.NewGuid():N}")
            : new AgentEndpoint(AgentTransport.UnixDomainSocket, ShortSocketPath("m"));
        var previousEntry = Environment.GetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY");
        Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY", Path.Combine(FindRepositoryRoot(), "src", "agent", "launcher.js"));
        var connection = new AgentConnectionService(
            endpoint,
            new AgentProcessLauncher(paths, "migration-token"),
            "migration-token",
            paths.DataDirectory);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var preview = await connection.InspectLegacyAsync(Path.Combine(source, "profiles"), timeout.Token);
            Assert.True(preview.Ok, preview.Error?.Message);
            Assert.True(preview.SelectedProfilesDirectory);
            Assert.Equal(1, preview.Counts.Accounts);
            Assert.Equal(1, preview.Counts.Profiles);
            Assert.Equal(2, preview.Counts.Histories);

            // Reproduce the reported sequence exactly: starting the Agent once creates
            // keeper.db, and shutdown leaves normal bookkeeping behind. Import must still
            // recognize that the database has no business data and reuse this directory.
            var initialized = await connection.EnsureConnectedAsync(true, timeout.Token);
            Assert.True(initialized.IsConnected, initialized.Detail);
            await connection.CallAsync(
                "system.shutdown",
                new ShutdownParams("legacy-import"),
                AppJsonContext.Default.ShutdownParams,
                AppJsonContext.Default.AcceptedResult,
                timeout.Token,
                Guid.NewGuid().ToString());
            await connection.WaitForDisconnectAsync(TimeSpan.FromSeconds(10), timeout.Token);
            Assert.True(File.Exists(paths.DatabaseFile));

            var migrationFirstChanceCancellations = 0;
            void OnMigrationFirstChance(object? _, FirstChanceExceptionEventArgs args)
            {
                if (args.Exception is OperationCanceledException)
                {
                    Interlocked.Increment(ref migrationFirstChanceCancellations);
                }
            }

            AppDomain.CurrentDomain.FirstChanceException += OnMigrationFirstChance;
            AgentConnectionSnapshot connected;
            try
            {
                connected = await connection.StartWithLegacyMigrationAsync(source, timeout.Token);
            }
            finally
            {
                AppDomain.CurrentDomain.FirstChanceException -= OnMigrationFirstChance;
            }

            Assert.True(connected.IsConnected, connected.Detail);
            Assert.Equal(0, Volatile.Read(ref migrationFirstChanceCancellations));
            var bootstrap = await connection.CallAsync(
                "system.bootstrap",
                new EmptyParams(),
                AppJsonContext.Default.EmptyParams,
                AppJsonContext.Default.AgentBootstrapResult,
                timeout.Token);
            Assert.Equal("legacy-account", Assert.Single(bootstrap.Accounts).Id);
            Assert.Contains(bootstrap.HistoryAccounts, item => item.AccountId == "deleted-account" && item.Deleted);
            Assert.True(File.Exists(Path.Combine(paths.DataDirectory, "profiles", "legacy-account", "Default", "Cookies")));
            Assert.False(File.Exists(Path.Combine(paths.DataDirectory, "profiles", "legacy-account", "DevToolsActivePort")));
            Assert.True(File.Exists(Path.Combine(source, "profiles", "legacy-account", "DevToolsActivePort")));
        }
        finally
        {
            if (connection.IsConnected)
            {
                using var shutdownTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try
                {
                    await connection.CallAsync(
                        "system.shutdown",
                        new ShutdownParams("user-exit-all"),
                        AppJsonContext.Default.ShutdownParams,
                        AppJsonContext.Default.AcceptedResult,
                        shutdownTimeout.Token,
                        Guid.NewGuid().ToString());
                    await connection.WaitForDisconnectAsync(TimeSpan.FromSeconds(5), shutdownTimeout.Token);
                }
                catch (Exception) when (shutdownTimeout.IsCancellationRequested)
                {
                }
            }
            await connection.DisposeAsync();
            Environment.SetEnvironmentVariable("GPTACCOUNTKEEPER_AGENT_ENTRY", previousEntry);
            for (var attempt = 0; attempt < 20 && Directory.Exists(root); attempt++)
            {
                try { Directory.Delete(root, recursive: true); }
                catch (IOException) { await Task.Delay(100); }
                catch (UnauthorizedAccessException) { await Task.Delay(100); }
            }
        }
    }

    private static ShellFixture CreateShellFixture()
    {
        var root = NewTemporaryDirectory();
        var paths = TestPaths(root);
        var endpoint = new AgentEndpoint(AgentTransport.NamedPipe, @"\\.\pipe\keeper-desktop-test");
        var launcher = new AgentProcessLauncher(paths, "test-token");
        var connection = new AgentConnectionService(endpoint, launcher, "test-token", paths.DataDirectory);
        var updates = new UpdateService();
        var shell = new ShellViewModel(
            connection,
            new DesktopSettingsStore(paths),
            new DataLocationService(paths),
            new StartupRegistrationService(),
            updates,
            paths);
        return new ShellFixture(root, paths, shell, connection, updates);
    }

    private static AppPaths TestPaths(string root, bool development = true)
    {
        var config = Path.Combine(root, "config");
        var data = Path.Combine(root, "data");
        var state = Path.Combine(root, "state");
        return new AppPaths(config, Path.Combine(config, "desktop.json"), Path.Combine(config, "bootstrap.json"), Path.Combine(config, "ipc.key"), data, Path.Combine(data, "keeper.db"), Path.Combine(root, "cache"), state, Path.Combine(state, "agent.log"), Path.Combine(state, "migration-progress.json"), development, null);
    }

    private static string NewTemporaryDirectory()
    {
        var value = Path.Combine(Path.GetTempPath(), $"keeper-desktop-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(value);
        return value;
    }

    /// <summary>
    /// Unix socket 路径不能放在测试用的临时目录里：那个目录名带 32 字符 GUID，
    /// 在 macOS 上 Path.GetTempPath() 本身又占约 51 字节，加起来必然超过
    /// sun_path 的 104 字节上限，而失败信息只是 EINVAL。
    /// </summary>
    private static string ShortSocketPath(string tag)
    {
        var directory = AgentEndpointResolver.DefaultUnixRuntimeDirectory();
        var name = $"kpr-t{tag}-{Guid.NewGuid():N}"[..14] + ".sock";
        return AgentEndpointResolver.EnsureUnixSocketPathFits(Path.Combine(directory, name));
    }

    private static string FindRepositoryRoot()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var directory = new DirectoryInfo(start); directory is not null; directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "src", "agent", "launcher.js")))
                {
                    return directory.FullName;
                }
            }
        }
        throw new DirectoryNotFoundException("Could not locate the repository root for the source Agent integration test.");
    }

    private static void WriteLegacyFixture(string root)
    {
        static void Write(string root, string relative, string content)
        {
            var file = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, content);
        }
        Write(root, "config/accounts.json", """{"accounts":[{"id":"legacy-account","note":"imported","profileDir":"profiles/legacy-account","enabled":true}]}""");
        Write(root, "config/conversations.json", """{"sets":{"default":{"topic":"migration","minRounds":1,"maxRounds":2}}}""");
        // 关掉启动巡检：否则 Agent 一起来就为这个账号打开真实 Chrome 检查登录态，
        // 持有账号锁，随后的 system.shutdown 会以 RESOURCE_BUSY 被正确拒绝。
        // 迁移后调度本来也应该是停止的（见 PLAN M2）。
        Write(root, "config/settings.json", """{"intervalMinutes":90,"headless":true,"statusCheckOnStartup":false}""");
        Write(root, "config/groups.json", """{"groups":[]}""");
        Write(root, "profiles/legacy-account/Default/Cookies", "cookie-state");
        Write(root, "profiles/legacy-account/DevToolsActivePort", "stale-lock");
        Write(root, "logs/legacy-account.jsonl", """{"time":"2026-01-01T00:00:00.000Z","ok":true}""" + Environment.NewLine);
        Write(root, "logs/deleted-account.jsonl", """{"time":"2025-01-01T00:00:00.000Z","ok":false,"reason":"old"}""" + Environment.NewLine);
    }

    private sealed class ShellFixture : IAsyncDisposable
    {
        private readonly string _root;
        private readonly AgentConnectionService _connection;
        private readonly UpdateService _updates;
        public ShellFixture(string root, AppPaths paths, ShellViewModel shell, AgentConnectionService connection, UpdateService updates)
        {
            _root = root;
            Paths = paths;
            Shell = shell;
            _connection = connection;
            _updates = updates;
        }
        public AppPaths Paths { get; }
        public ShellViewModel Shell { get; }
        public async ValueTask DisposeAsync()
        {
            // 兜底：任何用例只要真的连上了 Agent，就必须在这里把它停掉。
            // 否则残留的 node 进程会一直持有 node_modules 里的 better-sqlite3
            // 原生模块，让后续 npm ci 因 EPERM unlink 失败 —— 表现为本地发布
            // 构建莫名跑不通，且和真正的原因隔着好几层。
            if (_connection.IsConnected)
            {
                try
                {
                    await Shell.ShutdownAgentAsync("test-cleanup");
                }
                catch
                {
                    // 清理失败不该盖掉用例本身的失败原因。
                }
            }
            Shell.Stop();
            _updates.Dispose();
            await _connection.DisposeAsync();
            for (var attempt = 0; attempt < 20 && Directory.Exists(_root); attempt++)
            {
                try { Directory.Delete(_root, recursive: true); }
                catch (IOException) { await Task.Delay(100); }
                catch (UnauthorizedAccessException) { await Task.Delay(100); }
            }
        }
    }
}
