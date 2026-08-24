// 用**真实**的 AccountCard 和 AccountsPage 验证记忆化链条真的成立。
//
// accountsRenderCost.test.tsx 证明的是结构性事实（未记忆化的 context value 会让全部子
// 组件重渲染）。这一条更进一步：它渲染真正的组件树，所以任何一环断掉都会红——包括
// AppContext 的 value、AccountsPage 的回调引用、AccountCard 的 memo。
//
// AppProvider 在 mount 时会调 Tauri 的 invoke/listen，jsdom 里没有，所以这里 mock
// @tauri-apps 的两个入口。mock 的是**边界**而不是我们自己的代码。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/// 与 config/accounts.json 当前的真实规模一致。
const REAL_ACCOUNT_COUNT = 28;

/// 卡片渲染函数的执行次数（useAccountActions 的调用次数）。
let cardRenders = 0;
/// 页面级组件的渲染次数（useApp 的调用次数）。只用于诊断输出。
let pageRenders = 0;

/// 由测试主动触发的两个事件通道，不依赖真实 Agent。
let emitBootstrap: ((payload: unknown) => void) | null = null;
let emitAgentEvent: ((payload: unknown) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    switch (command) {
      case "get_startup_info":
        return {
          version: "0.2.0",
          dataDirectory: "C:\\test\\data",
          cacheDirectory: "C:\\test\\cache",
          stateDirectory: "C:\\test\\state",
          agentLogFile: "C:\\test\\state\\agent.log",
          endpoint: "\\\\.\\pipe\\test",
          isDevelopment: true,
          // false：不让 AppProvider 去连 Agent，测试只关心渲染成本。
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
      case "new_command_id":
        return "00000000-0000-4000-8000-000000000000";
      default:
        return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "keeper://bootstrap") {
      emitBootstrap = (payload) => handler({ payload });
    }
    if (name === "keeper://agent-event") {
      emitAgentEvent = (payload) => handler({ payload });
    }
    return () => {};
  }),
}));

/// 计数**真实卡片的渲染函数是否执行**。
///
/// 走过两次错路，都记在这里因为它们是这类测试的典型空转形式：
///
/// 1. 比较 DOM 快照。React 只在输出真的不同时才改 DOM，所以去掉 memo 之后照样通过。
/// 2. 计数 useApp()。卡片改用 useAccountActions 之后它就不再统计卡片了，于是「去掉
///    memo」和「回调不稳定」两种破坏都测不出来。
///
/// 现在计的是 useAccountActions()——卡片函数体真正调用的那个 hook。它被调用一次就等于
/// 那张卡片的渲染函数执行了一次。
vi.mock("../state/AppContext", async () => {
  const actual = await vi.importActual<typeof import("../state/AppContext")>(
    "../state/AppContext"
  );
  return {
    ...actual,
    useApp: () => {
      pageRenders += 1;
      return actual.useApp();
    },
    useAccountActions: () => {
      cardRenders += 1;
      return actual.useAccountActions();
    },
  };
});

function makeAccount(index: number) {
  return {
    id: `acc-${index}`,
    email: `user${index}@example.com`,
    note: `备注 ${index}`,
    enabled: true,
    groupId: null,
    groupName: null,
    switchRule: "random",
    minWindows: 1,
    maxWindows: 3,
    status: index % 4 === 0 ? "needs_login" : "ok",
    statusCheckedAt: "2026-08-24T10:00:00Z",
    stale: false,
    exitNode: null,
    exitNodeMissing: false,
    rotationTopic: "话题",
    rotationDone: 1,
    rotationTarget: 5,
    nextRunAt: null,
    lastRunAt: null,
    lastRunOk: true,
    pageOpen: false,
  };
}

function bootstrapPayload(accounts: ReturnType<typeof makeAccount>[]) {
  return {
    instanceId: "instance-1",
    revision: 1,
    accounts,
    statuses: {},
    openPages: {},
    groups: [],
    proxies: { nodes: [], groups: [] },
    conversations: {},
    scheduler: { running: false },
    settings: {},
    operations: [],
    historyAccounts: [],
    draining: false,
  };
}

describe("真实组件树的记忆化链条", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    cardRenders = 0;
    pageRenders = 0;
    emitBootstrap = null;
    emitAgentEvent = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("一条状态事件只让一张卡片的渲染函数执行", async () => {
    const { AppProvider } = await import("../state/AppContext");
    const { AccountsPage } = await import("../pages/Accounts/AccountsPage");

    await act(async () => {
      root.render(
        <AppProvider>
          <AccountsPage />
        </AppProvider>
      );
    });

    const accounts = Array.from({ length: REAL_ACCOUNT_COUNT }, (_, index) =>
      makeAccount(index)
    );
    await act(async () => {
      emitBootstrap?.(bootstrapPayload(accounts));
    });

    expect(container.querySelectorAll("[data-account-id]").length).toBe(
      REAL_ACCOUNT_COUNT
    );

    // 从这里开始计数：只统计增量事件带来的渲染。
    cardRenders = 0;
    pageRenders = 0;

    // 巡检推来一条 accountStatus.changed：只有 acc-7 从 ok 变成 waf。
    //
    // 这里必须用增量事件而不是再发一次 bootstrap。全量快照会重建所有账号对象，那时
    // 28 张卡片一起重渲染是**正确**行为（重连和序号缺口才走那条路，很少发生）。
    // 每 15 分钟一轮的巡检走的是这条增量路径，它才是卡顿的来源。
    await act(async () => {
      emitAgentEvent?.({
        name: "accountStatus.changed",
        seq: 2,
        instanceId: "instance-1",
        occurredAt: "2026-08-24T10:15:00Z",
        payload: { id: "acc-7", status: "waf" },
      });
    });

    // 只有 acc-7 那一张卡片该重新渲染。AccountsPage 自己会重渲染（它持有筛选与批量
    // 选择状态），那是预期的，用 pageRenders 单独记录以便诊断。
    expect(
      cardRenders,
      `期望 1 张卡片重渲染（acc-7），实际 ${cardRenders} 张；` +
        `记忆化链条断掉时这里是 ${REAL_ACCOUNT_COUNT} 张。` +
        `（页面自身渲染 ${pageRenders} 次，属正常）`
    ).toBe(1);
  });

  it("28 张卡片首屏渲染在预算内", async () => {
    const { AppProvider } = await import("../state/AppContext");
    const { AccountsPage } = await import("../pages/Accounts/AccountsPage");

    await act(async () => {
      root.render(
        <AppProvider>
          <AccountsPage />
        </AppProvider>
      );
    });

    const accounts = Array.from({ length: REAL_ACCOUNT_COUNT }, (_, index) =>
      makeAccount(index)
    );

    const started = performance.now();
    await act(async () => {
      emitBootstrap?.(bootstrapPayload(accounts));
    });
    const elapsed = performance.now() - started;

    expect(container.querySelectorAll("[data-account-id]").length).toBe(
      REAL_ACCOUNT_COUNT
    );
    // jsdom 没有合成器也没有真实布局，这个上限只用来捕捉数量级退化。
    expect(
      elapsed,
      `真实卡片首屏 ${REAL_ACCOUNT_COUNT} 张耗时 ${elapsed.toFixed(0)}ms`
    ).toBeLessThan(2000);
  });
});
