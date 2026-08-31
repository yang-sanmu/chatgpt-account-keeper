// 正在跑任务的账号索引。
//
// 账号卡片要在有任务在跑时醒目显示并说出在跑什么。这里钉两件事：只算非终态任务，以及
// 一个账号有多条在途时取最新那条。

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, makeOperation, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "../keeperStore";
import { useAccountRunningOperation, useRunningOperationsByAccount } from "../selectors";

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(
    makeBootstrap({
      accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
    })
  );
});

describe("运行中任务索引", () => {
  it("空闲时是空表", () => {
    const { result } = renderHook(() => useRunningOperationsByAccount());
    expect(result.current.size).toBe(0);
  });

  it("三种非终态都算在跑", () => {
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-q", kind: "account-run", resourceId: "acc-1", state: "queued" })
    );
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-w",
        kind: "account-login",
        resourceId: "acc-2",
        state: "waiting_user",
      })
    );

    const { result } = renderHook(() => useRunningOperationsByAccount());
    expect(result.current.get("acc-1")?.state).toBe("queued");
    expect(result.current.get("acc-2")?.state).toBe("waiting_user");
  });

  it("任务走到终态后从表里消失", () => {
    act(() => {
      tauri.emitAgentEvent(
        "operation.changed",
        makeOperation({ id: "op-1", kind: "account-run", resourceId: "acc-1", state: "running" })
      );
    });
    const { result } = renderHook(() => useRunningOperationsByAccount());
    expect(result.current.has("acc-1")).toBe(true);

    act(() => {
      tauri.emitAgentEvent(
        "operation.changed",
        makeOperation({ id: "op-1", kind: "account-run", resourceId: "acc-1", state: "succeeded" })
      );
    });
    expect(
      result.current.has("acc-1"),
      "任务结束后卡片不该继续显示「正在运行」"
    ).toBe(false);
  });

  it("单个账号的订阅只在自身任务变化时返回新状态", () => {
    const { result } = renderHook(() => useAccountRunningOperation("acc-1"));
    expect(result.current).toBeUndefined();

    act(() => {
      tauri.emitAgentEvent(
        "operation.changed",
        makeOperation({ id: "op-1", kind: "account-run", resourceId: "acc-1", state: "running" })
      );
    });
    expect(result.current?.id).toBe("op-1");

    act(() => {
      tauri.emitAgentEvent(
        "operation.changed",
        makeOperation({ id: "op-2", kind: "account-run", resourceId: "acc-2", state: "running" })
      );
    });
    // acc-1 的任务不受 acc-2 影响
    expect(result.current?.id).toBe("op-1");

    act(() => {
      tauri.emitAgentEvent(
        "operation.changed",
        makeOperation({ id: "op-1", kind: "account-run", resourceId: "acc-1", state: "succeeded" })
      );
    });
    expect(result.current).toBeUndefined();
  });

  it("同一账号有多条在途时取最新的那条", () => {
    // 例如刷新状态排在立即运行后面。显示较早那条会让卡片说着一个已经过去的阶段。
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-old", kind: "account-run", resourceId: "acc-1", state: "running" })
    );
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-new",
        kind: "account-status-refresh",
        resourceId: "acc-1",
        state: "queued",
      })
    );

    const { result } = renderHook(() => useRunningOperationsByAccount());
    expect(result.current.get("acc-1")?.id).toBe("op-new");
  });

  it("没有 resourceId 的全局任务不会进表", () => {
    // profile-scan / proxy-test-all 之类不针对某个账号，不该让任何卡片亮起来。
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-scan", kind: "profile-scan", resourceId: null, state: "running" })
    );

    const { result } = renderHook(() => useRunningOperationsByAccount());
    expect(result.current.size).toBe(0);
  });
});
