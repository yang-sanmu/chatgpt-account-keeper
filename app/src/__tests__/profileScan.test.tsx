// Profile 扫描走的是**操作**，不是同步返回值。
//
// `profiles.scan` 在契约里返回 operationResult：调用它只拿到一个操作描述符，真正的扫描
// 数据在随后的 `operation.changed`（kind = "profile-scan"，state = "succeeded"）的
// `result` 里。原来 Profile 页 await 那个描述符并去里面找 profiles 数组，永远找不到，于是
// 42 个账号的机器上显示「无 Profile」，而且没有加载指示——因为 loading 早就置回 false 了。
//
// 字段名同样不能猜：`src/profileManager.js` 的 scan() 给的是 `bytes` / `cacheBytes` /
// `linked` / `accountLabels`。

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
let scanCalls = 0;

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
        initialized: true,
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
    if (command === "connect_agent") {
      return {
        connected: true,
        status: "Agent 已连接",
        detail: "",
        agentVersion: "0.1.16",
        instanceId: "instance-1",
      };
    }
    if (command === "agent_call") {
      const method = String(args?.method ?? "");
      if (method === "profiles.scan") {
        scanCalls += 1;
        // Agent 返回的是操作描述符，**不含**任何 profile 数据。
        return {
          id: "op-scan-1",
          kind: "profile-scan",
          state: "queued",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:00Z",
          blocksUpdate: false,
        };
      }
      if (method === "queue.getSnapshot") {
        return {
          queuedTotal: 0,
          waiting: {},
          running: 0,
          closing: 0,
          workSlots: { used: 0, limit: 4 },
          chromeSlots: { used: 0, limit: 4 },
        };
      }
      if (method === "browserRuns.list") {
        return { active: [], recent: [], chromeOccupancy: 0, quarantined: [] };
      }
      return {};
    }
    return {};
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "keeper://bootstrap") emitBootstrap = (p) => handler({ payload: p });
    if (name === "keeper://agent-event") emitAgentEvent = (p) => handler({ payload: p });
    return () => {};
  }),
}));

function bootstrapPayload() {
  return {
    instanceId: "instance-1",
    revision: 1,
    accounts: [],
    statuses: {},
    openPages: {},
    groups: [],
    proxies: { nodes: [], status: {}, subscription: null, runtime: null },
    conversations: {},
    scheduler: { running: false },
    settings: {},
    operations: [],
    historyAccounts: [],
    draining: false,
  };
}

/// 与 src/profileManager.js 的 scan() 输出一致。
function scanResult() {
  const orphan = {
    name: "profile-orphan",
    linked: false,
    accountIds: [],
    accountLabels: [],
    nonStandardReference: false,
    busy: false,
    bytes: 600_000_000,
    files: 3_000,
    cacheBytes: 100_000_000,
    cacheFiles: 900,
  };
  return {
    profiles: [
      {
        name: "profile-a",
        linked: true,
        accountIds: ["acc-1"],
        accountLabels: ["user1@example.com"],
        nonStandardReference: false,
        busy: false,
        bytes: 2_400_000_000,
        files: 12_000,
        cacheBytes: 800_000_000,
        cacheFiles: 5_000,
      },
      orphan,
    ],
    orphans: [orphan],
    totals: {
      profiles: 2,
      linked: 1,
      orphans: 1,
      bytes: 3_000_000_000,
      cacheBytes: 900_000_000,
      orphanBytes: 600_000_000,
      archiveCount: 0,
      archiveBytes: 0,
      trashCount: 0,
      trashBytes: 0,
    },
  };
}

type Api = import("../state/AppContext").AppContextValue;
let api: Api | null = null;

describe("Profile 扫描", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    api = null;
    scanCalls = 0;
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

  async function mount() {
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
      emitBootstrap?.(bootstrapPayload());
    });
  }

  it("扫描结果来自 operation.changed，而不是 profiles.scan 的返回值", async () => {
    await mount();

    await act(async () => {
      await api?.requestProfileScan();
    });

    // 提交之后必须处于「扫描中」：几 GB 的 Profile 目录要扫很久，界面不能看起来是空的。
    expect(api?.profileScanning, "提交扫描后没有进入扫描中状态").toBe(true);
    expect(api?.profileScan, "操作描述符不该被当成扫描结果").toBeNull();

    // 数据随 operation.changed 到达。
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        seq: 2,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:05Z",
        payload: {
          id: "op-scan-1",
          kind: "profile-scan",
          state: "succeeded",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:05Z",
          blocksUpdate: false,
          result: scanResult(),
        },
      });
    });

    expect(api?.profileScanning).toBe(false);
    expect(
      api?.profileScan?.profiles.length,
      "扫描结果没有落地——42 个账号的机器上会显示「无 Profile」"
    ).toBe(2);

    const linked = api?.profileScan?.profiles.find((p) => p.name === "profile-a");
    // 字段名以 profileManager 的 scan() 为准：bytes 而不是 sizeBytes。
    expect(linked?.bytes).toBe(2_400_000_000);
    expect(linked?.cacheBytes).toBe(800_000_000);
    expect(linked?.linked).toBe(true);
    expect(linked?.accountLabels).toEqual(["user1@example.com"]);

    expect(api?.profileScan?.totals.orphans).toBe(1);
    expect(api?.profileScan?.orphans.map((p) => p.name)).toEqual(["profile-orphan"]);
  });

  it("扫描失败也要退出扫描中状态，不能永远转圈", async () => {
    await mount();
    await act(async () => {
      await api?.requestProfileScan();
    });
    expect(api?.profileScanning).toBe(true);

    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        seq: 3,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:05Z",
        payload: {
          id: "op-scan-1",
          kind: "profile-scan",
          state: "failed",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:05Z",
          blocksUpdate: false,
          error: { code: "INTERNAL", message: "读取目录失败", retryable: false },
        },
      });
    });

    expect(api?.profileScanning, "失败后仍停在扫描中，界面会永远转圈").toBe(false);
  });

  it("其它 Profile 操作成功后会自动重新扫描", async () => {
    await mount();
    scanCalls = 0;

    // 清缓存改变了磁盘占用，不重扫的话界面上的体积一直是旧的。
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        seq: 4,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:05Z",
        payload: {
          id: "op-clean-1",
          kind: "profile-cache-clean",
          state: "succeeded",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:05Z",
          blocksUpdate: false,
          result: {},
        },
      });
    });

    expect(scanCalls, "Profile 操作完成后没有重新扫描").toBeGreaterThan(0);
  });

  it("同一操作先后收到 profile.changed 与 operation.changed 只触发一次后续扫描", async () => {
    await mount();
    scanCalls = 0;

    // Agent 先发 profile.changed（旧式通知），随后发 operation.changed（终态）
    await act(async () => {
      emitAgentEvent?.({
        name: "profile.changed",
        seq: 5,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:04Z",
        payload: {
          kind: "profile-cache-clean",
          name: null,
          result: {},
        },
      });
    });

    expect(scanCalls, "profile.changed 不应提前触发扫描").toBe(0);

    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        seq: 6,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:05Z",
        payload: {
          id: "op-clean-2",
          kind: "profile-cache-clean",
          state: "succeeded",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:05Z",
          blocksUpdate: false,
          result: {},
        },
      });
    });

    expect(scanCalls, "operation.changed 终态应只触发恰好一次后续扫描").toBe(1);
  });

  it("带 sizeBytes/isOrphan 或缺少必需 totals 的伪扫描结果不得被当成有效 ProfileScanResult", async () => {
    await mount();

    // 1. 旧式猜测别名 (sizeBytes/isOrphan) 且缺少必需结构
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        seq: 7,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:05Z",
        payload: {
          id: "op-scan-invalid-1",
          kind: "profile-scan",
          state: "succeeded",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:05Z",
          blocksUpdate: false,
          result: {
            profiles: [
              {
                name: "profile-legacy",
                isOrphan: true,
                sizeBytes: 1000,
              },
            ],
            orphans: [],
            totals: {
              profiles: 1,
              linked: 0,
              orphans: 1,
              bytes: 1000,
              cacheBytes: 0,
              orphanBytes: 1000,
              archiveCount: 0,
              archiveBytes: 0,
              trashCount: 0,
              trashBytes: 0,
            },
          },
        },
      });
    });

    expect(api?.profileScan, "带 sizeBytes/isOrphan 的伪数据不应被识别为有效 ProfileScanResult").toBeNull();

    // 2. 缺少必需 totals 的结果
    await act(async () => {
      emitAgentEvent?.({
        name: "operation.changed",
        seq: 8,
        instanceId: "instance-1",
        occurredAt: "2026-08-25T00:00:06Z",
        payload: {
          id: "op-scan-invalid-2",
          kind: "profile-scan",
          state: "succeeded",
          startedAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:06Z",
          blocksUpdate: false,
          result: {
            profiles: [
              {
                name: "profile-a",
                linked: true,
                accountIds: [],
                accountLabels: [],
                nonStandardReference: false,
                busy: false,
                bytes: 1000,
                files: 10,
                cacheBytes: 200,
                cacheFiles: 2,
              },
            ],
            orphans: [],
          },
        },
      });
    });

    expect(api?.profileScan, "缺少必需 totals 不得被当成有效 ProfileScanResult（不能显示补零后的假数据）").toBeNull();
  });
});
