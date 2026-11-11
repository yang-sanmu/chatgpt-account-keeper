import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { __advanceTickForTests } from "@/lib/useTick";
import { makeAccount, makeBootstrap, makeOperation, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { AccountCard } from "../account-card";
import { AccountsPage } from "../accounts-page";
import { BulkActionBar } from "../bulk-action-bar";

beforeEach(async () => {
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({
    accounts: [makeAccount({ id: "one" }), makeAccount({ id: "two" }), makeAccount({ id: "three" })],
    proxies: {
      subscriptions: [{ id: "source-a", name: "机场 A" }, { id: "source-b", name: "机场 B" }],
      nodes: [
        { id: "enabled", sourceId: "source-a", name: "查询节点", enabled: true },
        { id: "other", sourceId: "source-b", name: "查询节点", enabled: true },
        { id: "disabled", name: "停用节点 B", enabled: false },
      ],
    },
  }));
});

it("一键和批量查优惠调用优惠接口，显示资格并只重试优惠失败项", async () => {
  const call = vi.fn(() => makeOperation({ kind: "account-promo-check", state: "succeeded", result: {
    total: 3, succeeded: 2, successIds: ["one", "three"], failures: [{ id: "two", detail: "缺少 accessToken，请先巡检" }],
    promoResults: { one: "free_trial", three: "none" },
  } }));
  tauri.onMethod("accounts.checkPromos", call);
  tauri.emitAgentEvent("operation.changed", makeOperation({
    id: "legacy-plan", kind: "account-plan-check", state: "succeeded",
    result: { total: 1, succeeded: 0, failures: [{ id: "one", detail: "套餐未确认" }] },
  }));
  tauri.emitAgentEvent("operation.changed", makeOperation({
    id: "interrupted-promo", kind: "account-promo-check", state: "cancelled", message: "Agent 正在退出",
  }));
  useKeeperStore.getState().selectAccounts(["two"]);
  render(<TooltipProvider><AccountsPage /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "一键查优惠" }));
  const oneClick = within(screen.getByRole("dialog", { name: "一键查优惠" }));
  expect(oneClick.getByText("上次任务已中断，可重新开始。")).toBeVisible();
  expect(oneClick.queryByText("Agent 正在退出")).not.toBeInTheDocument();
  expect(oneClick.getByRole("option", { name: "上次失败所有项（0 个）" })).toBeDisabled();

  const start = oneClick.getByRole("button", { name: "开始查询" });
  expect(start).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "执行范围" }), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("combobox", { name: "选择节点" }));
  expect(screen.queryByRole("option", { name: /停用节点 B/ })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "机场 B · 查询节点" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "机场 A · 查询节点" }));
  fireEvent.click(start);

  expect(await oneClick.findByText(/缺少 accessToken，请先巡检/)).toBeInTheDocument();
  expect(oneClick.getByText("成功明细（2 个账号）")).toBeInTheDocument();
  expect(oneClick.getByText(/· 免费试用/)).toBeInTheDocument();
  expect(oneClick.getByText(/· 无优惠/)).toBeInTheDocument();
  expect(call).toHaveBeenCalledWith({ ids: ["one", "two", "three"], proxyId: "enabled" });

  const scope = screen.getByRole("combobox", { name: "执行范围" });
  fireEvent.change(scope, { target: { value: "failed" } });
  expect(screen.getByText("本次查询 1 个账号")).toBeInTheDocument();
  fireEvent.click(start);
  await waitFor(() => expect(call).toHaveBeenLastCalledWith({ ids: ["two"], proxyId: "enabled" }));

  fireEvent.click(oneClick.getByRole("button", { name: "关闭窗口" }));
  fireEvent.click(screen.getByRole("button", { name: "批量查优惠" }));
  const bulk = within(screen.getByRole("dialog", { name: "批量查优惠" }));
  expect(bulk.getByText("本次查询 1 个账号")).toBeInTheDocument();
  fireEvent.click(bulk.getByRole("combobox", { name: "选择节点" }));
  fireEvent.click(screen.getByRole("option", { name: "机场 B · 查询节点" }));
  fireEvent.click(bulk.getByRole("button", { name: "开始查询" }));
  await waitFor(() => expect(call).toHaveBeenLastCalledWith({ ids: ["two"], proxyId: "other" }));
});

it("巡检支持筛选范围、指定节点、实时进度及关闭后重试上次失败项", async () => {
  const first = makeOperation({ id: "one-click", kind: "account-inspection", state: "running", progress: 0 });
  const call = vi.fn(() => first);
  tauri.onMethod("accounts.inspect", call);
  tauri.emitBootstrap(makeBootstrap({
    accounts: [
      makeAccount({ id: "one", gptName: "可见账号" }), makeAccount({ id: "two" }), makeAccount({ id: "three" }),
      makeAccount({ id: "deleted", gptName: "可见账号" }),
    ],
    proxies: {
      subscriptions: [{ id: "source-a", name: "机场 A" }, { id: "source-b", name: "机场 B" }],
      nodes: [
        { id: "enabled", sourceId: "source-a", name: "巡检节点", enabled: true },
        { id: "other", sourceId: "source-b", name: "巡检节点", enabled: true },
        { id: "disabled", name: "停用节点 B", enabled: false },
      ],
    },
  }));
  useKeeperStore.getState().selectAccounts(["two"]);
  useKeeperStore.getState().setAccountFilter({ keyword: "可见账号" });
  render(<TooltipProvider><AccountsPage /></TooltipProvider>);

  fireEvent.click(screen.getByRole("button", { name: "一键巡检" }));
  const oneClick = within(screen.getByRole("dialog", { name: "一键巡检" }));
  expect(oneClick.getByText(/本次巡检 2 个账号/)).toBeInTheDocument();
  expect(oneClick.queryByRole("option", { name: /全部账号/ })).not.toBeInTheDocument();
  expect(oneClick.getByRole("radio", { name: "账号分组节点" })).toBeChecked();
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(oneClick.getByRole("button", { name: "开始巡检" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith({ ids: ["one", "deleted"] }));
  act(() => tauri.emitAgentEvent("operation.changed", {
    ...first, progress: 0.5, message: "已巡检 1/2 个账号，成功 0 个，失败 1 个",
  }));
  expect(oneClick.getByRole("progressbar", { name: "巡检进度" })).toHaveAttribute("aria-valuenow", "50");
  fireEvent.click(oneClick.getByRole("button", { name: "关闭窗口" }));

  fireEvent.click(screen.getByRole("button", { name: "批量巡检" }));
  const bulk = within(screen.getByRole("dialog", { name: "批量巡检" }));
  expect(bulk.queryByRole("combobox", { name: "执行范围" })).not.toBeInTheDocument();
  expect(bulk.getByText("已巡检 1/2 个账号，成功 0 个，失败 1 个")).toBeVisible();
  expect(bulk.getByRole("progressbar", { name: "巡检进度" })).toHaveAttribute("aria-valuenow", "50");
  act(() => {
    tauri.emitAgentEvent("account.removed", { id: "deleted" });
    tauri.emitAgentEvent("operation.changed", {
      ...first, state: "succeeded", progress: 1,
      result: { total: 2, succeeded: 0, successIds: [], failures: [
        { id: "one", detail: "登录已过期" }, { id: "deleted", detail: "账号已删除" },
      ] },
    });
  });
  expect(bulk.getByText(/登录已过期/)).toBeInTheDocument();
  expect(bulk.getByText("本次巡检 1 个账号")).toBeVisible();
  act(() => tauri.emitAgentEvent("operation.changed", {
    ...first, id: "interrupted", state: "cancelled", message: "Agent 重启，任务已中断",
  }));
  expect(bulk.getByText("上次任务已中断，可重新开始。")).toBeVisible();
  expect(bulk.getByText(/登录已过期/)).toBeInTheDocument();
  expect(bulk.getByRole("option", { name: "上次失败所有项（1 个）" })).toBeEnabled();
  fireEvent.change(bulk.getByRole("combobox", { name: "执行范围" }), { target: { value: "failed" } });
  expect(bulk.getByText(/本次巡检 1 个账号/)).toBeInTheDocument();
  fireEvent.click(bulk.getByRole("radio", { name: "指定节点" }));
  const start = bulk.getByRole("button", { name: "开始巡检" });
  expect(start).toBeDisabled();
  fireEvent.click(bulk.getByRole("combobox", { name: "选择节点" }));
  expect(screen.queryByRole("option", { name: /停用节点 B/ })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "机场 A · 巡检节点" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "机场 B · 巡检节点" }));
  call.mockReturnValueOnce(makeOperation({
    id: "retry", kind: "account-inspection", state: "succeeded",
    result: { total: 1, succeeded: 1, successIds: ["one"], failures: [] },
  }));
  fireEvent.click(start);
  await waitFor(() => expect(call).toHaveBeenLastCalledWith({ ids: ["one"], proxyId: "other" }));
  expect(await bulk.findByText("成功明细（1 个账号）")).toBeInTheDocument();
  expect(bulk.getByRole("option", { name: "上次失败所有项（0 个）" })).toBeDisabled();
}, 15_000);

it("只把选中账号的已有 Token 按一行一个复制", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const call = vi.fn(() => ({ tokens: ["first-fixture", "third-fixture"] }));
  tauri.onMethod("accounts.readAccessTokens", call);
  tauri.emitBootstrap(makeBootstrap({ accounts: [
    makeAccount({ id: "one", hasAccessToken: true }),
    makeAccount({ id: "two", hasAccessToken: false }),
    makeAccount({ id: "three", hasAccessToken: true, accessTokenExpiresAt: "2026-01-01T00:00:00.000Z" }),
  ] }));
  useKeeperStore.getState().selectAccounts(["one", "two", "three"]);
  render(<BulkActionBar visibleIds={["one", "two"]} onBulkDelete={() => {}} onCheckPromos={() => {}} onInspect={() => {}} />);
  expect(screen.getByText("已选 3 个 · 2 个有 Token")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "复制 accessToken" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("first-fixture\nthird-fixture"));
  expect(call).toHaveBeenCalledWith({ ids: ["one", "two", "three"] });
});

it("卡片显示巡检返回的到期时间并随时间变为已过期", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const expiresAt = "2026-11-09T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-11-09T09:59:59.000Z"));
    tauri.emitBootstrap(makeBootstrap({ accounts: [makeAccount({ id: "one", hasAccessToken: false })] }));
    render(<TooltipProvider><AccountCard id="one" onDelete={() => {}} /></TooltipProvider>);
    expect(screen.getByText("无 Token")).toHaveClass("text-danger");

    act(() => tauri.emitAgentEvent("accountStatus.changed", { id: "one", hasAccessToken: true, accessTokenExpiresAt: expiresAt }));
    expect(screen.getByText("token正常")).toHaveClass("text-ok");
    expect(screen.getByText(/ 到期$/)).toHaveAttribute("datetime", expiresAt);

    act(() => {
      vi.setSystemTime(new Date(expiresAt));
      __advanceTickForTests();
    });
    expect(screen.getByText("Token 已过期")).toHaveClass("text-danger");

    act(() => tauri.emitAgentEvent("accountStatus.changed", { id: "one", hasAccessToken: true, accessTokenExpiresAt: null }));
    expect(screen.getByText("Token 到期时间未知")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("Token 状态下拉支持同时勾选多项，到期后刷新筛选结果", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const expiresAt = "2026-11-09T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-11-09T09:59:59.000Z"));
    tauri.emitBootstrap(makeBootstrap({ accounts: [
      makeAccount({ id: "none", gptName: "未保存账号", hasAccessToken: false }),
      makeAccount({ id: "future", gptName: "待到期账号", hasAccessToken: true, accessTokenExpiresAt: expiresAt }),
      makeAccount({ id: "past", gptName: "过期账号", hasAccessToken: true, accessTokenExpiresAt: "2026-11-08T10:00:00.000Z" }),
      makeAccount({ id: "unknown", gptName: "到期未知账号", hasAccessToken: true, accessTokenExpiresAt: null }),
    ] }));
    const user = userEvent.setup();
    render(<TooltipProvider><AccountsPage /></TooltipProvider>);

    await user.click(screen.getByRole("button", { name: "Token 状态" }));
    const missing = screen.getByRole("menuitemcheckbox", { name: "无 Token" });
    const expired = screen.getByRole("menuitemcheckbox", { name: "Token 已过期" });
    await user.click(missing);
    await user.click(expired);
    expect(missing).toHaveAttribute("aria-checked", "true");
    expect(expired).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");

    expect(screen.getByText("未保存账号")).toBeInTheDocument();
    expect(screen.getByText("过期账号")).toBeInTheDocument();
    expect(screen.queryByText("待到期账号")).not.toBeInTheDocument();
    expect(screen.queryByText("到期未知账号")).not.toBeInTheDocument();

    act(() => {
      vi.setSystemTime(new Date(expiresAt));
      __advanceTickForTests();
    });
    expect(screen.getByText("待到期账号")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("到期未知账号")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
