// 会话集重命名是**非原子**的：先 upsert 新名字，再 remove 旧名字。
//
// 关键情形是「第一步成功、第二步失败」——此时磁盘上两个会话集同时存在，而旧代码只报一句
// 「保存会话集失败」。用户会以为什么都没发生，于是重试或放弃，两种选择都留下一个多出来的
// 会话集继续参与调度。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const calls: { method: string; params: Record<string, unknown> }[] = [];
const toasts: { type: string; title: string }[] = [];
/// 让 conversations.remove 失败，复现部分失败。
let failRemove = false;
let emitBootstrap: ((payload: unknown) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "new_command_id") return crypto.randomUUID();
    if (command === "get_startup_info") {
      return {
        version: "0.2.0", dataDirectory: "d", cacheDirectory: "c", stateDirectory: "s",
        agentLogFile: "l", endpoint: "e", isDevelopment: true,
        initialized: false, bootstrapWarning: null,
        settings: {
          theme: "dark", closeBehavior: "ask", startAtLogin: false,
          autoStartScheduler: false, updatePolicy: "notifyOnly",
          ignoredUpdateVersion: null, pendingLegacyImportRoot: null,
        },
      };
    }
    if (command === "agent_call") {
      const method = String(args?.method ?? "");
      calls.push({ method, params: (args?.params ?? {}) as Record<string, unknown> });
      if (method === "conversations.remove" && failRemove) {
        throw { code: "RESOURCE_BUSY", message: "会话集正被调度引用", retryable: true };
      }
      return {};
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
  const actual = await vi.importActual<typeof import("../state/toastStore")>("../state/toastStore");
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (title: string) => { toasts.push({ type: "success", title }); return ""; },
      error: (title: string) => { toasts.push({ type: "error", title }); return ""; },
      info: (title: string) => { toasts.push({ type: "info", title }); return ""; },
      warning: (title: string) => { toasts.push({ type: "warning", title }); return ""; },
    },
  };
});

/// 设置受控 input 的值。
///
/// 直接赋 `input.value` 再派发 input 事件不行：React 会记住上一次的值并把这次判成
/// 「没变化」，于是 onChange 不触发。必须走原生 setter 让 React 的追踪失效。
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("会话集重命名（非原子）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    calls.length = 0;
    toasts.length = 0;
    failRemove = false;
    emitBootstrap = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function openRename() {
    const { AppProvider } = await import("../state/AppContext");
    const { ConversationsPage } = await import("../pages/Conversations/ConversationsPage");
    await act(async () => {
      root.render(<AppProvider><ConversationsPage /></AppProvider>);
    });
    await act(async () => {
      emitBootstrap?.({
        instanceId: "i", revision: 1, accounts: [], statuses: {}, openPages: {},
        groups: [], proxies: { nodes: [], status: {}, subscription: null, runtime: null },
        conversations: { "old-name": { topic: "旧话题", minRounds: 1, maxRounds: 3 } },
        scheduler: { running: false }, settings: {}, operations: [],
        historyAccounts: [], draining: false,
      });
    });

    // 点「编辑」，把名字改掉。
    const editButton = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("编辑"));
    expect(editButton, "找不到编辑按钮").toBeTruthy();
    await act(async () => { editButton?.click(); });

    const nameInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(nameInput, "找不到名称输入框").toBeTruthy();
    return nameInput!;
  }

  it("重命名前必须显示非原子风险提示", async () => {
    const nameInput = await openRename();
    await act(async () => {
      typeInto(nameInput, "new-name");
    });
    // 执行前必须告知失败后果，而不是失败之后才说。
    expect(container.textContent).toContain("非原子");
  });

  it("第一步成功第二步失败时，必须说清两个会话集同时存在", async () => {
    failRemove = true;
    const nameInput = await openRename();
    await act(async () => {
      typeInto(nameInput, "new-name");
    });

    const saveButton = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("保存") || b.textContent?.includes("确定"));
    expect(saveButton, "找不到保存按钮").toBeTruthy();
    await act(async () => { saveButton?.click(); });

    // 两步都发出去了。
    expect(calls.map((c) => c.method)).toEqual([
      "conversations.upsert",
      "conversations.remove",
    ]);

    // 绝不能报成功。
    expect(
      toasts.filter((t) => t.type === "success"),
      `部分失败时出现了成功提示：${JSON.stringify(toasts)}`
    ).toEqual([]);

    // 必须点明当前真实状态：两个都在，需要手动清理旧的。
    const error = toasts.find((t) => t.type === "error");
    expect(error, `实际 toast：${JSON.stringify(toasts)}`).toBeTruthy();
    expect(error?.title).toContain("new-name");
    expect(error?.title).toContain("old-name");
    expect(
      error?.title,
      "没有说明两个会话集同时存在，用户会以为什么都没发生"
    ).toMatch(/两个都存在|同时存在/);
  });
});
