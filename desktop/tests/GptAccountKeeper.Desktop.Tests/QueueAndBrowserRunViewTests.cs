using System.Text.Json;
using GptAccountKeeper.Desktop.Models;
using GptAccountKeeper.Desktop.Serialization;
using Xunit;

namespace GptAccountKeeper.Desktop.Tests;

/// <summary>
/// 计划 §15 的展示不变量。核心一条：当后台活动任务显示为 0 时，仍存在的项目 Chrome
/// 必须能在明细里找到对应记录——close_failed 会长期留在 active 并继续占用容量，
/// 界面不能把它当成已释放。
/// </summary>
public sealed class QueueAndBrowserRunViewTests
{
    [Fact]
    public void QueueSnapshot_DeserializesSlotsAndWaitingStages()
    {
        const string json = """
        {
          "queuedTotal": 7,
          "waiting": { "queued": 3, "workSlot": 0, "account": 2, "chrome": 2 },
          "running": 2,
          "closing": 1,
          "workSlots": { "used": 4, "limit": 4 },
          "chromeSlots": { "used": 3, "limit": 4 },
          "admissionPaused": false,
          "broker": { "running": true, "generationId": "gen-1" }
        }
        """;
        var snapshot = JsonSerializer.Deserialize(json, AppJsonContext.Default.QueueSnapshotDto);
        Assert.NotNull(snapshot);
        Assert.Equal(7, snapshot!.QueuedTotal);
        Assert.Equal(2, snapshot.Waiting.Account);
        Assert.Equal(2, snapshot.Waiting.Chrome);
        Assert.Equal(1, snapshot.Closing);
        // Chrome 使用量形如 "3 / 4"。
        Assert.Equal("3 / 4", snapshot.ChromeSlots.Text);
        Assert.Equal("4 / 4", snapshot.WorkSlots.Text);
        Assert.True(snapshot.Broker!.Running);
    }

    [Fact]
    public void BrowserRun_CloseFailedIsSurfacedAsNeedingAttention()
    {
        var run = new BrowserRunDto
        {
            BrowserRunId = "run-1",
            AccountId = "acc-1",
            Purpose = "scheduled-run",
            EffectiveSource = "scheduled",
            State = "close_failed",
            CloseReason = "close:job-not-empty",
            StartedAt = DateTimeOffset.Now.AddMinutes(-3),
        };
        Assert.True(run.NeedsAttention, "未能回收必须被标为需要关注");
        Assert.Equal("未能回收", run.StateText);
        // 完全限定：本测试只在这一处需要 Presentation 层的 Palette，不为它把整个
        // UI 命名空间引入一个 Models 层的 DTO 测试。
        Assert.Equal(GptAccountKeeper.Desktop.Presentation.Palette.Danger, run.StateColor);
        Assert.Contains("job-not-empty", run.DetailText);
        Assert.Contains("分", run.RuntimeText);
    }

    [Fact]
    public void BrowserRun_PurposeReflectsPromotedIntent()
    {
        var promoted = new BrowserRunDto
        {
            Purpose = "manual-run",
            EffectiveSource = "manual",
            State = "running",
        };
        // 被 runNow 命中并提升的自动条目必须显示为用户触发，而不是仍显示"自动"。
        Assert.Equal("立即运行", promoted.PurposeText);
        Assert.Equal("用户触发", promoted.SourceText);

        var automatic = new BrowserRunDto
        {
            Purpose = "scheduled-run",
            EffectiveSource = "scheduled",
            State = "running",
        };
        Assert.Equal("自动对话", automatic.PurposeText);
        Assert.Equal("自动", automatic.SourceText);
    }

    [Fact]
    public void BrowserRunList_ReportsQuarantineAndOccupancy()
    {
        const string json = """
        {
          "active": [
            {
              "browserRunId": "run-1", "accountId": "acc-1", "purpose": "scheduled-run",
              "effectiveSource": "scheduled", "state": "close_failed",
              "startedAt": "2026-08-22T00:00:00.000Z", "rootPid": 4242,
              "closeReason": "close:job-not-empty", "closeError": null
            }
          ],
          "recent": [],
          "chromeOccupancy": 1,
          "quarantined": [ { "accountId": "acc-1", "reason": "chromeReclaimFailed" } ]
        }
        """;
        var runs = JsonSerializer.Deserialize(json, AppJsonContext.Default.BrowserRunListDto);
        Assert.NotNull(runs);
        // 「后台任务 0 但 Chrome 非 0」时，用户必须能在明细里找到这条记录。
        Assert.Single(runs!.Active);
        Assert.Equal(1, runs.ChromeOccupancy);
        Assert.Single(runs.Quarantined);
        Assert.Equal("chromeReclaimFailed", runs.Quarantined[0].Reason);
        Assert.Equal(4242, runs.Active[0].RootPid);
    }

    [Fact]
    public void BrowserRunCloseResult_FalseOkMustNotReadAsReclaimed()
    {
        const string json = """
        { "ok": false, "run": { "browserRunId": "run-1", "accountId": "acc-1",
          "purpose": "scheduled-run", "state": "close_failed",
          "startedAt": "2026-08-22T00:00:00.000Z" } }
        """;
        var result = JsonSerializer.Deserialize(json, AppJsonContext.Default.BrowserRunCloseResultDto);
        Assert.NotNull(result);
        // 复验未通过仍是 close_failed：UI 不得显示成已回收。
        Assert.False(result!.Ok);
        Assert.Equal("close_failed", result.Run!.State);
        Assert.True(result.Run.NeedsAttention);
    }

    [Fact]
    public void OperationDto_CarriesEffectiveSource()
    {
        const string json = """
        { "id": "op-1", "kind": "account-run", "state": "queued", "stage": "waiting_account",
          "blocksUpdate": false, "effectiveSource": "manual",
          "startedAt": "2026-08-22T00:00:00.000Z", "updatedAt": "2026-08-22T00:00:00.000Z" }
        """;
        var operation = JsonSerializer.Deserialize(json, AppJsonContext.Default.AgentOperationDto);
        Assert.NotNull(operation);
        Assert.Equal("manual", operation!.EffectiveSource);
        // 排队条目不持有资源，不得成为更新阻塞项。
        Assert.False(operation.BlocksUpdate);
        Assert.Equal("waiting_account", operation.Stage);
    }
}
