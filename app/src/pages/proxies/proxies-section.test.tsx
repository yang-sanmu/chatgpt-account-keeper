import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { ProxiesSection } from "./proxies-section";
import { GroupsSection } from "./groups-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProxyNode } from "@/ipc/types";
import * as bridge from "@/ipc/bridge";
import { parseCustomProxyInput } from "../../../../src/customProxyInput.js";

beforeEach(() => {
  vi.restoreAllMocks();
  __resetKeeperStoreForTests();
});

it("shows the source and availability of the saved group node", () => {
  const node: ProxyNode = {
    id: "px_a", sourceId: "a", name: "香港 01", type: "http", server: "a.example.test", port: 443,
    enabled: true, missing: false, localPort: null, latencyMs: null, latencyOk: null,
    latencyMessage: null, latencyTestedAt: null,
  };
  const source = { id: "a", name: "机场 A", configured: true, host: "a.example.test",
    updatedAt: null, attemptedAt: null, error: null, count: 1, missingCount: 0 };
  useKeeperStore.setState((state) => ({
    groups: [
      { id: "group-a", name: "分组 A", proxyId: "px_a", timezone: null, locale: null },
      { id: "group-b", name: "分组 B", proxyId: "px_b", timezone: null, locale: null },
    ],
    proxies: {
      ...state.proxies,
      subscriptions: [source, { ...source, id: "b", name: "机场 B", count: 0, missingCount: 1 }],
      nodes: [node, { ...node, id: "px_b", sourceId: "b", missing: true }],
    },
  }));
  render(<TooltipProvider><GroupsSection /></TooltipProvider>);
  expect(screen.getByText("机场 A · 香港 01")).toBeInTheDocument();
  expect(screen.getByText("机场 B · 香港 01（不可用）")).toBeInTheDocument();
});

it("imports several links and retains failed links without retrying duplicates", async () => {
  const first = "https://a.example.test/sub?token=first";
  const second = "https://b.example.test/sub?token=second";
  const runOperation = vi.fn().mockResolvedValue({ result: { results: [
    { index: 0, name: "机场 A", added: 2, updated: 0, removed: 0, skipped: 0 },
    { index: 1, name: "机场 B", error: "无法拉取订阅" },
    { index: 2, name: "机场 A", error: "此链接已存在", duplicate: true },
  ] } });
  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  const links = screen.getByLabelText("订阅链接（每行一条）");
  fireEvent.change(links, { target: { value: `${first}\n${second}\n${first}` } });
  fireEvent.click(screen.getByRole("button", { name: "导入订阅" }));
  await waitFor(() => expect(links).toHaveValue(second));
  expect(runOperation).toHaveBeenCalledWith("proxies.addSubscriptions", { urls: [first, second, first] });
  const report = screen.getByRole("list", { name: "订阅操作结果" });
  expect(report).toHaveTextContent("机场 A · 新增 2");
  expect(report).toHaveTextContent("机场 B · 无法拉取订阅");
  expect(report).toHaveTextContent("机场 A · 此链接已存在");
  expect(report).not.toHaveTextContent("token=");
});

it("collapses subscription nodes and edits custom connection fields without changing the id", async () => {
  const node: ProxyNode = {
    id: "custom_a", name: "自有出口", type: "http", server: "localhost", port: 3000,
    enabled: true, missing: false, localPort: null, latencyMs: null, latencyOk: null,
    latencyMessage: null, latencyTestedAt: null,
  };
  const runOperation = vi.fn().mockResolvedValue({});
  vi.spyOn(bridge, "agentCall").mockResolvedValue({ id: node.id, name: node.name, protocol: "http", server: "localhost", port: 3000, username: "old-user", password: "old-password" });
  useKeeperStore.setState({ runOperation, proxies: { ...useKeeperStore.getState().proxies, nodes: [node, { ...node, id: "px_a", name: "订阅出口" }] } });
  render(<ProxiesSection />);
  const custom = within(screen.getByRole("table", { name: "自定义节点" }));
  expect(screen.queryByRole("table", { name: "订阅节点" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开订阅节点（1）" }));
  const subscription = within(screen.getByRole("table", { name: "订阅节点" }));
  expect(custom.queryByText("订阅出口")).toBeNull();
  expect(subscription.queryByText("自有出口")).toBeNull();
  expect(subscription.queryByRole("button", { name: "删除" })).toBeNull();
  fireEvent.click(custom.getByRole("button", { name: "编辑" }));
  await waitFor(() => expect(screen.getByLabelText("用户名")).toHaveValue("old-user"));
  expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "印度出口" } });
  fireEvent.change(screen.getByLabelText("协议"), { target: { value: "socks5" } });
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "proxy.example.com" } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "1080" } });
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "new-user" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "new-password" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(runOperation).toHaveBeenCalledWith("proxies.saveCustom", { id: "custom_a", name: "印度出口", protocol: "socks5", server: "proxy.example.com", port: 1080, username: "new-user", password: "new-password" });
  fireEvent.click(custom.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.removeCustom", { id: "custom_a" }));
});

it("creates a node in the add dialog without an existing id", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "新节点" } });
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "localhost" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.saveCustom", { name: "新节点", protocol: "http", server: "localhost", port: 3000, username: "", password: "" }));
});

it("recognizes colon credentials in the merged dialog and saves manually adjusted fields only on confirmation", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  expect(screen.queryByLabelText("代理字符串")).toBeNull();
  expect(screen.queryByRole("button", { name: "导入自定义代理" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.change(screen.getByLabelText("协议"), { target: { value: "socks5" } });
  fireEvent.change(screen.getByLabelText("代理字符串"), { target: { value: "192.0.2.1:1080:user:p@ss:word" } });
  fireEvent.click(screen.getByRole("button", { name: "自动识别" }));
  expect(screen.getByLabelText("服务器")).toHaveValue("192.0.2.1");
  expect(screen.getByLabelText("端口")).toHaveValue(1080);
  expect(screen.getByLabelText("用户名")).toHaveValue("user");
  expect(screen.getByLabelText("密码")).toHaveValue("p@ss:word");
  expect(screen.getByLabelText("协议")).toHaveValue("socks5");
  expect(runOperation).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "我的代理" } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "1081" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(runOperation).toHaveBeenCalledWith("proxies.saveCustom", {
    name: "我的代理", protocol: "socks5", server: "192.0.2.1", port: 1081, username: "user", password: "p@ss:word",
  });
});

it("preserves manual fields when recognition fails and clears drafts when reopened", () => {
  const runOperation = vi.fn();
  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "manual.example.com" } });
  fireEvent.change(screen.getByLabelText("代理字符串"), { target: { value: "192.0.2.1:70000:user:secret" } });
  fireEvent.click(screen.getByRole("button", { name: "自动识别" }));
  expect(screen.getByRole("alert")).toHaveTextContent("代理格式无效");
  expect(screen.getByRole("alert")).not.toHaveTextContent("secret");
  expect(screen.getByLabelText("服务器")).toHaveValue("manual.example.com");
  expect(runOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  expect(screen.getByLabelText("代理字符串")).toHaveValue("");
  expect(screen.getByLabelText("服务器")).toHaveValue("");
});

it("refreshes generated names on recognition while preserving a manually entered name", () => {
  render(<ProxiesSection />);
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  const recognize = (server: string) => {
    fireEvent.change(screen.getByLabelText("代理字符串"), { target: { value: `${server}:1080:user:password` } });
    fireEvent.click(screen.getByRole("button", { name: "自动识别" }));
  };
  recognize("192.0.2.1");
  expect(screen.getByLabelText("节点名称")).toHaveValue("HTTP 192.0.2.1:1080");
  recognize("192.0.2.2");
  expect(screen.getByLabelText("节点名称")).toHaveValue("HTTP 192.0.2.2:1080");
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "我的出口" } });
  recognize("192.0.2.3");
  expect(screen.getByLabelText("节点名称")).toHaveValue("我的出口");
});

it("recognizes mixed batch formats and atomically imports the edited forms", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.change(screen.getByLabelText("代理字符串"), { target: { value: 'localhost:1080\\@user:password\nhttps://u:p%40ss@proxy.example.com:443#Office\ncurl --socks5 [::1]:1080 -U "u:p:ss"' } });
  fireEvent.click(screen.getByRole("button", { name: "自动识别" }));
  expect(screen.getAllByLabelText("服务器")).toHaveLength(3);
  expect(screen.getAllByLabelText("协议").map(el => (el as HTMLSelectElement).value)).toEqual(["http", "https", "socks5"]);
  fireEvent.change(screen.getAllByLabelText("密码")[0]!, { target: { value: "edited:@/#" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 3 条代理" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(runOperation).toHaveBeenCalledTimes(1);
  expect(runOperation.mock.calls[0]?.[0]).toBe("proxies.importCustom");
  const parsed = parseCustomProxyInput(runOperation.mock.calls[0]?.[1].input);
  expect(parsed[0]?.password).toBe("edited:@/#");
  expect(parsed[1]).toMatchObject({ name: "Office", protocol: "https", password: "p@ss", port: 443 });
  expect(parsed[2]).toMatchObject({ server: "::1", protocol: "socks5", password: "p:ss" });
});
