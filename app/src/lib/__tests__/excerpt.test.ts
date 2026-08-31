// 长文本的摘要折叠。
//
// GPT 的回复动辄上千字。历史页默认只显示摘要，全文按需展开 —— 不折叠时一条回复就顶掉整屏，
// 「浏览这个账号最近在聊什么」变成滚动作业。

import { describe, expect, it } from "vitest";
import { describeEntryPreview, excerptText } from "../history-summary";
import type { HistoryEntryResult } from "@/ipc/generated";

describe("摘要折叠", () => {
  it("短文本原样返回，且不标记为已截断", () => {
    const result = excerptText("这是一句短话。");
    expect(result.excerpt).toBe("这是一句短话。");
    expect(result.truncated).toBe(false);
  });

  it("空值与 null 不会抛错", () => {
    expect(excerptText(null).excerpt).toBe("");
    expect(excerptText(undefined).truncated).toBe(false);
    expect(excerptText("   ").excerpt).toBe("");
  });

  it("超长文本被截断，并保留全文供展开", () => {
    const long = "很长的内容".repeat(100);
    const result = excerptText(long);

    expect(result.truncated).toBe(true);
    expect(result.excerpt.length).toBeLessThan(long.length);
    expect(result.full).toBe(long);
  });

  it("优先在句子边界断开，而不是切在半个词中间", () => {
    const text = `${"甲".repeat(100)}。${"乙".repeat(100)}`;
    const result = excerptText(text, 140);

    expect(result.excerpt.endsWith("。")).toBe(true);
    // 没有省略号，因为断在了一个完整句子上。
    expect(result.excerpt.endsWith("…")).toBe(false);
  });

  it("找不到句子边界时硬截断并加省略号", () => {
    // 一整段没有标点的文本（GPT 偶尔会输出这种）。
    const result = excerptText("啊".repeat(300), 140);
    expect(result.truncated).toBe(true);
    expect(result.excerpt.endsWith("…")).toBe(true);
  });

  it("不会为了凑一个完整句子把摘要砍得过短", () => {
    // 句号出现在很靠前的位置（10 字处），后面是一大段无标点内容。
    // 若无条件在最后一个句号处断开，摘要只剩 10 个字，等于没有信息。
    const text = `短句结束在这里。${"后续内容".repeat(80)}`;
    const result = excerptText(text, 140);

    expect(result.excerpt.length).toBeGreaterThan(80);
  });

  it("换行也算句子边界", () => {
    const text = `第一行内容${"x".repeat(120)}\n${"y".repeat(100)}`;
    const result = excerptText(text, 140);
    expect(result.truncated).toBe(true);
  });
});

function entry(overrides: Partial<HistoryEntryResult> = {}): HistoryEntryResult {
  return {
    time: "2026-08-27T10:00:00Z",
    ok: true,
    setName: "daily",
    topic: "技术话题",
    totalRounds: 1,
    targetRounds: 1,
    stopReason: "completed",
    error: null,
    needReauth: false,
    rounds: [],
    ...overrides,
  };
}

describe("记录的一行概览", () => {
  it("用第一个问题的摘要，因为那才是这次对话在聊什么", () => {
    const preview = describeEntryPreview(
      entry({
        rounds: [{ question: "如何理解 Rust 的所有权？", answer: "很长的回答…", at: null }],
      })
    );
    expect(preview).toBe("如何理解 Rust 的所有权？");
  });

  it("跳过空问题，取第一个有内容的", () => {
    const preview = describeEntryPreview(
      entry({
        rounds: [
          { question: null, answer: "回答", at: null },
          { question: "  ", answer: "回答", at: null },
          { question: "真正的问题", answer: "回答", at: null },
        ],
      })
    );
    expect(preview).toBe("真正的问题");
  });

  it("没有问题时退到主题", () => {
    expect(describeEntryPreview(entry({ rounds: [], topic: "技术话题" }))).toBe("技术话题");
  });

  it("主题也没有时退到会话集名，最后才是缺失提示", () => {
    expect(describeEntryPreview(entry({ rounds: [], topic: null, setName: "daily" }))).toBe(
      "daily"
    );
    expect(
      describeEntryPreview(entry({ rounds: [], topic: null, setName: null }))
    ).toBe("本条记录缺少内容");
  });
});
