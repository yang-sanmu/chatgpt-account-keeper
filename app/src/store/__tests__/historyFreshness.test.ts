// 历史摘要的实时性。
//
// 这条钉的是一个真实观察到的问题：一个账号昨天失败、今天已经连续成功，历史页左栏却一直
// 显示昨天的失败和红色。成因是 history.appended 事件被 store 直接 break 掉了，
// historyAccounts 只有 bootstrap 时那一份快照。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "../keeperStore";

const store = () => useKeeperStore.getState();

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function historyAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "acc-1",
    entryCount: 3,
    deleted: false,
    lastAt: "2026-08-27T10:00:00Z",
    lastOk: false,
    note: "",
    email: "user@example.com",
    gptName: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await store().bootstrapApp();
  tauri.emitBootstrap(
    makeBootstrap({
      accounts: [makeAccount({ id: "acc-1" })],
      historyAccounts: [historyAccount()],
    })
  );
});

describe("history.appended 之后摘要要跟上", () => {
  it("初始摘要来自 bootstrap", () => {
    expect(store().historyAccounts[0]?.lastOk).toBe(false);
    expect(store().historyAccounts[0]?.lastAt).toBe("2026-08-27T10:00:00Z");
  });

  it("跑完一轮后重新拉取摘要，成败与时间都刷新", async () => {
    tauri.onMethod("history.listAccounts", () => [
      historyAccount({ lastOk: true, lastAt: "2026-08-28T09:30:00Z", entryCount: 4 }),
    ]);

    tauri.emitAgentEvent("history.appended", {
      accountId: "acc-1",
      entry: { time: "2026-08-28T09:30:00Z", ok: true },
    });
    await flush();

    const summary = store().historyAccounts[0];
    expect(summary?.lastOk, "上次成功后左栏不该还是红的").toBe(true);
    expect(summary?.lastAt).toBe("2026-08-28T09:30:00Z");
    expect(summary?.entryCount).toBe(4);
  });

  it("摘要重取失败时保留上一份，不清空成空列表", async () => {
    // 清空会让历史页显示「暂无历史记录」—— 那比显示一份稍旧的摘要糟得多。
    tauri.failMethod("history.listAccounts", { code: "AGENT_TIMEOUT", message: "超时", retryable: true });

    tauri.emitAgentEvent("history.appended", { accountId: "acc-1", entry: {} });
    await flush();

    expect(store().historyAccounts).toHaveLength(1);
  });

  it("手动刷新走同一条路径", async () => {
    tauri.onMethod("history.listAccounts", () => [
      historyAccount({ lastOk: true, entryCount: 9 }),
    ]);

    await store().refreshHistoryAccounts();

    expect(store().historyAccounts[0]?.entryCount).toBe(9);
  });
});
