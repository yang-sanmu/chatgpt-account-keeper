import { beforeEach, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { tauri, makeBootstrap, makeAccount } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { NetworkPage } from "./network-page";
import type { NetworkConfigResult } from "@/ipc/generated";

const network: NetworkConfigResult = {
  config: { mode: "system", relayProxyId: null, systemProxyUrl: null, outboundInterface: null },
  systemProxy: { server: "http://127.0.0.1:7890", source: "windows", detail: "使用 Windows 系统代理入口" },
};
const proxy = (id: string, name: string, type: string, server: string, enabled = true, missing = false) => ({
  id, name, type, server, port: 443, enabled, missing, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null, localPort: null,
});

beforeEach(async () => {
  tauri.reset(); __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.onMethod("network.getConfig", () => network);
  tauri.emitBootstrap(makeBootstrap({ groups: [
    { id: "system-group", name: "系统分组", proxyId: null, timezone: null, locale: null },
    { id: "same", name: "中转同节点组", proxyId: "px_hy", timezone: null, locale: null },
  ] }));
  useKeeperStore.setState((state) => ({ proxies: { ...state.proxies, network, nodes: [
    proxy("px_hy", "Hong Kong HY2", "hysteria2", "hk.example"),
    proxy("custom_us", "US 专用", "http", "us.example"),
    proxy("disabled", "禁用节点", "http", "disabled.example", false),
    proxy("missing", "失效节点", "http", "missing.example", true, true),
  ] } }));
});

it("shows diagrams for all three modes and collapses the system group to one system hop", async () => {
  render(<NetworkPage />);
  await waitFor(() => expect(screen.getByRole("radio", { name: /直连模式/ })).toBeEnabled());
  for (const route of ["浏览器 → 分组专用节点 → 网站", "浏览器 → 系统代理 → 分组专用节点 → 网站", "浏览器 → 指定中转 → 分组专用节点 → 网站", "浏览器 → 系统代理 → 网站"]) {
    expect(screen.getByRole("img", { name: route })).toBeInTheDocument();
  }
});

it("fuzzy-searches subscription and custom nodes, omits unavailable nodes, saves and deduplicates relay preview", async () => {
  const user = userEvent.setup();
  let saved: Record<string, unknown> | undefined;
  tauri.onMethod("network.updateConfig", (params) => { saved = params; return { ...network, config: params }; });
  render(<NetworkPage />);
  await waitFor(() => expect(screen.getByRole("radio", { name: /指定中转/ })).toBeEnabled());
  await user.click(screen.getByRole("radio", { name: /指定中转/ }));
  expect(screen.getByRole("button", { name: "保存网络配置" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "中转节点" }));
  const list = screen.getByRole("listbox");
  expect(within(list).getAllByRole("option")).toHaveLength(2);
  await user.type(screen.getByRole("textbox", { name: "搜索中转节点" }), "HY2 hk");
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{Enter}");
  expect(screen.getAllByRole("img", { name: "浏览器 → Hong Kong HY2 → 网站" })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "保存网络配置" }));
  await waitFor(() => expect(saved).toMatchObject({ mode: "relay", relayProxyId: "px_hy" }));
  expect(useKeeperStore.getState().proxies.network?.config.mode).toBe("relay");
  expect(tauri.calls.find((item) => item.args?.method === "network.updateConfig")?.args?.commandId).toBeDefined();
  await user.click(screen.getByRole("combobox", { name: "中转节点" }));
  await user.type(screen.getByRole("textbox", { name: "搜索中转节点" }), "自定义 us");
  expect(screen.getAllByRole("option")).toHaveLength(1);
});

it("prevents network changes while an account browser is open", async () => {
  const user = userEvent.setup();
  tauri.emitBootstrap(makeBootstrap({ accounts: [makeAccount({ pageOpen: true })] }));
  render(<NetworkPage />);
  await waitFor(() => expect(screen.getByRole("radio", { name: /直连模式/ })).toBeEnabled());
  await user.click(screen.getByRole("radio", { name: /直连模式/ }));
  expect(screen.getByRole("button", { name: "保存网络配置" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("请先关闭账号浏览器");
});

it("preserves spaces when typing a Windows network interface name", async () => {
  const user = userEvent.setup();
  let saved: Record<string, unknown> | undefined;
  tauri.onMethod("network.updateConfig", (params) => { saved = params; return { ...network, config: params }; });
  render(<NetworkPage />);
  await waitFor(() => expect(screen.getByRole("radio", { name: /直连模式/ })).toBeEnabled());
  await user.click(screen.getByRole("radio", { name: /直连模式/ }));
  await user.type(screen.getByLabelText("直出网卡（可选）"), "Ethernet 2");
  expect(screen.getByLabelText("直出网卡（可选）")).toHaveValue("Ethernet 2");
  await user.click(screen.getByRole("button", { name: "保存网络配置" }));
  await waitFor(() => expect(saved).toMatchObject({ mode: "direct", outboundInterface: "Ethernet 2" }));
});

it("keeps newly read and refreshed system entry information when editing a draft", async () => {
  const user = userEvent.setup();
  const fresh = { ...network, systemProxy: { ...network.systemProxy, server: "http://127.0.0.1:1080" } };
  tauri.onMethod("network.getConfig", () => fresh);
  render(<NetworkPage />);
  await screen.findByText(fresh.systemProxy.server);
  await user.type(screen.getByLabelText("入口地址（留空自动检测）"), "http://127.0.0.1:7891");
  expect(screen.getByText(fresh.systemProxy.server)).toBeInTheDocument();
  expect(useKeeperStore.getState().proxies.network?.systemProxy.server).toBe(fresh.systemProxy.server);

  const refreshed = { ...fresh, systemProxy: { ...fresh.systemProxy, server: "http://127.0.0.1:1081" } };
  tauri.onMethod("network.getConfig", () => refreshed);
  await user.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByText(refreshed.systemProxy.server);
  expect(screen.getByLabelText("入口地址（留空自动检测）")).toHaveValue("http://127.0.0.1:7891");
  expect(useKeeperStore.getState().proxies.network?.systemProxy.server).toBe(refreshed.systemProxy.server);
});
