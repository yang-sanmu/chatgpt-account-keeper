import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STARTUP_INFO, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { GlobalOverlays } from "..";

const store = () => useKeeperStore.getState();
const schedulerStarts = () => tauri.methodSequence().filter((method) => method === "scheduler.start");

async function openStartDialog() {
  await act(async () => { await store().startScheduler(); });
  return screen.getByRole("alertdialog", { name: "启动调度，并在以后自动启动吗？" });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await store().bootstrapApp();
});

describe("启动调度时询问自动启动偏好", () => {
  it("未开启自动启动时先询问；取消不启动，下次点击仍询问", async () => {
    const user = userEvent.setup();
    render(<GlobalOverlays />);
    await openStartDialog();
    expect(schedulerStarts()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(schedulerStarts()).toHaveLength(0);
    expect(store().desktopSettings.autoStartScheduler).toBe(false);

    await openStartDialog();
    expect(schedulerStarts()).toHaveLength(0);
  });

  it("仅本次启动不保存偏好，成功后关闭询问框", async () => {
    const user = userEvent.setup();
    render(<GlobalOverlays />);
    await openStartDialog();
    await user.click(screen.getByRole("button", { name: "仅本次启动" }));

    await waitFor(() => expect(schedulerStarts()).toHaveLength(1));
    expect(tauri.calls.filter((call) => call.command === "save_settings")).toHaveLength(0);
    expect(store().desktopSettings.autoStartScheduler).toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("以后自动启动先保存偏好，再启动调度；后续手动启动不再询问", async () => {
    const user = userEvent.setup();
    render(<GlobalOverlays />);
    await openStartDialog();
    await user.click(screen.getByRole("button", { name: "以后自动启动" }));

    await waitFor(() => expect(schedulerStarts()).toHaveLength(1));
    const savedIndex = tauri.calls.findIndex((call) => call.command === "save_settings");
    const startedIndex = tauri.calls.findIndex((call) => call.args?.method === "scheduler.start");
    expect(savedIndex).toBeGreaterThanOrEqual(0);
    expect(savedIndex).toBeLessThan(startedIndex);
    expect(tauri.calls[savedIndex]?.args?.next).toMatchObject({ autoStartScheduler: true });
    expect(store().desktopSettings.autoStartScheduler).toBe(true);

    await act(async () => { await store().startScheduler(); });
    expect(schedulerStarts()).toHaveLength(2);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("偏好保存失败时不启动，保留询问框供用户重试", async () => {
    tauri.failInvoke("save_settings", { code: "INTERNAL", message: "无法写入配置", retryable: true });
    const user = userEvent.setup();
    render(<GlobalOverlays />);
    await openStartDialog();
    await user.click(screen.getByRole("button", { name: "以后自动启动" }));

    expect(schedulerStarts()).toHaveLength(0);
    expect(store().desktopSettings.autoStartScheduler).toBe(false);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "以后自动启动" })).toBeEnabled();
  });

  it("保存尚未完成时不能重复提交启动请求", async () => {
    let finishSaving!: () => void;
    tauri.onInvoke("save_settings", () => new Promise<void>((resolve) => { finishSaving = resolve; }));
    const user = userEvent.setup();
    render(<GlobalOverlays />);
    await openStartDialog();
    const always = screen.getByRole("button", { name: "以后自动启动" });
    await user.click(always);
    await user.click(always);

    expect(always).toBeDisabled();
    expect(tauri.calls.filter((call) => call.command === "save_settings")).toHaveLength(1);
    expect(schedulerStarts()).toHaveLength(0);
    await act(async () => { finishSaving(); });
    await waitFor(() => expect(schedulerStarts()).toHaveLength(1));
  });

  it("托盘启动入口使用同一询问流程", async () => {
    render(<GlobalOverlays />);
    await act(async () => { tauri.emitTrayAction("scheduler-start"); });

    expect(screen.getByRole("alertdialog", { name: "启动调度，并在以后自动启动吗？" })).toBeInTheDocument();
    expect(schedulerStarts()).toHaveLength(0);
    expect(tauri.calls.filter((call) => call.command.startsWith("plugin:window|")).map((call) => call.command)).toEqual([
      "plugin:window|show",
      "plugin:window|unminimize",
      "plugin:window|set_focus",
    ]);
  });

  it("后台已经启动调度时关闭尚未选择的询问框", async () => {
    render(<GlobalOverlays />);
    await openStartDialog();

    act(() => {
      tauri.emitAgentEvent("scheduler.changed", {
        running: true, enabled: true, accounts: {}, lastResults: {},
      });
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    act(() => {
      tauri.emitAgentEvent("scheduler.changed", {
        running: false, enabled: false, accounts: {}, lastResults: {},
      });
    });
    await openStartDialog();
    act(() => {
      tauri.emitBootstrap(makeBootstrap({
        scheduler: { running: true, enabled: true, accounts: {}, lastResults: {} },
      }));
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("已保存的自动启动偏好在应用启动后直接生效", async () => {
    store().teardown();
    tauri.reset();
    __resetKeeperStoreForTests();
    tauri.onInvoke("get_startup_info", () => ({
      ...DEFAULT_STARTUP_INFO,
      settings: { ...DEFAULT_STARTUP_INFO.settings, autoStartScheduler: true },
    }));

    await store().bootstrapApp();
    await waitFor(() => expect(schedulerStarts()).toHaveLength(1));
    expect(store().desktopSettings.autoStartScheduler).toBe(true);
  });
});
