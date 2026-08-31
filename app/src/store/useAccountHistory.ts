// 单个账号的对话历史。
//
// 抽出来是因为它有两个入口：历史页（跨账号浏览）和账号卡片的抽屉（看这一个）。两边各写一遍
// 取数与竞态处理，迟早会有一边漏掉 cancelled 判断，然后切换账号时旧请求的结果覆盖新的。

import { useCallback, useEffect, useState } from "react";
import { agentCall } from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import type { HistoryEntryResult } from "@/ipc/generated";

/// 一次取多少条。
///
/// 历史是只增的，一个跑了几个月的账号可能有上千条；全取回来对界面和 IPC 都不划算，而用户
/// 实际关心的是最近发生了什么。
const HISTORY_LIMIT = 100;

export interface AccountHistoryState {
  entries: HistoryEntryResult[];
  loading: boolean;
  /// 取数失败。界面据此显示可重试的原因，而不是一个会被误读成「没有记录」的空列表。
  failed: boolean;
  reload: () => void;
}

export function useAccountHistory(accountId: string | null): AccountHistoryState {
  const [entries, setEntries] = useState<HistoryEntryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  /// 手动重试的计数器。改它就重跑下面的 effect，不必把取数逻辑复制到 reload 里。
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!accountId) {
      setEntries([]);
      setFailed(false);
      return;
    }

    // 切换账号时旧请求可能还在飞。没有这个标记的话，先发起的那个后返回就会把新账号的
    // 记录覆盖成上一个账号的。
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    agentCall("history.query", { accountId, limit: HISTORY_LIMIT })
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
      })
      .catch((error) => {
        if (cancelled) return;
        setFailed(true);
        setEntries([]);
        notify.error("加载历史记录失败", error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, attempt]);

  return { entries, loading, failed, reload };
}
