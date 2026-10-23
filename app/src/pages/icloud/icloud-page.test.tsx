import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { tauri, makeBootstrap, makeOperation } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import type { IcloudState } from "@/ipc/generated";
import { IcloudPage } from "./icloud-page";

const initial: IcloudState = {
  config: { enabled: false, intervalMinutes: 15, label: "G", note: "", networkMode: "direct" },
  status: "idle", bound: true, busy: false, browserOpen: false, nextRunAt: null, cooldownUntil: null,
  lastSyncAt: "2026-10-22T10:00:00Z", lastMessage: "已同步", pendingEmail: null, history: [],
  emails: Array.from({ length: 2 }, (_, index) => ({ id: `id${index}`, email: `mail${index}@example.com`,
    label: "G", cloudNote: "云端备注", localNote: "", usage: "unknown", remoteState: "active", createdAt: "2026-10-22T09:00:00Z" })),
};
beforeEach(async () => {
  tauri.reset(); __resetKeeperStoreForTests(); await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({ icloud: structuredClone(initial) }));
  tauri.onMethod("icloud.getState", () => useKeeperStore.getState().icloud);
  tauri.onMethod("icloud.updateLocal", params => {
    const state = useKeeperStore.getState().icloud!;
    return { ...state, emails: state.emails.map(row => (params.ids as string[]).includes(row.id)
      ? { ...row, ...(params.usage ? { usage: params.usage } : {}), ...(params.localNote !== undefined ? { localNote: params.localNote } : {}) } : row) };
  });
});

it("copies selected emails across pages, one per line, without marking ordinary copies used", async () => {
  useKeeperStore.setState({ icloud: { ...initial, emails: Array.from({ length: 52 }, (_, index) => ({ ...initial.emails[0]!, id: `id${index}`, email: `mail${index}@example.com` })) } });
  const user = userEvent.setup(); const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<IcloudPage />);
  await user.click(screen.getByRole("checkbox", { name: "选择 mail0@example.com" }));
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await user.click(screen.getByRole("checkbox", { name: "选择 mail50@example.com" }));
  await user.click(screen.getByRole("button", { name: "复制选中" }));
  expect(write).toHaveBeenCalledWith("mail0@example.com\nmail50@example.com");
  expect(tauri.methodSequence()).not.toContain("icloud.updateLocal");
  write.mockRestore();
}, 15_000);

it("clipboard failure cannot mark emails used", async () => {
  const user = userEvent.setup(); const write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard unavailable"));
  render(<IcloudPage />);
  await user.click(screen.getByRole("checkbox", { name: "选择 mail0@example.com" }));
  await user.click(screen.getByRole("button", { name: "复制并标记已使用" }));
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(tauri.methodSequence()).not.toContain("icloud.updateLocal");
  expect(useKeeperStore.getState().icloud!.emails[0]!.usage).toBe("unknown"); write.mockRestore();
});

it("successful combined copy changes usage only and preserves cloud notes", async () => {
  const user = userEvent.setup(); const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<IcloudPage />);
  await user.click(screen.getByRole("checkbox", { name: "选择 mail0@example.com" }));
  await user.click(screen.getByRole("button", { name: "复制并标记已使用" }));
  await waitFor(() => expect(useKeeperStore.getState().icloud!.emails[0]!.usage).toBe("used"));
  expect(useKeeperStore.getState().icloud!.emails[0]!.cloudNote).toBe("云端备注"); write.mockRestore();
});

it("stores fixed label, cloud note, interval and explicit continuous opt-in", async () => {
  const user = userEvent.setup(); let submitted: Record<string, unknown> | undefined;
  tauri.onMethod("icloud.saveConfig", params => { submitted = params; return { ...initial, config: params }; });
  render(<IcloudPage />);
  await user.clear(screen.getByLabelText("固定标签 *"));
  expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  await user.type(screen.getByLabelText("固定标签 *"), "购物");
  await user.type(screen.getByLabelText("固定 iCloud 备注"), "备用");
  await user.click(screen.getByRole("switch", { name: "自动申请 · 持续申请" }));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(submitted).toEqual({ enabled: true, intervalMinutes: 15, label: "购物", note: "备用", networkMode: "direct" }));
});

it("saves a five-address hourly batch and switches to until-limit without a fixed quantity", async () => {
  const user = userEvent.setup(); let submitted: Record<string, unknown> | undefined;
  tauri.onMethod("icloud.saveConfig", params => { submitted = params; return { ...initial, config: params }; });
  render(<IcloudPage />);
  await user.selectOptions(screen.getByLabelText("申请模式"), "batch");
  expect(screen.getByLabelText("每轮申请数量")).toHaveValue(5);
  expect(screen.getByLabelText("轮次间隔（分钟）")).toHaveValue(60);
  await user.click(screen.getByRole("switch", { name: "自动申请 · 持续申请" }));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(submitted).toMatchObject({ enabled: true, mode: "batch", batchSize: 5, intervalMinutes: 60 }));
  await user.selectOptions(screen.getByLabelText("申请模式"), "until_limit");
  expect(screen.queryByLabelText("每轮申请数量")).not.toBeInTheDocument();
  expect(screen.getByLabelText("限额后等待（分钟）")).toHaveValue(60);
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(submitted).toMatchObject({ enabled: true, mode: "until_limit", intervalMinutes: 60 }));
});

it("live cooldown and pending creation appear without losing unsaved settings", async () => {
  const user = userEvent.setup(); render(<IcloudPage />);
  await user.clear(screen.getByLabelText("固定标签 *")); await user.type(screen.getByLabelText("固定标签 *"), "新标签");
  act(() => tauri.emitAgentEvent("icloud.changed", { ...initial, status: "uncertain", pendingEmail: "pending@example.com", lastMessage: "结果待核对" }));
  expect(screen.getByLabelText("固定标签 *")).toHaveValue("新标签");
  expect(screen.getByRole("button", { name: "申请 1 个" })).toBeDisabled();
  expect(screen.getByText(/待核对地址：pending@example.com/)).toBeInTheDocument();
});

it("opening uses the operation channel and local note editing does not modify cloud fields", async () => {
  const user = userEvent.setup(); tauri.onMethod("icloud.open", () => makeOperation({ state: "succeeded" }));
  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "打开 iCloud / 登录" }));
  await waitFor(() => expect(tauri.methodSequence()).toContain("icloud.open"));
  await user.click(screen.getByRole("button", { name: "编辑 mail0@example.com 的本地备注" }));
  await user.type(screen.getByRole("textbox", { name: "本地备注" }), "已用于购物");
  await user.click(screen.getByRole("button", { name: "保存本地备注" }));
  await waitFor(() => expect(useKeeperStore.getState().icloud!.emails[0]!.localNote).toBe("已用于购物"));
  expect(useKeeperStore.getState().icloud!.emails[0]!.cloudNote).toBe("云端备注");
});
