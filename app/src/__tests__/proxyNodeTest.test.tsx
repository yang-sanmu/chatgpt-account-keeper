// M3 门禁：测速结果必须回填到节点行，而不是只进任务中心。
//
// 这里的字段名不是猜的，两处形状确实不同：
//
// - `proxies.getState` 的节点（src/proxyManager.js 的 getNodes）用
//   `latencyMs` / `latencyOk` / `latencyMessage` / `latencyTestedAt`。
// - `proxyNode.tested` 事件的 payload 是 `{ id, ...measurement, testedAt }`，
//   而 measurement 来自 rememberLatency，字段是 `ok` / `delay` / `message`。
//
// 只读事件里的 `latencyMs` 会永远拿到 undefined —— 延迟不会出现在行上，而这正是这条
// 要求存在的原因。

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

/// 与 src/proxyManager.js 的 getNodes() 一致。
function rawNode(id: string) {
  return {
    id,
    name: `节点 ${id}`,
    type: "vmess",
    server: "example.com",
    port: 443,
    enabled: true,
    missing: false,
    latencyMs: null,
    latencyOk: null,
    latencyMessage: null,
    latencyTestedAt: null,
    localPort: 7890,
  };
}

function bootstrapPayload(nodeIds: string[]) {
  return {
    instanceId: "instance-1",
    revision: 1,
    accounts: [],
    statuses: {},
    openPages: {},
    groups: [],
    proxies: {
      nodes: nodeIds.map(rawNode),
      status: {},
      subscription: null,
      runtime: null,
    },
    conversations: {},
    scheduler: { running: false },
    settings: {},
    operations: [],
    historyAccounts: [],
    draining: false,
  };
}

type Api = import("../state/AppContext").AppContextValue;
let api: Api | null = null;

describe("M3：测速结果回填到节点行", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    api = null;
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

  async function mount(nodeIds: string[]) {
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
      emitBootstrap?.(bootstrapPayload(nodeIds));
    });
  }

  it("成功的测速把延迟写回那一行", async () => {
    await mount(["node-a", "node-b"]);
    expect(api?.proxies.nodes).toHaveLength(2);

    // Agent 的真实 payload：`{ id, ok, delay, message, testedAt }`。
    await act(async () => {
      emitAgentEvent?.({
        name: "proxyNode.tested",
        seq: 2,
        instanceId: "instance-1",
        occurredAt: "2026-08-24T10:00:00Z",
        payload: {
          id: "node-a",
          ok: true,
          delay: 187,
          message: null,
          testedAt: "2026-08-24T10:00:00Z",
        },
      });
    });

    const tested = api?.proxies.nodes.find((node) => node.id === "node-a");
    expect(
      tested?.latencyMs,
      "延迟没有回填到节点行——事件字段是 delay，不是 latencyMs"
    ).toBe(187);
    expect(tested?.latencyOk).toBe(true);
    expect(tested?.latencyTestedAt).toBe("2026-08-24T10:00:00Z");

    // 其它节点不受影响。
    const untouched = api?.proxies.nodes.find((node) => node.id === "node-b");
    expect(untouched?.latencyMs).toBeNull();
  });

  it("失败的测速把原因写回那一行，而不是留一个空延迟", async () => {
    await mount(["node-a"]);

    await act(async () => {
      emitAgentEvent?.({
        name: "proxyNode.tested",
        seq: 2,
        instanceId: "instance-1",
        occurredAt: "2026-08-24T10:05:00Z",
        payload: {
          id: "node-a",
          ok: false,
          delay: null,
          message: "连接超时",
          testedAt: "2026-08-24T10:05:00Z",
        },
      });
    });

    const tested = api?.proxies.nodes.find((node) => node.id === "node-a");
    expect(tested?.latencyOk).toBe(false);
    expect(
      tested?.latencyMessage,
      "失败原因没有回填——用户只会看到一个空白的延迟列，不知道是没测还是测失败了"
    ).toBe("连接超时");
    expect(tested?.latencyMs).toBeNull();
  });

  it("未知节点的测速事件不会新增一行", async () => {
    await mount(["node-a"]);
    await act(async () => {
      emitAgentEvent?.({
        name: "proxyNode.tested",
        seq: 2,
        instanceId: "instance-1",
        occurredAt: "2026-08-24T10:05:00Z",
        payload: { id: "node-zzz", ok: true, delay: 5, message: null },
      });
    });
    expect(api?.proxies.nodes).toHaveLength(1);
  });
});
