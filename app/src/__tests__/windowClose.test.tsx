// 窗口必须永远能关掉。
//
// Rust 侧对 CloseRequested 调 prevent_close() 并发出 keeper://close-requested，把决定权
// 交给前端。这意味着**前端不响应就等于窗口关不掉**，只能去任务管理器杀进程。
//
// 首次启动页尤其容易漏：MainShell 在 startupInfo.initialized === false 时提前 return
// FirstRunWizard，于是所有全局浮层（含关闭确认框）都不在树里。默认的 closeBehavior 是
// "ask"，它只设置一个 state 等着那个框去渲染——框不存在，点关闭就什么都不发生。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let fireCloseRequested: (() => void) | null = null;
let invoked: string[] = [];
/// 由每个用例设置，模拟用户的关闭行为偏好。
let closeBehavior = "ask";
/// 数据目录是否已建库。false 走首次启动页。
let initialized = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    invoked.push(command);
    if (command === "get_startup_info") {
      return {
        version: "0.2.0",
        dataDirectory: "C:\\t\\data",
        cacheDirectory: "C:\\t\\cache",
        stateDirectory: "C:\\t\\state",
        agentLogFile: "C:\\t\\state\\agent.log",
        endpoint: "\\\\.\\pipe\\t",
        isDevelopment: true,
        initialized,
        bootstrapWarning: null,
        settings: {
          theme: "dark",
          closeBehavior,
          startAtLogin: false,
          autoStartScheduler: false,
          updatePolicy: "notifyOnly",
          ignoredUpdateVersion: null,
          pendingLegacyImportRoot: null,
        },
      };
    }
    if (command === "new_command_id") return "00000000-0000-4000-8000-000000000000";
    if (command === "connect_agent") {
      return { connected: false, status: "未连接", detail: "", agentVersion: null, instanceId: null };
    }
    // 按方法分派，形状照 contracts/ipc-v1.methods.schema.json。返回一个笼统的 {}
    // 会让页面在 Agent 绝不会产生的状态上崩掉，测的就不是真实行为了。
    if (command === "agent_call") {
      const method = String(args?.method ?? "");
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
      if (method === "scheduler.getState") return { running: false };
      if (method === "profiles.scan") return { profiles: [], orphans: [] };
      return {};
    }
    return {};
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    if (name === "keeper://close-requested") fireCloseRequested = handler;
    return () => {};
  }),
}));

describe("窗口关闭", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invoked = [];
    fireCloseRequested = null;
    closeBehavior = "ask";
    initialized = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount() {
    const { App } = await import("../App");
    await act(async () => {
      root.render(<App />);
    });
  }

  it("首次启动页也能关闭：默认的「每次询问」必须弹出确认框", async () => {
    await mount();
    // 确认我们真的在首次启动页上。
    expect(container.textContent).toContain("欢迎使用");

    await act(async () => {
      fireCloseRequested?.();
    });

    // 关闭确认框必须出现。它不出现就意味着窗口永远关不掉——用户只能去任务管理器。
    expect(
      container.textContent,
      "首次启动页收到 close-requested 后没有任何反应，窗口关不掉"
    ).toContain("关闭窗口偏好");
  });

  it("首次启动页选择「退出全部」时直接退出", async () => {
    closeBehavior = "exitAll";
    await mount();
    invoked = [];

    await act(async () => {
      fireCloseRequested?.();
    });

    expect(invoked, `实际调用：${invoked.join(",")}`).toContain("exit_all");
  });

  it("首次启动页选择「隐藏到托盘」时隐藏窗口", async () => {
    closeBehavior = "minimizeToTray";
    await mount();
    invoked = [];

    await act(async () => {
      fireCloseRequested?.();
    });

    expect(invoked, `实际调用：${invoked.join(",")}`).toContain("hide_to_tray");
  });

  it("主界面同样能关闭", async () => {
    initialized = true;
    await mount();
    expect(container.textContent).not.toContain("欢迎使用");

    await act(async () => {
      fireCloseRequested?.();
    });

    expect(container.textContent).toContain("关闭窗口偏好");
  });
});
