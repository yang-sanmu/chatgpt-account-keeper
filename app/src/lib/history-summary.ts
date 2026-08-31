// 历史记录的结果摘要。
//
// `HistoryEntryResult` 把「怎么结束的」摊在四个字段里：ok / stopReason / error / needReauth。
// 历史页要在最显眼的位置回答「最后一次跑成功了吗、没成功是为什么」，所以这里把四个字段
// 收敛成一句话。

import type { HistoryEntryResult } from "@/ipc/generated";

export type RunOutcome = "ok" | "failed" | "unknown";

export interface RunSummary {
  outcome: RunOutcome;
  /// 一行摘要。失败时是原因，成功时是完成的轮次。
  headline: string;
  /// 需要重新登录。这是失败原因里唯一一种用户**必须自己动手**的，要单独标出来。
  needsReauth: boolean;
}

/// 停止原因的中文名。取值来自 `src/agent.js` 的 runAgent。
///
/// 只有这四个：区分「计划 8 轮跑满 8 轮」「计划 8 轮只跑了 2 轮因为模型没给下一个问题」
/// 「发送本身失败」是这个字段存在的全部理由，服务层刻意保留未知值向前兼容，所以这里
/// 查不到就原样显示，不能塌缩。
const STOP_REASONS: Record<string, string> = {
  completed: "跑满了计划轮次",
  "no-next-question": "模型没有给出下一个问题，提前结束",
  "send-failed": "发送消息失败",
  "no-topic": "会话集没有设置主题",
};

function describeStopReason(reason: string): string {
  return STOP_REASONS[reason] ?? reason;
}

/// 把一条历史记录收敛成结果摘要。
export function summarizeEntry(entry: HistoryEntryResult): RunSummary {
  const needsReauth = entry.needReauth;

  if (entry.ok === true) {
    const target =
      typeof entry.targetRounds === "number" ? ` / ${entry.targetRounds}` : "";
    return {
      outcome: "ok",
      headline: `完成 ${entry.totalRounds}${target} 轮对话`,
      needsReauth,
    };
  }

  // ok 为 null 表示这条记录没写结果（进程被杀、写入中断）。它既不是成功也不是失败，
  // 说成失败会让用户去排查一个没有发生的故障。
  if (entry.ok === null) {
    return {
      outcome: "unknown",
      headline: entry.error ?? "这次运行没有留下结果",
      needsReauth,
    };
  }

  // 失败：error 是具体信息，stopReason 是分类。前者更有用，没有才退到后者。
  const detail =
    entry.error ??
    (entry.stopReason ? describeStopReason(entry.stopReason) : null) ??
    "运行失败，未记录原因";

  return { outcome: "failed", headline: detail, needsReauth };
}

/// 摘要的目标长度（字符）。
///
/// GPT 的回复动辄上千字，一条就能顶掉整屏，把「浏览这个账号最近在聊什么」变成滚动作业。
/// 默认折叠成一段摘要，用户想看全文再展开。
const EXCERPT_LENGTH = 140;

export interface TextExcerpt {
  /// 折叠后的文本。已经在句子边界处截断。
  excerpt: string;
  /// 是否真的截断了。false 时界面不该显示「展开」。
  truncated: boolean;
  /// 原始全文。展开时用它。
  full: string;
}

/// 把一段可能很长的文本折成摘要。
///
/// 优先在句子边界断开（。！？.!? 与换行），断不到就退回硬截断 —— 半句话结尾比多两个字更
/// 影响可读性，但为了凑一个完整句子拉长到三倍也不行，所以只在 60% 之后找边界。
export function excerptText(
  text: string | null | undefined,
  limit = EXCERPT_LENGTH
): TextExcerpt {
  const full = typeof text === "string" ? text.trim() : "";
  if (full.length <= limit) {
    return { excerpt: full, truncated: false, full };
  }

  const window = full.slice(0, limit);
  // 从 60% 位置往后找最后一个句子边界，避免把摘要砍得过短。
  const earliest = Math.floor(limit * 0.6);
  let cut = -1;
  for (let index = window.length - 1; index >= earliest; index -= 1) {
    const char = window[index];
    if (char && "。！？.!?\n".includes(char)) {
      cut = index + 1;
      break;
    }
  }

  const excerpt = cut > 0 ? window.slice(0, cut).trim() : `${window.trim()}…`;
  return { excerpt, truncated: true, full };
}

/// 一条记录的一句话概览：主题 + 轮数 + 首个问题的摘要。
///
/// 历史列表默认折叠到这一行，用户点开才渲染完整问答。几十条记录全展开时，光是 DOM 节点
/// 就有上万个。
export function describeEntryPreview(entry: HistoryEntryResult): string {
  const firstQuestion = entry.rounds.find(
    (round) => typeof round.question === "string" && round.question.trim().length > 0
  )?.question;

  if (firstQuestion) return excerptText(firstQuestion, 60).excerpt;
  return entry.topic ?? entry.setName ?? "本条记录缺少内容";
}

/// 历史侧栏用的账号级摘要。只有 lastOk 一个布尔值可用。
export function describeLastRun(lastOk: boolean | null | undefined): {
  outcome: RunOutcome;
  label: string;
} {
  if (lastOk === true) return { outcome: "ok", label: "上次成功" };
  if (lastOk === false) return { outcome: "failed", label: "上次失败" };
  return { outcome: "unknown", label: "无运行记录" };
}
