import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { tauri, makeBootstrap, makeOperation } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import type { IcloudState } from "@/ipc/generated";
import { notify } from "@/lib/notify";
import { IcloudPage, parseDeleteInput } from "./icloud-page";

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

it("single delete requires confirmation and sends only the chosen address", async () => {
  const user = userEvent.setup(); let submitted: unknown;
  tauri.onMethod("icloud.delete", params => { submitted = params; return makeOperation({ kind: "icloud-delete", state: "succeeded" }); });
  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "删除 mail0@example.com" }));
  expect(screen.getByLabelText("待删除邮箱（每行一个）")).toHaveValue("mail0@example.com");
  expect(tauri.methodSequence()).not.toContain("icloud.delete");
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(tauri.methodSequence()).not.toContain("icloud.delete");
  await user.click(screen.getByRole("button", { name: "删除 mail0@example.com" }));
  await user.click(screen.getByRole("button", { name: "永久删除 1 个邮箱" }));
  await waitFor(() => expect(submitted).toEqual({ emails: ["mail0@example.com"] }));
});

it("selecting all filtered missing emails removes them from the list after batch deletion", async () => {
  const user = userEvent.setup(); let submitted: unknown;
  const state = { ...initial, emails: initial.emails.map(row => ({ ...row, remoteState: "missing" as const })) };
  useKeeperStore.setState({ icloud: state });
  tauri.onMethod("icloud.delete", params => {
    submitted = params;
    tauri.emitAgentEvent("icloud.changed", { ...state, emails: [], lastMessage: "删除完成：已删除 2 个" });
    return makeOperation({ kind: "icloud-delete", state: "succeeded" });
  });
  render(<IcloudPage />);
  expect(screen.getByRole("button", { name: "删除 mail0@example.com" })).toBeEnabled();
  await user.selectOptions(screen.getByLabelText("云端状态筛选"), "missing");
  await user.click(screen.getByRole("button", { name: "选择全部筛选结果" }));
  await user.click(screen.getByRole("button", { name: "批量删除" }));
  expect(screen.getByLabelText("待删除邮箱（每行一个）")).toHaveValue("mail0@example.com\nmail1@example.com");
  expect(screen.getByText(/同步确认云端不存在的邮箱会移除本地记录/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "永久删除 2 个邮箱" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "删除 mail0@example.com" })).not.toBeInTheDocument());
  expect(submitted).toEqual({ emails: ["mail0@example.com", "mail1@example.com"] });
  expect(useKeeperStore.getState().icloud!.emails).toEqual([]);
});

it("batch deletion accepts multiline input, validates and deduplicates before submission", async () => {
  const user = userEvent.setup(); let submitted: unknown;
  tauri.onMethod("icloud.delete", params => { submitted = params; return makeOperation({ kind: "icloud-delete", state: "succeeded" }); });
  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "批量删除" }));
  const input = screen.getByLabelText("待删除邮箱（每行一个）");
  await user.type(input, "bad address");
  expect(screen.getByRole("alert")).toHaveTextContent("邮箱格式有误");
  expect(screen.getByRole("button", { name: "永久删除 1 个邮箱" })).toBeDisabled();
  await user.clear(input);
  await user.type(input, "MAIL0@example.com\n\nmail1@example.com\nmail0@example.com");
  await user.click(screen.getByRole("button", { name: "永久删除 2 个邮箱" }));
  await waitFor(() => expect(submitted).toEqual({ emails: ["mail0@example.com", "mail1@example.com"] }));
  expect(parseDeleteInput(" a@example.com\r\nA@example.com ").emails).toEqual(["a@example.com"]);
});

it("failed batch stays open with input and does not report success", async () => {
  const user = userEvent.setup();
  tauri.onMethod("icloud.delete", () => makeOperation({ state: "failed", error: { code: "INTERNAL", message: "同步失败", retryable: false, details: null } }));
  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "删除 mail0@example.com" }));
  await user.click(screen.getByRole("button", { name: "永久删除 1 个邮箱" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("删除结果尚未完全确认"));
  expect(screen.getByLabelText("待删除邮箱（每行一个）")).toHaveValue("mail0@example.com");
});

it("an IPC timeout does not claim the backend deletion has stopped", async () => {
  const user = userEvent.setup();
  tauri.onMethod("icloud.delete", () => { throw new Error("请求超时：icloud.delete"); });
  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "删除 mail0@example.com" }));
  await user.click(screen.getByRole("button", { name: "永久删除 1 个邮箱" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.getByRole("alert")).not.toHaveTextContent("已停止");
  expect(screen.getByRole("alert")).toHaveTextContent("同步");
  expect(screen.getByLabelText("待删除邮箱（每行一个）")).toHaveValue("mail0@example.com");
});

for (const status of ["not_logged_in", "needs_login"] as const) {
  it(`shows enabled defaults and a login reminder while ${status}, then clears it after sync`, async () => {
    const user = userEvent.setup();
    const config = { ...initial.config, enabled: true, mode: "until_limit" as const, batchSize: 5, intervalMinutes: 61 };
    const state = { ...initial, config, status, bound: status === "needs_login", nextRunAt: null };
    useKeeperStore.setState({ icloud: state });
    await act(async () => { render(<IcloudPage />); });
    expect(screen.getByRole("alert")).toHaveTextContent("自动申请已开启，但 iCloud 尚未登录或登录已失效");
    expect(screen.getByText(/^下次自动申请：/)).toHaveTextContent("等待登录");
    await user.click(screen.getByRole("button", { name: "申请设置" }));
    expect(screen.getByLabelText("申请模式")).toHaveValue("until_limit");
    expect(screen.getByLabelText("限额后等待（分钟）")).toHaveValue(61);
    expect(screen.getByLabelText("网络模式")).toHaveValue("direct");
    expect(screen.getByRole("switch", { name: "自动申请 · 持续申请" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "取消" }));
    const nextRunAt = "2026-10-23T12:01:00Z";
    act(() => tauri.emitAgentEvent("icloud.changed", { ...state, bound: true, status: "idle", nextRunAt }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/^下次自动申请：/)).toHaveTextContent(new Date(nextRunAt).toLocaleString());
  });
}

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
  await user.click(screen.getByRole("button", { name: "申请设置" }));
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
  await user.click(screen.getByRole("button", { name: "申请设置" }));
  await user.selectOptions(screen.getByLabelText("申请模式"), "batch");
  expect(screen.getByLabelText("每轮申请数量")).toHaveValue(5);
  expect(screen.getByLabelText("轮次间隔（分钟）")).toHaveValue(60);
  await user.click(screen.getByRole("switch", { name: "自动申请 · 持续申请" }));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(submitted).toMatchObject({ enabled: true, mode: "batch", batchSize: 5, intervalMinutes: 60 }));
  await user.click(screen.getByRole("button", { name: "申请设置" }));
  await user.selectOptions(screen.getByLabelText("申请模式"), "until_limit");
  expect(screen.queryByLabelText("每轮申请数量")).not.toBeInTheDocument();
  expect(screen.getByLabelText("限额后等待（分钟）")).toHaveValue(60);
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(submitted).toMatchObject({ enabled: true, mode: "until_limit", intervalMinutes: 60 }));
});

it("live cooldown and pending creation appear without losing unsaved settings", async () => {
  const user = userEvent.setup(); render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "申请设置" }));
  await user.clear(screen.getByLabelText("固定标签 *")); await user.type(screen.getByLabelText("固定标签 *"), "新标签");
  act(() => tauri.emitAgentEvent("icloud.changed", { ...initial, status: "uncertain", pendingEmail: "pending@example.com", lastMessage: "结果待核对" }));
  expect(screen.getByLabelText("固定标签 *")).toHaveValue("新标签");
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("button", { name: "申请 1 个" })).toBeDisabled();
  expect(screen.getByText(/待核对地址：/)).toBeInTheDocument();
  expect(screen.getByText("pending@example.com")).toBeInTheDocument();
});

it("runs one automatic round despite stale browser state and shows the rescheduled time", async () => {
  const user = userEvent.setup();
  await act(async () => { render(<IcloudPage />); });
  const enabled = { ...initial, config: { ...initial.config, enabled: true, mode: "batch" as const, batchSize: 5, intervalMinutes: 60 } };
  act(() => tauri.emitAgentEvent("icloud.changed", { ...enabled, browserOpen: true, busy: true }));
  expect(screen.getByRole("button", { name: "立即执行一轮" })).toBeEnabled();
  const nextRunAt = "2026-10-22T12:00:00Z";
  tauri.onMethod("icloud.runNow", () => {
    tauri.emitAgentEvent("icloud.changed", { ...enabled, nextRunAt, lastMessage: "本轮结束，已申请 5 个邮箱" });
    return makeOperation({ kind: "icloud-runNow", state: "succeeded" });
  });
  await user.click(screen.getByRole("button", { name: "立即执行一轮" }));
  await waitFor(() => expect(tauri.methodSequence()).toContain("icloud.runNow"));
  expect(tauri.methodSequence()).not.toContain("icloud.create");
  expect(screen.getByText(/^下次自动申请：/)).toHaveTextContent(new Date(nextRunAt).toLocaleString());
  expect(screen.getByRole("status")).toHaveTextContent("本轮结束，已申请 5 个邮箱");
});

it("prevents overlapping automatic rounds while keeping stop available", async () => {
  const user = userEvent.setup();
  const enabled = { ...initial, config: { ...initial.config, enabled: true } };
  useKeeperStore.setState({ icloud: enabled });
  tauri.onMethod("icloud.runNow", () => makeOperation({ kind: "icloud-runNow", state: "running" }));
  tauri.onMethod("icloud.stop", () => initial);
  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "立即执行一轮" }));
  expect(screen.getByRole("button", { name: "立即执行一轮" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "停止自动申请" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "停止自动申请" }));
  await waitFor(() => expect(useKeeperStore.getState().icloud!.config.enabled).toBe(false));
  act(() => tauri.emitAgentEvent("operation.changed", makeOperation({ kind: "icloud-runNow", state: "succeeded" })));
  await waitFor(() => expect(screen.getByRole("button", { name: "立即执行一轮" })).toBeEnabled());
  expect(tauri.methodSequence().filter(method => method === "icloud.runNow")).toHaveLength(1);
});

it("shows the backend reason when an automatic round cannot start", async () => {
  const user = userEvent.setup();
  const errorSpy = vi.spyOn(notify, "error");
  const error = { code: "VALIDATION_FAILED" as const, message: "请先保存设置并开启自动申请", retryable: false };
  tauri.onMethod("icloud.runNow", () => makeOperation({ kind: "icloud-runNow", state: "failed", error }));
  try {
    render(<IcloudPage />);
    await user.click(screen.getByRole("button", { name: "立即执行一轮" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("立即执行一轮失败", error));
    expect(screen.getByRole("button", { name: "立即执行一轮" })).toBeEnabled();
  } finally { errorSpy.mockRestore(); }
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

it("runs batch deletion in background without blocking modal, survives remount, and notifies on completion", async () => {
  const user = userEvent.setup();
  const infoSpy = vi.spyOn(notify, "info");
  const successSpy = vi.spyOn(notify, "success");
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const runningOp = makeOperation({
    id: "op-bg-del",
    kind: "icloud-delete",
    resourceId: "icloud_primary",
    state: "running",
    stage: "syncing",
    progress: 0,
    message: "正在同步列表，准备删除 2 个邮箱",
    result: { total: 2, processed: 0, count: 0, skipped: 0, currentEmail: null, remainingEmails: ["mail0@example.com", "mail1@example.com"] },
  });
  tauri.onMethod("icloud.delete", () => runningOp);

  try {
    const view = render(<IcloudPage />);
    await user.click(screen.getByRole("button", { name: "选择当前页" }));
    await user.click(screen.getByRole("button", { name: "批量删除" }));
    await user.click(screen.getByRole("button", { name: "永久删除 2 个邮箱" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(infoSpy).toHaveBeenCalledWith("已转入后台批量删除", expect.stringContaining("2 个邮箱"));
    expect(screen.getByText("正在后台删除")).toBeInTheDocument();
    expect(screen.getByText("正在同步云端列表并准备后台批量删除…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止批量删除" })).toBeEnabled();

    act(() => {
      tauri.emitAgentEvent("operation.changed", {
        ...runningOp,
        stage: "deleting",
        progress: 0.5,
        message: "正在删除 2 / 2：mail1@example.com（已删 1，跳过 0）",
        result: {
          total: 2,
          processed: 1,
          count: 1,
          skipped: 0,
          currentEmail: "mail1@example.com",
          remainingEmails: ["mail1@example.com"],
        },
      });
      tauri.emitAgentEvent("icloud.changed", {
        ...initial,
        status: "deleting",
        busy: true,
        emails: [initial.emails[1]!],
        lastMessage: "正在删除 2 / 2：mail1@example.com",
      });
    });

    expect(screen.getByRole("progressbar", { name: "批量删除进度" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("删除进度 1 / 2（50%）")).toBeInTheDocument();
    expect(screen.getByText("已删 1 · 跳过 0")).toBeInTheDocument();
    expect(screen.getByText("当前：mail1@example.com")).toBeInTheDocument();

    // User can still select and copy remaining emails while background delete is running.
    await user.click(screen.getByRole("checkbox", { name: "选择 mail1@example.com" }));
    await user.click(screen.getByRole("button", { name: "复制选中" }));
    expect(write).toHaveBeenCalledWith("mail1@example.com");

    // Unmount (simulate switching to another page) and remount back to IcloudPage.
    view.unmount();
    const remounted = render(<IcloudPage />);
    expect(remounted.getByRole("progressbar", { name: "批量删除进度" })).toHaveAttribute("aria-valuenow", "50");
    expect(remounted.getByRole("button", { name: "停止批量删除" })).toBeEnabled();

    // Background deletion completes while user is away on another page.
    remounted.unmount();
    act(() => {
      tauri.emitAgentEvent("icloud.changed", {
        ...initial,
        status: "idle",
        busy: false,
        emails: [],
        lastMessage: "删除完成：已删除 2 个，跳过 0 个（本地和云端均未找到）",
      });
      tauri.emitAgentEvent("operation.changed", {
        ...runningOp,
        state: "succeeded",
        stage: "complete",
        progress: 1,
        message: "删除完成：已删除 2 个，跳过 0 个",
        result: { ok: true, count: 2, skipped: 0 },
      });
    });

    await waitFor(() =>
      expect(successSpy).toHaveBeenCalledWith("iCloud 邮箱批量删除完成", "删除完成：已删除 2 个，跳过 0 个")
    );
  } finally {
    infoSpy.mockRestore();
    successSpy.mockRestore();
    write.mockRestore();
  }
});

it("stops background batch deletion and offers one-click retry for remaining emails", async () => {
  const user = userEvent.setup();
  const runningOp = makeOperation({
    id: "op-bg-cancel",
    kind: "icloud-delete",
    resourceId: "icloud_primary",
    state: "running",
    stage: "deleting",
    progress: 0.5,
    message: "正在删除 2 / 2：mail1@example.com",
    result: { total: 2, processed: 1, count: 1, skipped: 0, currentEmail: "mail1@example.com", remainingEmails: ["mail1@example.com"] },
  });
  tauri.onMethod("icloud.delete", () => runningOp);
  tauri.onMethod("icloud.cancelDelete", () => {
    tauri.emitAgentEvent("operation.changed", {
      ...runningOp,
      stage: "cancelling",
      message: "正在停止批量删除（已处理 1 / 2），等待当前邮箱完成…",
    });
    return { ...initial, status: "deleting", busy: true, lastMessage: "正在停止批量删除" };
  });

  render(<IcloudPage />);
  await user.click(screen.getByRole("button", { name: "批量删除" }));
  const input = screen.getByLabelText("待删除邮箱（每行一个）");
  await user.click(input);
  await user.paste("mail0@example.com\nmail1@example.com");
  await user.click(screen.getByRole("button", { name: "永久删除 2 个邮箱" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "停止批量删除" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "停止批量删除" }));
  expect(tauri.methodSequence()).toContain("icloud.cancelDelete");

  act(() => {
    tauri.emitAgentEvent("icloud.changed", {
      ...initial,
      status: "idle",
      busy: false,
      lastMessage: "已停止批量删除：已删除 1 个，跳过 0 个，剩余 1 个未处理",
    });
    tauri.emitAgentEvent("operation.changed", {
      ...runningOp,
      state: "cancelled",
      stage: "cancelled",
      progress: 0.5,
      message: "已停止批量删除：已删除 1 个，跳过 0 个，剩余 1 个未处理",
      result: { ok: false, cancelled: true, total: 2, processed: 1, count: 1, skipped: 0, remainingEmails: ["mail1@example.com"] },
    });
  });

  const recovery = screen.getByRole("region", { name: "未完成的批量删除" });
  expect(recovery).toHaveTextContent("批量删除已停止：已删除 1 个，跳过 0 个，剩余 1 个未处理");
  await user.click(screen.getByRole("button", { name: "继续删除剩余 1 个" }));
  expect(screen.getByLabelText("待删除邮箱（每行一个）")).toHaveValue("mail1@example.com");
});
