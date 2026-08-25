// M3 门禁：批量操作。
//
// 三条要求，各自对应一个已经发生过或很容易发生的缺陷：
//
// 1. 串行执行。浏览器类操作一次一个——并发提交 28 个 runNow 会同时拉起 28 个 Chrome。
// 2. 结果必须如实汇总。部分失败时报 success 会让用户以为 28 个都成功了。
// 3. 批量结果要真的应用到卡片上。用错了 reducer 的话界面上开关不动，用户会再点一次。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/// 记录每次 agent_call 的方法名与调用/返回时刻，用来判断是否串行。
interface CallRecord {
  method: string;
  params: Record<string, unknown>;
  startedAt: number;
  finishedAt: number;
}

let calls: CallRecord[] = [];
/// 让指定账号的调用失败，用来验证部分失败的汇总。
let failFor = new Set<string>();
let emitBootstrap: ((payload: unknown) => void) | null = null;
/// 捕获 toast，验证「部分失败」不会被报成成功。
const toasts: { type: string; title: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "new_command_id") return crypto.randomUUID();
    if (command === "get_startup_info") {
      return {
        version: "0.2.0",
        dataDirectory: "C:\\t\\data",
        cacheDirectory: "C:\\t\\cache",
        stateDirectory: "C:\\t\\state",
        agentLogFile: "C:\\t\\state\\agent.log",
        endpoint: "\\\\.\\pipe\\t",
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
    if (command !== "agent_call") return null;

    const method = String(args?.method ?? "");
    const params = (args?.params ?? {}) as Record<string, unknown>;
    const startedAt = performance.now();
    // 真实的浏览器类调用是慢的。给一点延迟才能观察到重叠。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const record: CallRecord = {
      method,
      params,
      startedAt,
      finishedAt: performance.now(),
    };
    calls.push(record);

    const id = String(params.id ?? "");
    if (failFor.has(id)) {
      throw { code: "PROFILE_IN_USE", message: `Profile 被占用：${id}`, retryable: false };
    }
    if (method === "accounts.update") {
      const patch = (params.patch ?? {}) as Record<string, unknown>;
      return { ...makeRawAccount(id), ...patch };
    }
    return {};
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "keeper://bootstrap") emitBootstrap = (p) => handler({ payload: p });
    return () => {};
  }),
}));

vi.mock("../state/toastStore", async () => {
  const actual = await vi.importActual<typeof import("../state/toastStore")>(
    "../state/toastStore"
  );
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (title: string) => {
        toasts.push({ type: "success", title });
        return "";
      },
      error: (title: string) => {
        toasts.push({ type: "error", title });
        return "";
      },
      info: (title: string) => {
        toasts.push({ type: "info", title });
        return "";
      },
      warning: (title: string) => {
        toasts.push({ type: "warning", title });
        return "";
      },
    },
  };
});

function makeRawAccount(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    note: "",
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
    pageOpen: false,
  };
}

function bootstrapPayload(ids: string[]) {
  return {
    instanceId: "instance-1",
    revision: 1,
    accounts: ids.map(makeRawAccount),
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

/// 挂一个探针组件，把 context 暴露给测试。
type Api = import("../state/AppContext").AppContextValue;
let api: Api | null = null;

describe("M3：批量操作", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    calls = [];
    failFor = new Set();
    toasts.length = 0;
    api = null;
    emitBootstrap = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(ids: string[]) {
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
      emitBootstrap?.(bootstrapPayload(ids));
    });
  }

  it("批量运行串行执行，不会同时拉起多个 Chrome", async () => {
    const ids = ["acc-1", "acc-2", "acc-3", "acc-4", "acc-5"];
    await mount(ids);

    await act(async () => {
      await api?.bulkRunNow(ids);
    });

    const runs = calls.filter((call) => call.method === "accounts.runNow");
    expect(runs).toHaveLength(ids.length);

    // 串行的判据：每一次调用都在前一次返回之后才开始。并发提交会让区间重叠，
    // 而每个 runNow 会拉起一个真实 Chrome —— 28 个账号同时开是不可接受的。
    const overlaps = runs
      .slice(1)
      .map((call, index) => ({ call, previous: runs[index]! }))
      .filter(({ call, previous }) => call.startedAt < previous.finishedAt);

    expect(
      overlaps.map(({ call }) => call.params.id),
      `有 ${overlaps.length} 次调用与前一次重叠，说明并发提交了`
    ).toEqual([]);
  });

  it("部分失败时不报成功，并说出失败的数量", async () => {
    const ids = ["acc-1", "acc-2", "acc-3", "acc-4"];
    await mount(ids);
    failFor = new Set(["acc-2", "acc-4"]);

    await act(async () => {
      await api?.bulkRunNow(ids);
    });

    // 2 个成功 2 个失败。
    //
    // 断言的是「整批操作里没有任何一条 success」，而不是「最后一条不是 success」：
    // 后者太弱，先报 success 再报 error 也能通过，而用户看到的是两条互相矛盾的提示。
    const successes = toasts.filter((entry) => entry.type === "success");
    expect(
      successes,
      `部分失败时不该出现任何成功提示。实际 toast：${JSON.stringify(toasts)}`
    ).toEqual([]);

    const errors = toasts.filter((entry) => entry.type === "error");
    expect(errors.length, `实际 toast：${JSON.stringify(toasts)}`).toBeGreaterThan(0);
    // 失败数量要说出来，否则用户不知道该重试几个。
    expect(errors.some((entry) => entry.title.includes("2"))).toBe(true);
  });

  it("批量启用把结果应用到卡片上", async () => {
    const ids = ["acc-1", "acc-2", "acc-3"];
    await mount(ids);

    // 全部先置为停用，作为一个明确的起点。
    await act(async () => {
      await api?.bulkEnable(ids, false);
    });

    for (const id of ids) {
      expect(
        api?.accountsState.accounts[id]?.effective.enabled,
        `${id} 的 enabled 没有跟随批量操作更新——界面上开关不会动，用户会再点一次`
      ).toBe(false);
    }

    await act(async () => {
      await api?.bulkEnable(ids, true);
    });
    for (const id of ids) {
      expect(api?.accountsState.accounts[id]?.effective.enabled).toBe(true);
    }
  });

  it("批量启用失败的那一项不会被标成已启用", async () => {
    const ids = ["acc-1", "acc-2", "acc-3"];
    await mount(ids);
    failFor = new Set(["acc-2"]);

    await act(async () => {
      await api?.bulkEnable(ids, false);
    });

    expect(api?.accountsState.accounts["acc-1"]?.effective.enabled).toBe(false);
    // acc-2 的请求失败了，它必须保持原值。显示成已停用等于对用户撒谎。
    expect(
      api?.accountsState.accounts["acc-2"]?.effective.enabled,
      "失败的项被标成了已停用"
    ).toBe(true);
    expect(api?.accountsState.accounts["acc-3"]?.effective.enabled).toBe(false);
  });
});
