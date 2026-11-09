import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { __advanceTickForTests } from "@/lib/useTick";
import { makeAccount, makeBootstrap, makeOperation, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { AccountPlanDialog } from "../account-plan-dialog";
import { AccountCard } from "../account-card";
import { AccountsPage } from "../accounts-page";
import { BulkActionBar } from "../bulk-action-bar";

beforeEach(async () => {
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({
    accounts: [makeAccount({ id: "one" }), makeAccount({ id: "two" }), makeAccount({ id: "three" })],
    proxies: { nodes: [{ id: "enabled", name: "查询节点 A", enabled: true }, { id: "disabled", name: "停用节点 B", enabled: false }] },
  }));
});

it("一键查询显式选择节点，显示未取到 Token 的账号", async () => {
  const call = vi.fn(() => makeOperation({ state: "succeeded", result: {
    total: 2, succeeded: 1, failures: [{ id: "two", detail: "缺少 accessToken，请先巡检" }],
  } }));
  tauri.onMethod("accounts.checkPlans", call);
  render(<AccountPlanDialog title="一键查套餐" ids={["one"]} allIds={["one", "two"]} onClose={() => {}} />);

  const start = screen.getByRole("button", { name: "开始查询" });
  expect(start).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /查询全部账号/ }));
  fireEvent.click(screen.getByRole("combobox", { name: "选择节点" }));
  expect(screen.queryByRole("option", { name: "停用节点 B" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "查询节点 A" }));
  fireEvent.click(start);

  expect(await screen.findByText(/缺少 accessToken，请先巡检/)).toBeInTheDocument();
  expect(call).toHaveBeenCalledWith({ ids: ["one", "two"], proxyId: "enabled" });
});

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
  render(<BulkActionBar visibleIds={["one", "two"]} onBulkDelete={() => {}} onCheckPlans={() => {}} />);
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
