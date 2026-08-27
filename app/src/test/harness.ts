// 测试用的 Tauri 桩与事件泵。
//
// 这套测试的价值全在于「用 Agent 的真实 payload 驱动真实 store」，所以这里不桩 store，
// 只桩最外层的两个 Tauri 入口（invoke / listen）。事件从这里泵进去，断言看 store 的状态
// 或渲染结果 —— 中间的窄化、合并、筛选逻辑全部真实执行。

import { vi } from "vitest";
import type { Account, Operation } from "@/ipc/types";

export interface InvokeCall {
  command: string;
  args: Record<string, unknown> | undefined;
}

type InvokeHandler = (
  command: string,
  args: Record<string, unknown> | undefined
) => unknown;

interface TauriHarness {
  /// 所有 invoke 调用的时间顺序记录。批量操作的串行性靠它判定。
  calls: InvokeCall[];
  /// 覆盖某个 command 的返回值。返回 Promise 会被 await。
  onInvoke: (command: string, handler: (args: Record<string, unknown> | undefined) => unknown) => void;
  /// 让某个 command 拒绝。
  failInvoke: (command: string, error: unknown) => void;
  /// 按 agent_call 的 method 覆盖返回值。
  onMethod: (method: string, handler: (params: Record<string, unknown>) => unknown) => void;
  failMethod: (method: string, error: unknown) => void;
  emitBootstrap: (payload: unknown) => void;
  emitAgentEvent: (name: string, payload: unknown) => void;
  emitConnection: (payload: unknown) => void;
  emitUpdate: (payload: unknown) => void;
  emitTrayAction: (action: string) => void;
  emitCloseRequested: () => void;
  emitExitProgress: (payload: unknown) => void;
  reset: () => void;
  /// 只保留 method 名的调用序列，便于断言顺序。
  methodSequence: () => string[];
}

const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>();
const commandHandlers = new Map<string, InvokeHandler>();
const methodHandlers = new Map<
  string,
  (params: Record<string, unknown>) => unknown
>();
const calls: InvokeCall[] = [];

function emit(event: string, payload: unknown): void {
  for (const handler of listeners.get(event) ?? []) {
    handler({ payload });
  }
}

export const DEFAULT_STARTUP_INFO = {
  version: "0.2.0",
  dataDirectory: "C:\\test\\data",
  cacheDirectory: "C:\\test\\cache",
  stateDirectory: "C:\\test\\state",
  agentLogFile: "C:\\test\\state\\agent.log",
  endpoint: "\\\\.\\pipe\\test",
  isDevelopment: true,
  initialized: true,
  bootstrapWarning: null,
  settings: {
    theme: "dark" as const,
    closeBehavior: "ask" as const,
    startAtLogin: false,
    autoStartScheduler: false,
    updatePolicy: "notifyOnly" as const,
    ignoredUpdateVersion: null,
    pendingLegacyImportRoot: null,
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });

    if (command === "agent_call") {
      const method = String(args?.method ?? "");
      const handler = methodHandlers.get(method);
      if (handler) return handler((args?.params ?? {}) as Record<string, unknown>);
      return null;
    }

    const handler = commandHandlers.get(command);
    if (handler) return handler(command, args);

    if (command === "get_startup_info") return DEFAULT_STARTUP_INFO;
    if (command === "new_command_id") return "00000000-0000-4000-8000-000000000000";
    if (command === "connect_agent") {
      return { connected: true, status: "已连接", detail: "Agent 就绪" };
    }
    if (command === "check_update") return { state: "up-to-date", message: "已是最新" };
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const existing = listeners.get(name) ?? [];
    existing.push(handler);
    listeners.set(name, existing);
    return () => {
      listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== handler));
    };
  }),
}));

export const tauri: TauriHarness = {
  calls,

  onInvoke(command, handler) {
    commandHandlers.set(command, (_command, args) => handler(args));
  },

  failInvoke(command, error) {
    commandHandlers.set(command, () => Promise.reject(error));
  },

  onMethod(method, handler) {
    methodHandlers.set(method, handler);
  },

  failMethod(method, error) {
    methodHandlers.set(method, () => Promise.reject(error));
  },

  emitBootstrap: (payload) => emit("keeper://bootstrap", payload),

  emitAgentEvent: (name, payload) =>
    emit("keeper://agent-event", {
      name,
      seq: 1,
      instanceId: "instance-1",
      occurredAt: new Date().toISOString(),
      payload,
    }),

  emitConnection: (payload) => emit("keeper://connection", payload),
  emitUpdate: (payload) => emit("keeper://update", payload),
  emitTrayAction: (action) => emit("keeper://tray-action", action),
  emitCloseRequested: () => emit("keeper://close-requested", undefined),
  emitExitProgress: (payload) => emit("keeper://exit", payload),

  reset() {
    listeners.clear();
    commandHandlers.clear();
    methodHandlers.clear();
    calls.length = 0;
  },

  methodSequence() {
    return calls
      .filter((call) => call.command === "agent_call")
      .map((call) => String(call.args?.method ?? ""));
  },
};

// -------------------------------------------------------------------- 造数据

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    email: "user@example.com",
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
    rotationTarget: 0,
    nextRunAt: null,
    lastRunAt: null,
    lastRunOk: null,
    pageOpen: false,
    ...overrides,
  };
}

export function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-1",
    kind: "generic",
    resourceId: null,
    state: "queued",
    stage: null,
    message: null,
    progress: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
    blocksUpdate: false,
    ...overrides,
  };
}

export function makeBootstrap(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    instanceId: "instance-1",
    revision: 1,
    protocol: "1.3",
    agentVersion: "0.2.0",
    accounts: [],
    groups: [],
    proxies: {
      nodes: [],
      status: {
        running: false,
        basePort: 7890,
        basePortShifted: false,
        nodeCount: 0,
        routedNodeCount: 0,
        subscription: null,
        clashVergeDir: null,
        mihomo: { path: null, found: false },
      },
      subscription: null,
      runtime: null,
    },
    conversations: {},
    settings: {
      intervalMinutes: 60,
      jitterMinutes: 10,
      headless: true,
      statusCheckMinutes: 15,
      statusCheckOnStartup: false,
      openPageTimeoutMinutes: 0,
      profileAutoCleanEnabled: false,
    },
    scheduler: { running: false, enabled: false, accounts: {}, lastResults: {} },
    historyAccounts: [],
    operations: [],
    profiles: null,
    draining: false,
    ...overrides,
  };
}

/// 一份结构完整的 profiles.scan 结果。
export function makeProfileScan(
  overrides: {
    profiles?: Record<string, unknown>[];
    orphans?: Record<string, unknown>[];
    totals?: Record<string, number>;
  } = {}
): Record<string, unknown> {
  return {
    profiles: overrides.profiles ?? [],
    orphans: overrides.orphans ?? [],
    totals: {
      profiles: 0,
      linked: 0,
      orphans: 0,
      bytes: 0,
      cacheBytes: 0,
      orphanBytes: 0,
      archiveCount: 0,
      archiveBytes: 0,
      trashCount: 0,
      trashBytes: 0,
      ...overrides.totals,
    },
  };
}

export function makeProfileInfo(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: "profile-1",
    linked: true,
    accountIds: [],
    accountLabels: [],
    nonStandardReference: false,
    busy: false,
    bytes: 1024,
    files: 10,
    cacheBytes: 512,
    cacheFiles: 5,
    ...overrides,
  };
}
