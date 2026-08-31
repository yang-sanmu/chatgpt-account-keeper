// 历史记录的结果摘要。
//
// 重点是三态：成功 / 失败 / **没有结果**。第三种是进程被杀或写入中断留下的 `ok: null`，
// 把它算成失败会让用户去排查一个没有发生的故障。

import { describe, expect, it } from "vitest";
import { describeLastRun, summarizeEntry } from "../history-summary";
import type { HistoryEntryResult } from "@/ipc/generated";

function entry(overrides: Partial<HistoryEntryResult> = {}): HistoryEntryResult {
  return {
    time: "2026-08-27T10:00:00Z",
    ok: true,
    setName: "daily",
    topic: "技术话题",
    totalRounds: 5,
    targetRounds: 5,
    stopReason: "completed",
    error: null,
    needReauth: false,
    rounds: [],
    ...overrides,
  };
}

describe("单条记录的结果摘要", () => {
  it("成功时说明完成了多少轮", () => {
    const summary = summarizeEntry(entry({ totalRounds: 3, targetRounds: 8 }));
    expect(summary.outcome).toBe("ok");
    expect(summary.headline).toBe("完成 3 / 8 轮对话");
  });

  it("没有目标轮次时不显示斜杠", () => {
    expect(summarizeEntry(entry({ totalRounds: 4, targetRounds: null })).headline).toBe(
      "完成 4 轮对话"
    );
  });

  it("ok 为 null 是「没有结果」，不是失败", () => {
    const summary = summarizeEntry(entry({ ok: null, error: null }));
    expect(summary.outcome).toBe("unknown");
    expect(summary.headline).toBe("这次运行没有留下结果");
  });

  it("失败时优先显示具体错误，而不是分类", () => {
    const summary = summarizeEntry(
      entry({ ok: false, error: "登录态已失效", stopReason: "send-failed" })
    );
    expect(summary.outcome).toBe("failed");
    expect(summary.headline).toBe("登录态已失效");
  });

  it("没有具体错误时回退到停止原因的中文名", () => {
    expect(
      summarizeEntry(entry({ ok: false, error: null, stopReason: "no-next-question" }))
        .headline
    ).toBe("模型没有给出下一个问题，提前结束");
  });

  it("两个都没有时也要给一句话，不能是空字符串", () => {
    expect(
      summarizeEntry(entry({ ok: false, error: null, stopReason: null })).headline
    ).toBe("运行失败，未记录原因");
  });

  it("未知的停止原因原样显示，不塌缩成「未知」", () => {
    // 服务层刻意保留未知值向前兼容（见 src/application/services.js 的注释）。
    // 塌缩会让 Agent 新增的结束原因在界面上与真正的异常无法区分。
    expect(
      summarizeEntry(entry({ ok: false, error: null, stopReason: "brand-new-reason" }))
        .headline
    ).toBe("brand-new-reason");
  });

  it("needReauth 单独透出，因为它是唯一需要用户自己动手的失败", () => {
    expect(summarizeEntry(entry({ ok: false, needReauth: true })).needsReauth).toBe(true);
    expect(summarizeEntry(entry({ ok: true })).needsReauth).toBe(false);
  });
});

describe("账号级的上次运行结果", () => {
  it("三态各自有明确措辞", () => {
    expect(describeLastRun(true)).toEqual({ outcome: "ok", label: "上次成功" });
    expect(describeLastRun(false)).toEqual({ outcome: "failed", label: "上次失败" });
    expect(describeLastRun(null)).toEqual({ outcome: "unknown", label: "无运行记录" });
    expect(describeLastRun(undefined)).toEqual({ outcome: "unknown", label: "无运行记录" });
  });

  it("从未运行过不能显示成失败", () => {
    // 一个刚创建还没被调度过的账号，显示「上次失败」会让用户以为它坏了。
    expect(describeLastRun(null).outcome).not.toBe("failed");
  });
});
