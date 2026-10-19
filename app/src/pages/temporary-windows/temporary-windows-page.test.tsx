import { beforeEach, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { tauri, makeBootstrap, makeOperation } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { TemporaryWindowsPage } from "./temporary-windows-page";
import type { TemporaryWindowResult } from "@/ipc/generated";

const windowRecord: TemporaryWindowResult = { id: "tmp_a", name: "日本窗口", note: "购物测试", homepage: "https://example.com/",
  proxyId: "custom_jp", createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", timezone: "Asia/Tokyo",
  locale: "ja-JP", exitIp: "203.0.113.1", detectedAt: "2026-10-19T00:00:00Z", proxyName: "日本直连",
  proxyUnavailable: false, state: "closed", openedAt: null };
const node = { id: "custom_jp", name: "日本直连", type: "http", server: "localhost", port: 3000, enabled: true, missing: false,
  latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null, localPort: null };

beforeEach(async () => {
  tauri.reset(); __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({ temporaryWindows: [windowRecord] }));
  useKeeperStore.setState(state => ({ proxies: { ...state.proxies, nodes: [node, { ...node, id: "disabled", name: "停用节点", enabled: false }] } }));
  tauri.onMethod("temporaryWindows.list", () => useKeeperStore.getState().temporaryWindows);
});

it("creates a named window with a node selected directly, then starts automatic detection", async () => {
  const user = userEvent.setup(); let submitted: Record<string, unknown> | undefined;
  tauri.onMethod("temporaryWindows.save", params => { submitted = params; return { ...windowRecord, ...params, id: "tmp_new", timezone: null }; });
  tauri.onMethod("temporaryWindows.detectRegion", () => makeOperation({ state: "succeeded" }));
  render(<TemporaryWindowsPage />);
  await user.click(screen.getByRole("button", { name: "新增窗口" }));
  await user.click(screen.getByLabelText("名称")); await user.paste("临时购物");
  await user.click(screen.getByLabelText("备注")); await user.paste("独立登录态");
  await user.clear(screen.getByLabelText("默认主页"));
  await user.paste("https://example.org/");
  await user.click(screen.getByRole("combobox", { name: "选择出口节点" }));
  expect(screen.queryByRole("option", { name: /停用节点/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: /日本直连/ }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(submitted).toEqual({ name: "临时购物", note: "独立登录态", homepage: "https://example.org/", proxyId: "custom_jp" }));
  await waitFor(() => expect(tauri.methodSequence()).toContain("temporaryWindows.detectRegion"));
  expect(tauri.calls.find(call => call.args?.method === "temporaryWindows.save")?.args?.commandId).toBeDefined();
});

it("cleans only the selected window after explicit confirmation, keeping its configuration visible", async () => {
  const user = userEvent.setup();
  tauri.onMethod("temporaryWindows.clearData", () => makeOperation({ state: "succeeded" }));
  render(<TemporaryWindowsPage />);
  await user.click(screen.getByRole("button", { name: "清理浏览数据" }));
  expect(tauri.methodSequence()).not.toContain("temporaryWindows.clearData");
  expect(screen.getByRole("alertdialog")).toHaveTextContent("名称、备注、默认主页和出口节点配置将保留");
  await user.click(screen.getByRole("button", { name: "确认清理" }));
  await waitFor(() => expect(tauri.calls.find(call => call.args?.method === "temporaryWindows.clearData")?.args?.params).toEqual({ id: "tmp_a" }));
  expect(screen.getByRole("heading", { name: "日本窗口" })).toBeInTheDocument();
  expect(tauri.methodSequence()).not.toContain("temporaryWindows.remove");
});

it("keeps a cleanup confirmation open when another window finishes probing", async () => {
  const user = userEvent.setup();
  const second = { ...windowRecord, id: "tmp_b", name: "第二窗口" };
  useKeeperStore.setState({ temporaryWindows: [windowRecord, second] });
  const probing = makeOperation({ id: "probe-b", kind: "temporary-window-detectRegion", resourceId: second.id, state: "running" });
  tauri.onMethod("temporaryWindows.detectRegion", () => probing);
  render(<TemporaryWindowsPage />);
  await user.click(within(screen.getByRole("article", { name: "临时窗口 第二窗口" })).getByRole("button", { name: "探测时区" }));
  await user.click(within(screen.getByRole("article", { name: "临时窗口 日本窗口" })).getByRole("button", { name: "清理浏览数据" }));
  await act(async () => tauri.emitAgentEvent("operation.changed", { ...probing, state: "succeeded" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("日本窗口");
  expect(screen.getByRole("button", { name: "确认清理" })).toBeEnabled();
  expect(tauri.methodSequence()).not.toContain("temporaryWindows.clearData");
});

it("live state changes block editing and cleanup until Chrome is closed", async () => {
  render(<TemporaryWindowsPage />);
  await waitFor(() => expect(screen.getByRole("button", { name: "打开" })).toBeEnabled());
  act(() => tauri.emitAgentEvent("temporaryWindows.changed", [{ ...windowRecord, state: "open" }]));
  expect(screen.getByRole("button", { name: "清理浏览数据" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "关闭" })).toBeEnabled();
  act(() => tauri.emitAgentEvent("temporaryWindows.changed", [windowRecord]));
  expect(screen.getByRole("button", { name: "清理浏览数据" })).toBeEnabled();
});

it("searches notes and prevents opening unavailable nodes while allowing configuration repair", async () => {
  const user = userEvent.setup(); render(<TemporaryWindowsPage />);
  await user.type(screen.getByRole("textbox", { name: "搜索临时窗口" }), "购物");
  expect(screen.getByRole("article", { name: "临时窗口 日本窗口" })).toBeInTheDocument();
  act(() => useKeeperStore.setState(state => ({ proxies: { ...state.proxies, nodes: [] } })));
  const card = within(screen.getByRole("article", { name: "临时窗口 日本窗口" }));
  expect(card.getByRole("button", { name: "打开" })).toBeDisabled();
  expect(card.getByRole("button", { name: "编辑" })).toBeEnabled();
});
