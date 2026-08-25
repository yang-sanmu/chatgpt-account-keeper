// M4.5 UI operation 终态语义与 runOperation 严格回归测试
// 验证：
// 1. runOperation 提交后仍 pending，terminal succeeded 才 resolve；
// 2. terminal failed 保留稳定 error；
// 3. 非法 response 与未知状态立即抛出/拒绝，不产生悬挂 waiter；
// 4. terminal 早于 agentCall response 到达的真实竞态能够正确完成并消费定长缓存；
// 5. ProxiesPage 与 ProfilesPage 不在 queued response 后提前 success；
// 6. 批量操作准确统计真实结果、跳过 busy 孤儿、部分失败结构化上报首个错误；
// 7. clean all 无结构化字段时只陈述完成，不虚报已清理全部。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface AgentCallMockConfig {
  delay?: number;
  onCall?: (method: string, params: unknown, cid: string | null) => void;
  resultMap?: Record<string, unknown>;
}

let agentCallConfig: AgentCallMockConfig = {};
const calls: { method: string; params: Record<string, unknown>; id: string }[] = [];
const toasts: { type: string; title: string; err?: unknown }[] = [];
let emitBootstrap: ((payload: unknown) => void) | null = null;
let emitAgentEvent: ((payload: unknown) => void) | null = null;

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
    if (command === "agent_call") {
      const method = String(args?.method ?? "");
      const params = (args?.params ?? {}) as Record<string, unknown>;
      const cid = (args?.commandId ?? null) as string | null;
      const opId = `op-${method.replace(".", "-")}-${calls.length + 1}`;
      calls.push({ method, params, id: opId });

      if (agentCallConfig.onCall) {
        agentCallConfig.onCall(method, params, cid);
      }

      if (agentCallConfig.delay) {
        await new Promise((resolve) => setTimeout(resolve, agentCallConfig.delay));
      }

      if (agentCallConfig.resultMap && method in agentCallConfig.resultMap) {
        return agentCallConfig.resultMap[method];
      }

      return {
        id: opId,
        kind: method,
        state: "queued",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        blocksUpdate: false,
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

vi.mock("../state/toastStore", async () => {
  const actual = await vi.importActual<typeof import("../state/toastStore")>("../state/toastStore");
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (title: string) => {
        toasts.push({ type: "success", title });
        return "";
      },
      error: (title: string, err?: unknown) => {
        toasts.push({ type: "error", title, err });
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

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("M4.5 UI Operation 终态语义与 runOperation 回归测试", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    agentCallConfig = {};
    calls.length = 0;
    toasts.length = 0;
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

  describe("1. runOperation 核心契约与竞态防护", () => {
    it("提交后保持 pending，直到 terminal succeeded 才 resolve", async () => {
      const { AppProvider, useApp } = await import("../state/AppContext");
      type ContextVal = import("../state/AppContext").AppContextValue;
      let contextVal: ContextVal | null = null;

      const TestComponent = () => {
        contextVal = useApp();
        return null;
      };

      await act(async () => {
        root.render(
          <AppProvider>
            <TestComponent />
          </AppProvider>
        );
      });

      expect(contextVal).not.toBeNull();

      let resolved = false;
      let resultOp: any = null;

      const opPromise = contextVal!.runOperation("profiles.cleanCache", { name: "profile-1" });
      opPromise.then((op) => {
        resolved = true;
        resultOp = op;
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(resolved).toBe(false);

      const opId = "op-profiles-cleanCache-1";

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-cache-clean",
            state: "running",
            progress: 0.5,
            message: "正在清理缓存",
          },
        });
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(resolved).toBe(false);

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-cache-clean",
            state: "succeeded",
            progress: 1,
            result: { profilesCleaned: 1, freedBytes: 1024, skipped: [] },
          },
        });
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(resolved).toBe(true);
      expect(resultOp).not.toBeNull();
      expect(resultOp?.state).toBe("succeeded");
      expect((resultOp?.result as { profilesCleaned: number } | undefined)?.profilesCleaned).toBe(1);
    });

    it("terminal failed 时抛出稳定 error", async () => {
      const { AppProvider, useApp } = await import("../state/AppContext");
      type ContextVal = import("../state/AppContext").AppContextValue;
      let contextVal: ContextVal | null = null;

      const TestComponent = () => {
        contextVal = useApp();
        return null;
      };

      await act(async () => {
        root.render(
          <AppProvider>
            <TestComponent />
          </AppProvider>
        );
      });

      let caughtError: unknown = null;
      const opPromise = contextVal!.runOperation("proxies.importSubscription", { url: "invalid" });
      opPromise.catch((err) => {
        caughtError = err;
      });

      const opId = "op-proxies-importSubscription-1";

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "proxy-import",
            state: "failed",
            error: { code: "DOWNLOAD_FAILED", message: "下载订阅失败", retryable: false },
          },
        });
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(caughtError).toEqual({
        code: "DOWNLOAD_FAILED",
        message: "下载订阅失败",
        retryable: false,
      });
    });

    it("非法 response（缺 id 或非对象）必须立即抛出明确 Error 而非返回假数据", async () => {
      const { AppProvider, useApp } = await import("../state/AppContext");
      type ContextVal = import("../state/AppContext").AppContextValue;
      let contextVal: ContextVal | null = null;

      agentCallConfig = {
        resultMap: {
          "profiles.cleanCache": null,
        },
      };

      const TestComponent = () => {
        contextVal = useApp();
        return null;
      };

      await act(async () => {
        root.render(
          <AppProvider>
            <TestComponent />
          </AppProvider>
        );
      });

      await expect(
        contextVal!.runOperation("profiles.cleanCache", { name: "test" })
      ).rejects.toThrow("操作 profiles.cleanCache 调用未返回有效的 Operation 描述符");
    });

    it("未知 operation state 必须立即失败，不可永久注册悬挂 waiter", async () => {
      const { AppProvider, useApp } = await import("../state/AppContext");
      type ContextVal = import("../state/AppContext").AppContextValue;
      let contextVal: ContextVal | null = null;

      agentCallConfig = {
        resultMap: {
          "profiles.cleanCache": {
            id: "op-unknown-1",
            kind: "profile-cache-clean",
            state: "some_unexpected_state",
          },
        },
      };

      const TestComponent = () => {
        contextVal = useApp();
        return null;
      };

      await act(async () => {
        root.render(
          <AppProvider>
            <TestComponent />
          </AppProvider>
        );
      });

      await expect(
        contextVal!.runOperation("profiles.cleanCache", { name: "test" })
      ).rejects.toThrow("处于未知状态: some_unexpected_state");
    });

    it("terminal 事件早于 agentCall response 到达的真实竞态能够正确完成并从缓存中消费", async () => {
      const { AppProvider, useApp } = await import("../state/AppContext");
      type ContextVal = import("../state/AppContext").AppContextValue;
      let contextVal: ContextVal | null = null;

      const TestComponent = () => {
        contextVal = useApp();
        return null;
      };

      const fastOpId = "op-fast-race-1";

      agentCallConfig = {
        delay: 30,
        resultMap: {
          "profiles.archiveOrphan": {
            id: fastOpId,
            kind: "profile-orphan-archive",
            state: "queued",
          },
        },
        onCall: () => {
          setTimeout(() => {
            emitAgentEvent?.({
              name: "operation.changed",
              payload: {
                id: fastOpId,
                kind: "profile-orphan-archive",
                state: "succeeded",
                result: { archived: true },
              },
            });
          }, 5);
        },
      };

      await act(async () => {
        root.render(
          <AppProvider>
            <TestComponent />
          </AppProvider>
        );
      });

      let res: any = null;
      await act(async () => {
        res = await contextVal!.runOperation("profiles.archiveOrphan", { name: "orphan-1" });
      });

      expect(res).not.toBeNull();
      expect(res?.id).toBe(fastOpId);
      expect(res?.state).toBe("succeeded");
      expect((res?.result as { archived: boolean } | undefined)?.archived).toBe(true);
    });
  });

  describe("2. ProxiesPage 终态语义", () => {
    it("importSubscription: queued 响应后不关闭弹窗且不报成功，terminal succeeded 后才关闭并提示", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProxiesPage } = await import("../pages/Proxies/ProxiesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProxiesPage />
          </AppProvider>
        );
      });

      const importBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("导入订阅")
      );
      expect(importBtn).toBeDefined();

      await act(async () => {
        importBtn?.click();
      });

      const input = container.querySelector('input[placeholder*="https://"]') as HTMLInputElement;
      expect(input).not.toBeNull();

      typeInto(input, "https://example.com/subs");

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(calls.some((c) => c.method === "proxies.importSubscription")).toBe(true);
      expect(toasts.some((t) => t.type === "success")).toBe(false);
      expect(container.querySelector('input[placeholder*="https://"]')).not.toBeNull();

      const opId = calls.find((c) => c.method === "proxies.importSubscription")?.id ?? "";

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "proxy-import",
            state: "succeeded",
            result: { nodeCount: 10 },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(toasts.some((t) => t.type === "success" && t.title.includes("订阅已成功导入"))).toBe(true);
      expect(container.querySelector('input[placeholder*="https://"]')).toBeNull();
    });

    it("setNodeEnabled: 仅在 terminal succeeded 后提示启停成功", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProxiesPage } = await import("../pages/Proxies/ProxiesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProxiesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitBootstrap?.({
          instanceId: "inst-1",
          accounts: [],
          groups: [],
          proxies: {
            nodes: [
              {
                id: "node-1",
                name: "香港 01 节点",
                server: "1.2.3.4",
                port: 8080,
                type: "ss",
                enabled: true,
                missing: false,
                latencyMs: 50,
                latencyOk: true,
                latencyMessage: null,
                latencyTestedAt: null,
                localPort: null,
              },
            ],
            status: { running: true },
            subscription: null,
            runtime: null,
          },
          conversations: {},
          scheduler: { running: false, enabled: false, accounts: {} },
          settings: {},
          operations: [],
          historyAccounts: [],
          draining: false,
        });
      });

      const checkbox = container.querySelector('input[type="checkbox"][aria-label*="启用节点"]') as HTMLInputElement;
      expect(checkbox).not.toBeNull();

      await act(async () => {
        checkbox.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(calls.some((c) => c.method === "proxies.setNodeEnabled")).toBe(true);
      expect(toasts.some((t) => t.type === "success")).toBe(false);

      const opId = calls.find((c) => c.method === "proxies.setNodeEnabled")?.id ?? "";

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "proxy-node-toggle",
            state: "succeeded",
            result: { id: "node-1", enabled: false },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(toasts.some((t) => t.type === "success" && t.title.includes("节点已停用"))).toBe(true);
    });
  });

  describe("3. ProfilesPage 终态语义与批量操作", () => {
    it("single cleanCache: terminal result 中 profilesCleaned===0 且 skipped 非空时明确提示跳过占用，不得提示已清理", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProfilesPage } = await import("../pages/Profiles/ProfilesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProfilesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: "op-scan-initial",
            kind: "profile-scan",
            state: "succeeded",
            result: {
              profiles: [
                {
                  name: "profile-busy-single",
                  linked: true,
                  accountIds: ["acc-1"],
                  accountLabels: ["acc1"],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 200,
                  cacheFiles: 2,
                },
              ],
              orphans: [],
              totals: {
                profiles: 1,
                linked: 1,
                orphans: 0,
                bytes: 1000,
                cacheBytes: 200,
                orphanBytes: 0,
                archiveCount: 0,
                archiveBytes: 0,
                trashCount: 0,
                trashBytes: 0,
              },
            },
          },
        });
      });

      const cleanBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("清理缓存")
      );
      expect(cleanBtn).toBeDefined();

      await act(async () => {
        cleanBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认执行")
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      const opId = calls.find(
        (c) => c.method === "profiles.cleanCache" && c.params?.name === "profile-busy-single"
      )?.id ?? "";
      expect(opId).toBeTruthy();

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-cache-clean",
            state: "succeeded",
            result: {
              profilesCleaned: 0,
              freedBytes: 0,
              freedFiles: 0,
              skipped: [{ name: "profile-busy-single", reason: "Profile 被 Chrome 或运行中任务占用" }],
            },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(toasts.some((t) => t.type === "success")).toBe(false);
      expect(toasts.some((t) => t.title.includes("已清理"))).toBe(false);
      expect(
        toasts.some(
          (t) => t.type === "info" && t.title.includes("未执行清理：Profile「profile-busy-single」正被占用")
        )
      ).toBe(true);
    });

    it("确认操作执行期间防止重复提交，loading 状态下禁用操作按钮且阻止关闭", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProfilesPage } = await import("../pages/Profiles/ProfilesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProfilesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: "op-scan-initial",
            kind: "profile-scan",
            state: "succeeded",
            result: {
              profiles: [
                {
                  name: "profile-test-guard",
                  linked: true,
                  accountIds: ["acc-1"],
                  accountLabels: ["acc1"],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 200,
                  cacheFiles: 2,
                },
              ],
              orphans: [],
              totals: {
                profiles: 1,
                linked: 1,
                orphans: 0,
                bytes: 1000,
                cacheBytes: 200,
                orphanBytes: 0,
                archiveCount: 0,
                archiveBytes: 0,
                trashCount: 0,
                trashBytes: 0,
              },
            },
          },
        });
      });

      const cleanBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("清理缓存")
      );
      expect(cleanBtn).toBeDefined();

      await act(async () => {
        cleanBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认执行")
      );
      const cancelBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent === "取消"
      );
      expect(confirmBtn).toBeDefined();
      expect(cancelBtn).toBeDefined();

      // 点击确认执行
      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      // 验证 loading 状态生效
      expect(confirmBtn?.getAttribute("disabled")).not.toBeNull();
      expect(confirmBtn?.textContent).toBe("执行中...");
      expect(cancelBtn?.getAttribute("disabled")).not.toBeNull();

      const initialCallCount = calls.filter((c) => c.method === "profiles.cleanCache").length;
      expect(initialCallCount).toBe(1);

      // 尝试再次点击确认按钮（受 actionRunning 保护不重复触发）
      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(calls.filter((c) => c.method === "profiles.cleanCache").length).toBe(1);

      // 尝试点击弹窗右上角关闭按钮
      const closeBtn = container.querySelector('button[aria-label="关闭窗口"]') as HTMLButtonElement;
      if (closeBtn) {
        await act(async () => {
          closeBtn.click();
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      // 弹窗依然保持打开
      expect(container.querySelector('button[aria-label="关闭窗口"]')).not.toBeNull();

      const opId = calls.find(
        (c) => c.method === "profiles.cleanCache" && c.params?.name === "profile-test-guard"
      )?.id ?? "";

      // 发送终态事件
      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-cache-clean",
            state: "succeeded",
            result: { profilesCleaned: 1, freedBytes: 200, skipped: [] },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      // 弹窗正常关闭
      expect(container.querySelector('button[aria-label="关闭窗口"]')).toBeNull();
      expect(
        toasts.some(
          (t) => t.type === "success" && t.title.includes("已清理 Profile「profile-test-guard」的缓存")
        )
      ).toBe(true);
    });

    it("clean all: terminal result 含 profilesCleaned/skipped 时给出准确摘要；无结构化字段时只陈述完成", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProfilesPage } = await import("../pages/Profiles/ProfilesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProfilesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: "op-scan-initial",
            kind: "profile-scan",
            state: "succeeded",
            result: {
              profiles: [
                {
                  name: "profile-1",
                  linked: true,
                  accountIds: ["acc-1"],
                  accountLabels: ["acc1"],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 200,
                  cacheFiles: 2,
                },
              ],
              orphans: [],
              totals: {
                profiles: 1,
                linked: 1,
                orphans: 0,
                bytes: 1000,
                cacheBytes: 200,
                orphanBytes: 0,
                archiveCount: 0,
                archiveBytes: 0,
                trashCount: 0,
                trashBytes: 0,
              },
            },
          },
        });
      });

      const cleanAllBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("一键清理全部缓存")
      );
      expect(cleanAllBtn).toBeDefined();

      await act(async () => {
        cleanAllBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认执行")
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(calls.some((c) => c.method === "profiles.cleanCache")).toBe(true);
      expect(toasts.some((t) => t.type === "success")).toBe(false);

      const opId = calls.find((c) => c.method === "profiles.cleanCache")?.id ?? "";

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-cache-clean",
            state: "succeeded",
            result: {
              profilesCleaned: 3,
              freedBytes: 1024,
              freedFiles: 10,
              skipped: [{ name: "p-busy", reason: "busy" }],
            },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(
        toasts.some(
          (t) =>
            t.type === "success" &&
            t.title.includes("已清理 3 个 Profile 缓存") &&
            t.title.includes("跳过占用中 1 个")
        )
      ).toBe(true);
    });

    it("clean all: terminal result 缺少已知字段时只陈述完成，不得断言已清理全部", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProfilesPage } = await import("../pages/Profiles/ProfilesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProfilesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: "op-scan-initial",
            kind: "profile-scan",
            state: "succeeded",
            result: {
              profiles: [
                {
                  name: "profile-1",
                  linked: true,
                  accountIds: ["acc-1"],
                  accountLabels: ["acc1"],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 200,
                  cacheFiles: 2,
                },
              ],
              orphans: [],
              totals: {
                profiles: 1,
                linked: 1,
                orphans: 0,
                bytes: 1000,
                cacheBytes: 200,
                orphanBytes: 0,
                archiveCount: 0,
                archiveBytes: 0,
                trashCount: 0,
                trashBytes: 0,
              },
            },
          },
        });
      });

      const cleanAllBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("一键清理全部缓存")
      );
      expect(cleanAllBtn).toBeDefined();

      await act(async () => {
        cleanAllBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认执行")
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      const opId = calls.find((c) => c.method === "profiles.cleanCache")?.id ?? "";

      // 模拟返回空/无特定字段结果
      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-cache-clean",
            state: "succeeded",
            result: {},
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(
        toasts.some(
          (t) => t.type === "success" && t.title === "Profile 缓存清理任务已完成"
        )
      ).toBe(true);
      expect(
        toasts.some(
          (t) => t.title.includes("已清理全部")
        )
      ).toBe(false);
    });

    it("清空全部孤儿：占用中的孤儿不提交并在结果中明确跳过占用数", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProfilesPage } = await import("../pages/Profiles/ProfilesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProfilesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: "op-scan-initial",
            kind: "profile-scan",
            state: "succeeded",
            result: {
              profiles: [
                {
                  name: "orphan-free",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
                {
                  name: "orphan-busy",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: true,
                  bytes: 2000,
                  files: 20,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
              ],
              orphans: [
                {
                  name: "orphan-free",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
                {
                  name: "orphan-busy",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: true,
                  bytes: 2000,
                  files: 20,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
              ],
              totals: {
                profiles: 2,
                linked: 0,
                orphans: 2,
                bytes: 3000,
                cacheBytes: 0,
                orphanBytes: 3000,
                archiveCount: 0,
                archiveBytes: 0,
                trashCount: 0,
                trashBytes: 0,
              },
            },
          },
        });
      });

      const purgeAllBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("清空全部孤儿")
      );
      expect(purgeAllBtn).toBeDefined();

      await act(async () => {
        purgeAllBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认执行")
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      const purgeCalls = calls.filter((c) => c.method === "profiles.purgeOrphan");
      expect(purgeCalls).toHaveLength(1);
      expect(purgeCalls[0]?.params).toEqual({ name: "orphan-free" });

      const opId = purgeCalls[0]?.id ?? "";

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId,
            kind: "profile-orphan-purge",
            state: "succeeded",
            result: { deleted: true },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(
        toasts.some(
          (t) =>
            t.type === "success" &&
            t.title.includes("已彻底永久删除 1 个孤儿 Profile") &&
            t.title.includes("跳过占用中 1 个")
        )
      ).toBe(true);
    });

    it("清空孤儿部分失败时不得出现全部成功，且将首个 terminal.error 传入 toast.error", async () => {
      const { AppProvider } = await import("../state/AppContext");
      const { ProfilesPage } = await import("../pages/Profiles/ProfilesPage");

      await act(async () => {
        root.render(
          <AppProvider>
            <ProfilesPage />
          </AppProvider>
        );
      });

      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: "op-scan-initial",
            kind: "profile-scan",
            state: "succeeded",
            result: {
              profiles: [
                {
                  name: "orphan-1",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
                {
                  name: "orphan-2",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 2000,
                  files: 20,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
              ],
              orphans: [
                {
                  name: "orphan-1",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 1000,
                  files: 10,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
                {
                  name: "orphan-2",
                  linked: false,
                  accountIds: [],
                  accountLabels: [],
                  nonStandardReference: false,
                  busy: false,
                  bytes: 2000,
                  files: 20,
                  cacheBytes: 0,
                  cacheFiles: 0,
                },
              ],
              totals: {
                profiles: 2,
                linked: 0,
                orphans: 2,
                bytes: 3000,
                cacheBytes: 0,
                orphanBytes: 3000,
                archiveCount: 0,
                archiveBytes: 0,
                trashCount: 0,
                trashBytes: 0,
              },
            },
          },
        });
      });

      const purgeAllBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("清空全部孤儿")
      );
      expect(purgeAllBtn).toBeDefined();

      await act(async () => {
        purgeAllBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认执行")
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      const firstPurgeCall = calls.find((c) => c.method === "profiles.purgeOrphan" && c.params?.name === "orphan-1");
      expect(firstPurgeCall).toBeDefined();
      const opId1 = firstPurgeCall!.id;

      // 第一个 orphan-1 成功
      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId1,
            kind: "profile-orphan-purge",
            state: "succeeded",
            result: { deleted: true },
          },
        });
        await new Promise((r) => setTimeout(r, 15));
      });

      const secondPurgeCall = calls.find((c) => c.method === "profiles.purgeOrphan" && c.params?.name === "orphan-2");
      expect(secondPurgeCall).toBeDefined();
      const opId2 = secondPurgeCall!.id;

      const expectedError = { code: "PERMISSION_DENIED", message: "无权限操作此目录", retryable: false };

      // 第二个 orphan-2 失败
      await act(async () => {
        emitAgentEvent?.({
          name: "operation.changed",
          payload: {
            id: opId2,
            kind: "profile-orphan-purge",
            state: "failed",
            error: expectedError,
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(toasts.some((t) => t.type === "success")).toBe(false);
      const errToast = toasts.find((t) => t.type === "error");
      expect(errToast).toBeDefined();
      expect(errToast?.title).toContain("彻底删除孤儿 Profile 部分失败：成功 1 个，失败 1 个");
      // 结构化传入了首个错误对象
      expect(errToast?.err).toEqual(expectedError);
    });
  });
});
