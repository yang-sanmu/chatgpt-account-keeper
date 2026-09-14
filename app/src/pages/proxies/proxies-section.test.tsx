import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { ProxiesSection } from "./proxies-section";
import type { ProxyNode } from "@/ipc/types";
import * as bridge from "@/ipc/bridge";

beforeEach(() => {
  vi.restoreAllMocks();
  __resetKeeperStoreForTests();
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
  fireEvent.click(screen.getByRole("button", { name: "新增节点" }));
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "新节点" } });
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "localhost" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.saveCustom", { name: "新节点", protocol: "http", server: "localhost", port: 3000, username: "", password: "" }));
});

it("imports host-first credentials using the selected SOCKS5 protocol and clears the input", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  fireEvent.change(screen.getByLabelText("代理协议"), { target: { value: "socks5" } });
  const input = screen.getByLabelText("自定义 HTTP / SOCKS5 代理");
  fireEvent.change(input, { target: { value: "localhost:1080\\@user:password" } });
  fireEvent.click(screen.getByRole("button", { name: "导入自定义代理" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.importCustom", {
    input: "localhost:1080\\@user:password", protocol: "socks5",
  }));
  await waitFor(() => expect(input).toHaveValue(""));
});
