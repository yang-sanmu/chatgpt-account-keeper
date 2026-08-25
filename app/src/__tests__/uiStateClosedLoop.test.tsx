// M4.5 UI 状态闭环回归测试
// 使用 Agent 真实 payload 驱动 AppProvider，验证增量更新与终态迁移

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let emitBootstrap: ((payload: unknown) => void) | null = null;
let emitAgentEvent: ((payload: unknown) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "get_startup_info") {
      return {
        version: "0.2.0",
        dataDirectory: "C:\\test\\data",
        cacheDirectory: "C:\\test\\cache",
        stateDirectory: "C:\\test\\state",
        agentLogFile: "C:\\test\\state\\agent.log",
        endpoint: "\\\\.\\pipe\\test",
        isDevelopment: true,
        initialized: false,
        bootstrapWarning: null,
        settings: {
          theme: "dark",
          closeBehavior: "ask",
          startAtLogin: false,
          autoStartScheduler: false,
          updatePolicy: "notifyOnly",
          ignoredUpdateVersion: null,
          pendingLegacyImportRoot: null,
        },
      };
    }
    if (command === "new_command_id") return "00000000-0000-4000-8000-000000000000";
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "keeper://bootstrap") emitBootstrap = (payload) => handler({ payload });
    if (name === "keeper://agent-event") emitAgentEvent = (payload) => handler({ payload });
    return () => {};
  }),
}));

function bootstrapSnapshot() {
  return {
    instanceId: "instance-1",
    revision: 1,
    accounts: [
      {
        id: "acc-1",
        email: "acc1@example.com",
        note: "账号1",
        enabled: true,
        groupId: null,
        groupName: null,
        switchRule: "random",
        minWindows: 1,
        maxWindows: 3,
        status: "ok",
        statusCheckedAt: null,
        stale: false,
        exitNode: null,
        exitNodeMissing: false,
        rotationTopic: null,
        rotationDone: 0,
        rotationTarget: 5,
        nextRunAt: null,
        lastRunAt: null,
        lastRunOk: null,
        lastRunReason: null,
        pageOpen: false,
      },
    ],
    statuses: {},
    openPages: {},
    groups: [],
    proxies: { nodes: [], status: { running: false }, subscription: null, runtime: null },
    conversations: {},
    scheduler: { running: false, enabled: false, accounts: {} },
    settings: {
      intervalMinutes: 180,
      jitterMinutes: 30,
      headless: true,
      statusCheckMinutes: 15,
      statusCheckOnStartup: true,
      openPageTimeoutMinutes: 30,
      profileAutoCleanEnabled: false,
    },
    operations: [],
    activeOperations: [],
    historyAccounts: [],
    draining: false,
  };
}

type AppContextValue = import("../state/AppContext").AppContextValue;
let api: AppContextValue | null = null;

describe("M4.5 UI 状态闭环：真实 payload 驱动与增量更新", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    api = null;
    emitBootstrap = null;
    emitAgentEvent = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const { AppProvider, useApp } = await import("../state/AppContext");
    function Probe() {
      api = useApp();
      return null;
    }

    await act(async () => {
      root.render(
        <AppProvider>
          <Probe />
        </AppProvider>
      );
    });

    await act(async () => {
      emitBootstrap?.(bootstrapSnapshot());
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("1. group.changed: 原始 Group 与 {id, removed:true} 准确增量更新 groups", async () => {
    expect(api?.groups).toEqual([]);

    // 1. 创建分组 g1（真实 payload 是原始 Group 对象）
    await act(async () => {
      emitAgentEvent?.({
        name: "group.changed",
        payload: {
          id: "g1",
          name: "美区节点组",
          proxyId: "node-us-1",
          timezone: "America/New_York",
          locale: "en-US",
        },
      });
    });

    expect(api?.groups).toEqual([
      {
        id: "g1",
        name: "美区节点组",
        proxyId: "node-us-1",
        timezone: "America/New_York",
        locale: "en-US",
      },
    ]);

    // 2. 创建分组 g2
    await act(async () => {
      emitAgentEvent?.({
        name: "group.changed",
        payload: {
          id: "g2",
          name: "日区节点组",
          proxyId: "node-jp-1",
          timezone: "Asia/Tokyo",
          locale: "ja-JP",
        },
      });
    });

    expect(api?.groups.map((g) => g.id)).toEqual(["g1", "g2"]);

    // 3. 更新分组 g1
    await act(async () => {
      emitAgentEvent?.({
        name: "group.changed",
        payload: {
          id: "g1",
          name: "美区高性能组",
          proxyId: "node-us-2",
          timezone: "America/Los_Angeles",
          locale: "en-US",
        },
      });
    });

    expect(api?.groups).toHaveLength(2);
    expect(api?.groups.find((g) => g.id === "g1")).toEqual({
      id: "g1",
      name: "美区高性能组",
      proxyId: "node-us-2",
      timezone: "America/Los_Angeles",
      locale: "en-US",
    });

    // 4. 删除分组 g1（真实 payload 是 {id, removed:true}）
    await act(async () => {
      emitAgentEvent?.({
        name: "group.changed",
        payload: {
          id: "g1",
          removed: true,
        },
      });
    });

    expect(api?.groups).toHaveLength(1);
    expect(api?.groups[0]?.id).toBe("g2");
  });

  it("2. conversation.changed: {name, set} 与 {name, removed:true} 准确增量更新 conversations", async () => {
    expect(api?.conversations).toEqual({});

    // 1. 新增会话集 c1（真实 payload 是 {name, set}）
    await act(async () => {
      emitAgentEvent?.({
        name: "conversation.changed",
        payload: {
          name: "code-review",
          set: {
            topic: "代码评审与重构",
            minRounds: 2,
            maxRounds: 5,
          },
        },
      });
    });

    expect(api?.conversations).toEqual({
      "code-review": {
        topic: "代码评审与重构",
        minRounds: 2,
        maxRounds: 5,
      },
    });

    // 2. 新增会话集 c2
    await act(async () => {
      emitAgentEvent?.({
        name: "conversation.changed",
        payload: {
          name: "daily-chat",
          set: {
            topic: "日常闲聊",
            minRounds: 1,
            maxRounds: 3,
          },
        },
      });
    });

    expect(Object.keys(api?.conversations || {})).toEqual(["code-review", "daily-chat"]);

    // 3. 更新会话集 c1
    await act(async () => {
      emitAgentEvent?.({
        name: "conversation.changed",
        payload: {
          name: "code-review",
          set: {
            topic: "架构深度讨论",
            minRounds: 3,
            maxRounds: 8,
          },
        },
      });
    });

    expect(api?.conversations["code-review"]).toEqual({
      topic: "架构深度讨论",
      minRounds: 3,
      maxRounds: 8,
    });

    // 4. 删除会话集 c1（真实 payload 是 {name, removed:true}）
    await act(async () => {
      emitAgentEvent?.({
        name: "conversation.changed",
        payload: {
          name: "code-review",
          removed: true,
        },
      });
    });

    expect(api?.conversations["code-review"]).toBeUndefined();
    expect(api?.conversations["daily-chat"]).toBeDefined();
  });

  it("3. scheduler.accountChanged: 字段准确投影到 UI 并处理显式 null 与缺失保持", async () => {
    // 初始状态
    let card = api?.accountsState.accounts["acc-1"]?.effective;
    expect(card?.nextRunAt).toBeNull();
    expect(card?.lastRunAt).toBeNull();
    expect(card?.lastRunOk).toBeNull();
    expect(card?.lastRunReason).toBeNull();

    // 1. 触发排期更新与开始运行
    await act(async () => {
      emitAgentEvent?.({
        name: "scheduler.accountChanged",
        payload: {
          accountId: "acc-1",
          nextAt: "2026-08-25T15:00:00.000Z",
          lastAt: "2026-08-25T12:00:00.000Z",
          busy: true,
          lastResultState: "succeeded",
          lastResult: {
            ok: true,
            reason: null,
            time: "2026-08-25T12:00:00.000Z",
          },
        },
      });
    });

    // 验证 scheduler.accounts UI 投影
    expect(api?.scheduler.accounts["acc-1"]?.nextRunAt).toBe("2026-08-25T15:00:00.000Z");
    expect(api?.scheduler.accounts["acc-1"]?.lastRunAt).toBe("2026-08-25T12:00:00.000Z");
    expect(api?.scheduler.accounts["acc-1"]?.lastRunOk).toBe(true);
    expect(api?.scheduler.accounts["acc-1"]?.reason).toBeNull();

    // 验证账号卡片所读字段
    card = api?.accountsState.accounts["acc-1"]?.effective;
    expect(card?.nextRunAt).toBe("2026-08-25T15:00:00.000Z");
    expect(card?.lastRunAt).toBe("2026-08-25T12:00:00.000Z");
    expect(card?.lastRunOk).toBe(true);
    expect(card?.lastRunReason).toBeNull();

    // 2. 字段缺失（未提供 nextAt/lastAt/lastResult）时必须保持旧值
    await act(async () => {
      emitAgentEvent?.({
        name: "scheduler.accountChanged",
        payload: {
          accountId: "acc-1",
          busy: false,
        },
      });
    });

    card = api?.accountsState.accounts["acc-1"]?.effective;
    expect(card?.nextRunAt).toBe("2026-08-25T15:00:00.000Z");
    expect(card?.lastRunAt).toBe("2026-08-25T12:00:00.000Z");
    expect(card?.lastRunOk).toBe(true);

    // 3. 触发失败结果更新
    await act(async () => {
      emitAgentEvent?.({
        name: "scheduler.accountChanged",
        payload: {
          accountId: "acc-1",
          nextAt: "2026-08-25T18:00:00.000Z",
          lastAt: "2026-08-25T15:00:00.000Z",
          busy: false,
          lastResultState: "failed",
          lastResult: {
            ok: false,
            reason: "Cloudflare 5秒盾验证超时",
            time: "2026-08-25T15:00:00.000Z",
          },
        },
      });
    });

    card = api?.accountsState.accounts["acc-1"]?.effective;
    expect(card?.nextRunAt).toBe("2026-08-25T18:00:00.000Z");
    expect(card?.lastRunAt).toBe("2026-08-25T15:00:00.000Z");
    expect(card?.lastRunOk).toBe(false);
    expect(card?.lastRunReason).toBe("Cloudflare 5秒盾验证超时");
    expect(api?.scheduler.accounts["acc-1"]?.reason).toBe("Cloudflare 5秒盾验证超时");

    // 4. 显式 null 必须能清空旧值，无需刷新全量 bootstrap
    await act(async () => {
      emitAgentEvent?.({
        name: "scheduler.accountChanged",
        payload: {
          accountId: "acc-1",
          nextAt: null,
          lastAt: null,
          busy: false,
          lastResultState: null,
          lastResult: null,
        },
      });
    });

    card = api?.accountsState.accounts["acc-1"]?.effective;
    expect(card?.nextRunAt).toBeNull();
    expect(card?.lastRunAt).toBeNull();
    expect(card?.lastRunOk).toBeNull();
    expect(card?.lastRunReason).toBeNull();

    expect(api?.scheduler.accounts["acc-1"]?.nextRunAt).toBeNull();
    expect(api?.scheduler.accounts["acc-1"]?.lastRunAt).toBeNull();
    expect(api?.scheduler.accounts["acc-1"]?.lastRunOk).toBeNull();
    expect(api?.scheduler.accounts["acc-1"]?.reason).toBeNull();
  });

  it("4. operation.changed: operations 与 activeOperations 同步增量维护（活跃/终态迁移与未知状态防护）", async () => {
    expect(api?.operations).toEqual([]);
    expect(api?.activeOperations).toEqual([]);

    // 1. 新任务入队 (queued -> active)
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-1",
          kind: "account-run",
          resourceId: "acc-1",
          state: "queued",
          stage: null,
          effectiveSource: "scheduled",
          message: "等待工作槽位",
          progress: null,
          startedAt: "2026-08-25T10:00:00Z",
          updatedAt: "2026-08-25T10:00:00Z",
          finishedAt: null,
          blocksUpdate: false,
        },
      });
    });

    expect(api?.operations).toHaveLength(1);
    expect(api?.activeOperations).toHaveLength(1);
    expect(api?.activeOperations[0]?.id).toBe("op-1");
    expect(api?.activeOperations[0]?.state).toBe("queued");

    // 2. 第二个任务处于 waiting_user 状态 (waiting_user -> active)
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-2",
          kind: "account-login",
          resourceId: "acc-2",
          state: "waiting_user",
          stage: "waiting",
          effectiveSource: "manual",
          message: "请在打开的浏览器中完成登录",
          progress: null,
          startedAt: "2026-08-25T10:01:00Z",
          updatedAt: "2026-08-25T10:01:00Z",
          finishedAt: null,
          blocksUpdate: true,
        },
      });
    });

    expect(api?.operations).toHaveLength(2);
    expect(api?.activeOperations.map((o) => o.id)).toEqual(["op-2", "op-1"]);

    // 3. op-1 转换为 running (running -> active)
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-1",
          kind: "account-run",
          resourceId: "acc-1",
          state: "running",
          stage: "browser",
          effectiveSource: "scheduled",
          message: "正在执行对话",
          progress: 0.5,
          startedAt: "2026-08-25T10:00:00Z",
          updatedAt: "2026-08-25T10:02:00Z",
          finishedAt: null,
          blocksUpdate: true,
        },
      });
    });

    expect(api?.activeOperations.find((o) => o.id === "op-1")?.state).toBe("running");

    // 4. op-1 成功完成 (succeeded -> terminal, 从 activeOperations 移除)
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-1",
          kind: "account-run",
          resourceId: "acc-1",
          state: "succeeded",
          stage: "complete",
          effectiveSource: "scheduled",
          message: "完成 3 轮对话",
          progress: 1,
          startedAt: "2026-08-25T10:00:00Z",
          updatedAt: "2026-08-25T10:03:00Z",
          finishedAt: "2026-08-25T10:03:00Z",
          result: { ok: true, totalRounds: 3 },
          blocksUpdate: false,
        },
      });
    });

    expect(api?.operations.find((o) => o.id === "op-1")?.state).toBe("succeeded");
    expect(api?.activeOperations.map((o) => o.id)).toEqual(["op-2"]);

    // 5. op-2 失败 (failed -> terminal, 从 activeOperations 移除)
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-2",
          kind: "account-login",
          resourceId: "acc-2",
          state: "failed",
          stage: null,
          effectiveSource: "manual",
          message: "登录失败",
          progress: null,
          startedAt: "2026-08-25T10:01:00Z",
          updatedAt: "2026-08-25T10:04:00Z",
          finishedAt: "2026-08-25T10:04:00Z",
          error: { code: "CANCELLED", message: "用户取消了登录", retryable: false },
          blocksUpdate: false,
        },
      });
    });

    expect(api?.operations.find((o) => o.id === "op-2")?.state).toBe("failed");
    expect(api?.activeOperations).toHaveLength(0);

    // 6. 测试其它终态（timed_out, cancelled）与未知状态不得进入 activeOperations
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-3",
          kind: "proxy-test",
          resourceId: null,
          state: "queued",
          stage: null,
          effectiveSource: "manual",
          message: "等待测速",
          progress: null,
          startedAt: "2026-08-25T10:05:00Z",
          updatedAt: "2026-08-25T10:05:00Z",
          finishedAt: null,
          blocksUpdate: false,
        },
      });
    });

    expect(api?.activeOperations.map((o) => o.id)).toEqual(["op-3"]);

    // cancelled
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-3",
          kind: "proxy-test",
          resourceId: null,
          state: "cancelled",
          stage: null,
          effectiveSource: "manual",
          message: "任务已取消",
          progress: null,
          startedAt: "2026-08-25T10:05:00Z",
          updatedAt: "2026-08-25T10:06:00Z",
          finishedAt: "2026-08-25T10:06:00Z",
          blocksUpdate: false,
        },
      });
    });

    expect(api?.activeOperations).toHaveLength(0);

    // 未知/非法状态（如 "unknown_state" 或 "idle"）绝不能进入 activeOperations
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        payload: {
          id: "op-unknown",
          kind: "unknown",
          state: "unknown_custom_state",
          stage: null,
          effectiveSource: null,
          message: null,
          progress: null,
          startedAt: "2026-08-25T10:07:00Z",
          updatedAt: "2026-08-25T10:07:00Z",
          finishedAt: null,
          blocksUpdate: false,
        },
      });
    });

    expect(api?.activeOperations).toHaveLength(0);
    expect(api?.operations.find((o) => o.id === "op-unknown")).toBeDefined();
  });
});
