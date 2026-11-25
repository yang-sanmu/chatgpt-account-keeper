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
    id: "custom_a", name: "自有出口", customKind: "simple", type: "http", server: "localhost", port: 3000,
    enabled: true, missing: false, localPort: null, latencyMs: null, latencyOk: null,
    latencyMessage: null, latencyTestedAt: null,
  };
  const runOperation = vi.fn().mockResolvedValue({});
  vi.spyOn(bridge, "agentCall").mockResolvedValue({ id: node.id, name: node.name, protocol: "http", server: "localhost", port: 3000, username: "old-user", password: "old-password" });
  useKeeperStore.setState({ runOperation, proxies: { ...useKeeperStore.getState().proxies, nodes: [node, { ...node, id: "px_a", customKind: undefined, name: "订阅出口" }] } });
  render(<ProxiesSection />);
  const custom = within(screen.getByRole("table", { name: "自定义节点" }));
  expect(screen.queryByRole("table", { name: "订阅节点" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /订阅节点/ }));
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

it("expands subscription groups independently, supports search, and runs per-group latency test", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  const makeNode = (id: string, sourceId: string, name: string, extra: Partial<ProxyNode> = {}): ProxyNode => ({
    id, sourceId, name, type: "vless", server: `${id}.example.test`, port: 443,
    enabled: true, missing: false, localPort: null, latencyMs: null, latencyOk: null,
    latencyMessage: null, latencyTestedAt: null, ...extra,
  });
  const sourceA = { id: "a", name: "FSCloud", configured: true, host: "a.example.test", updatedAt: null, attemptedAt: null, error: null, count: 1, missingCount: 0 };
  const sourceB = { id: "b", name: "苏菲家宽", configured: true, host: "b.example.test", updatedAt: null, attemptedAt: null, error: null, count: 1, missingCount: 0 };
  useKeeperStore.setState({
    runOperation,
    proxies: {
      ...useKeeperStore.getState().proxies,
      subscriptions: [sourceA, sourceB],
      nodes: [
        makeNode("px_a1", "a", "美国主力", { originalName: "美国-VLESS-8", customNamed: true }),
        makeNode("px_b1", "b", "台湾专线"),
      ],
    },
  });

  render(<ProxiesSection />);
  expect(screen.queryByRole("table", { name: "FSCloud 节点" })).toBeNull();
  expect(screen.queryByRole("table", { name: "苏菲家宽 节点" })).toBeNull();

  // 展开 FSCloud 仅显示其下属节点，不影响苏菲家宽。
  fireEvent.click(screen.getByRole("button", { name: /FSCloud/ }));
  const tableA = within(screen.getByRole("table", { name: "FSCloud 节点" }));
  expect(tableA.getByText("美国主力")).toBeInTheDocument();
  expect(tableA.getByText("原名：美国-VLESS-8")).toBeInTheDocument();
  expect(tableA.queryByText("台湾专线")).toBeNull();
  expect(screen.queryByRole("table", { name: "苏菲家宽 节点" })).toBeNull();

  // 按组测速只测目标订阅源。
  fireEvent.click(screen.getAllByRole("button", { name: "测速本组" })[0]!);
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.testAll", { scope: "source", sourceId: "a" }));

  // 搜索原名或另一分组节点时自动展开命中分组。
  fireEvent.change(screen.getByLabelText("搜索代理节点"), { target: { value: "台湾" } });
  expect(screen.getByRole("table", { name: "苏菲家宽 节点" })).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "FSCloud 节点" })).toBeNull();
});

it("supports naming a subscription during import and renaming or restoring a subscription node", async () => {
  const runOperation = vi.fn().mockResolvedValue({ result: { results: [{ index: 0, name: "自用机场", added: 1, updated: 0, removed: 0, skipped: 0 }] } });
  const subNode: ProxyNode = {
    id: "px_1", sourceId: "src1", name: "美国主力", originalName: "美国-VLESS-8", customNamed: true,
    type: "vless", server: "us.example.test", port: 443, enabled: true, missing: false,
    localPort: null, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null,
  };
  useKeeperStore.setState({
    runOperation,
    proxies: {
      ...useKeeperStore.getState().proxies,
      subscriptions: [{ id: "src1", name: "FSCloud", configured: true, host: "f.example.test", updatedAt: null, attemptedAt: null, error: null, count: 1, missingCount: 0 }],
      nodes: [subNode],
    },
  });

  render(<ProxiesSection />);
  fireEvent.change(screen.getByLabelText("订阅链接（每行一条）"), { target: { value: "https://new.example.test/sub" } });
  fireEvent.change(screen.getByLabelText("订阅别名（选填）"), { target: { value: "自用机场" } });
  fireEvent.click(screen.getByRole("button", { name: "导入订阅" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.addSubscriptions", {
    urls: ["https://new.example.test/sub"],
    names: ["自用机场"],
  }));

  fireEvent.click(screen.getByRole("button", { name: /FSCloud/ }));
  const table = within(screen.getByRole("table", { name: "FSCloud 节点" }));
  fireEvent.click(table.getByRole("button", { name: "重命名" }));
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "北美一号" } });
  fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.renameNode", { id: "px_1", name: "北美一号" }));

  fireEvent.click(table.getByRole("button", { name: "重命名" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复原名" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.renameNode", { id: "px_1", name: null }));
});

it("imports and edits Clash YAML / share URI custom nodes", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  const agentCallSpy = vi.spyOn(bridge, "agentCall").mockImplementation(async (method) => {
    if (method === "proxies.previewCustomConfig") {
      return {
        skipped: 0,
        nodes: [
          { name: "VPS-VLESS", type: "vless", server: "198.51.100.10", port: 56702, yaml: "type: vless\nserver: 198.51.100.10\nport: 56702" },
          { name: "VPS-Hy2", type: "hysteria2", server: "198.51.100.10", port: 443, yaml: "type: hysteria2\nserver: 198.51.100.10\nport: 443" },
        ],
      } as never;
    }
    if (method === "proxies.getCustomConfig") {
      return {
        id: "custom_vps",
        name: "自建-VLESS",
        type: "vless",
        server: "198.51.100.10",
        port: 56702,
        yaml: "type: vless\nserver: 198.51.100.10\nport: 56702",
      } as never;
    }
    return {} as never;
  });

  useKeeperStore.setState({
    runOperation,
    proxies: {
      ...useKeeperStore.getState().proxies,
      nodes: [{
        id: "custom_vps", name: "自建-VLESS", customKind: "yaml", type: "vless", server: "198.51.100.10", port: 56702,
        enabled: true, missing: false, localPort: null, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null,
      }],
    },
  });

  render(<ProxiesSection />);
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.click(screen.getByRole("tab", { name: "Clash YAML / 分享链接" }));
  fireEvent.change(screen.getByLabelText("Clash YAML 或分享链接"), { target: { value: "proxies: []" } });
  fireEvent.click(screen.getByRole("button", { name: "识别节点" }));
  await waitFor(() => expect(screen.getAllByLabelText("节点名称")).toHaveLength(2));
  fireEvent.change(screen.getAllByLabelText("节点名称")[0]!, { target: { value: "我的美国VPS" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 2 个节点" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.saveCustomConfig", {
    items: [
      { name: "我的美国VPS", yaml: "type: vless\nserver: 198.51.100.10\nport: 56702" },
      { name: "VPS-Hy2", yaml: "type: hysteria2\nserver: 198.51.100.10\nport: 443" },
    ],
  }));

  const customTable = within(screen.getByRole("table", { name: "自定义节点" }));
  fireEvent.click(customTable.getByRole("button", { name: "编辑" }));
  await waitFor(() => expect(screen.getByLabelText("节点 YAML 配置")).toHaveValue("type: vless\nserver: 198.51.100.10\nport: 56702"));
  expect(agentCallSpy).toHaveBeenCalledWith("proxies.getCustomConfig", { id: "custom_vps" });
  fireEvent.change(screen.getByLabelText("节点名称"), { target: { value: "自建-VLESS-改" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.saveCustomConfig", {
    id: "custom_vps",
    items: [{ name: "自建-VLESS-改", yaml: "type: vless\nserver: 198.51.100.10\nport: 56702" }],
  }));
});

it("clears stale YAML preview when input changes and preserves leading indentation", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  const previewInputs: string[] = [];
  vi.spyOn(bridge, "agentCall").mockImplementation(async (method, params) => {
    if (method === "proxies.previewCustomConfig") {
      const text = (params as { input: string }).input;
      previewInputs.push(text);
      if (text.includes("BAD")) throw new Error("YAML 格式无效");
      if (text.includes("NODE_B")) {
        return { skipped: 0, nodes: [{ name: "节点B", type: "vless", server: "b.example.test", port: 443, yaml: "type: vless\nserver: b.example.test\nport: 443" }] } as never;
      }
      return { skipped: 0, nodes: [{ name: "节点A", type: "vless", server: "a.example.test", port: 443, yaml: "type: vless\nserver: a.example.test\nport: 443" }] } as never;
    }
    return {} as never;
  });

  useKeeperStore.setState({ runOperation });
  render(<ProxiesSection />);
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.click(screen.getByRole("tab", { name: "Clash YAML / 分享链接" }));

  // 先识别 A
  fireEvent.change(screen.getByLabelText("Clash YAML 或分享链接"), { target: { value: "NODE_A" } });
  fireEvent.click(screen.getByRole("button", { name: "识别节点" }));
  await waitFor(() => expect(screen.getByLabelText("节点名称")).toHaveValue("节点A"));

  // 改成无效输入 B：旧预览 A 必须立即消失，且不能再把 A 保存出去
  fireEvent.change(screen.getByLabelText("Clash YAML 或分享链接"), { target: { value: "BAD" } });
  expect(screen.queryByLabelText("节点名称")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "识别节点" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("YAML 格式无效"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(runOperation).not.toHaveBeenCalled());

  // 改为带首行缩进的有效 YAML B 并直接点保存：保留原始缩进并保存 B
  const indentedB = "  - name: NODE_B\n    type: vless\n    server: b.example.test\n    port: 443";
  fireEvent.change(screen.getByLabelText("Clash YAML 或分享链接"), { target: { value: indentedB } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(runOperation).toHaveBeenCalledWith("proxies.saveCustomConfig", {
    items: [{ name: "节点B", yaml: "type: vless\nserver: b.example.test\nport: 443" }],
  }));
  expect(previewInputs.at(-1)).toBe(indentedB);

  // 重新打开弹窗，先识别 A 再选一个超过 256 KB 的文件：旧输入和预览必须清空，保存按钮不可提交旧节点 A
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.click(screen.getByRole("tab", { name: "Clash YAML / 分享链接" }));
  fireEvent.change(screen.getByLabelText("Clash YAML 或分享链接"), { target: { value: "NODE_A" } });
  fireEvent.click(screen.getByRole("button", { name: "识别节点" }));
  await waitFor(() => expect(screen.getByLabelText("节点名称")).toHaveValue("节点A"));
  const oversized = new File(["x".repeat(262145)], "big.yaml", { type: "text/yaml" });
  fireEvent.change(screen.getByLabelText("选择本地 YAML 文件"), { target: { files: [oversized] } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("文件过大"));
  expect(screen.getByLabelText("Clash YAML 或分享链接")).toHaveValue("");
  expect(screen.queryByLabelText("节点名称")).toBeNull();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
});

it("highlights UDP/HTTP conflicts, toggles per-node directOutbound, and defaults UDP directOutbound on YAML import", async () => {
  const runOperation = vi.fn().mockResolvedValue({});
  vi.spyOn(bridge, "agentCall").mockImplementation(async (method) => {
    if (method === "proxies.previewCustomConfig") {
      return {
        skipped: 0,
        nodes: [
          { name: "VPS-VLESS", type: "vless", server: "198.51.100.10", port: 443, yaml: "type: vless\nserver: 198.51.100.10\nport: 443", udpOnly: false },
          { name: "VPS-HY2", type: "hysteria2", server: "198.51.100.10", port: 443, yaml: "type: hysteria2\nserver: 198.51.100.10\nport: 443", udpOnly: true },
        ],
      } as never;
    }
    return {} as never;
  });

  useKeeperStore.setState({
    runOperation,
    proxies: {
      ...useKeeperStore.getState().proxies,
      network: {
        config: { mode: "system", relayProxyId: null, systemProxyUrl: null, outboundInterface: null, autoOutboundInterface: true },
        systemProxy: { server: "http://127.0.0.1:7900", source: "windows", detail: "使用 Windows 系统代理入口" },
      },
      nodes: [
        {
          id: "custom_hy2", name: "自建 HY2", customKind: "yaml", type: "hysteria2", server: "hy2.example.test", port: 443,
          enabled: true, missing: false, directOutbound: false, udpOnly: true,
          localPort: null, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null,
        },
        {
          id: "custom_res", name: "住宅 HTTP", customKind: "simple", type: "http", server: "res.example.test", port: 8080,
          enabled: true, missing: false, directOutbound: false, udpOnly: false,
          localPort: null, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null,
        },
      ],
    },
  });

  render(<ProxiesSection />);
  expect(screen.getByRole("alert")).toHaveTextContent("当前有 1 个 UDP 节点");
  const customTable = within(screen.getByRole("table", { name: "自定义节点" }));
  expect(customTable.getByRole("button", { name: "开启 自建 HY2 直连出站" })).toHaveTextContent("UDP 冲突");

  fireEvent.click(customTable.getByRole("button", { name: "开启 自建 HY2 直连出站" }));
  await waitFor(() =>
    expect(runOperation).toHaveBeenCalledWith("proxies.setNodeDirectOutbound", { id: "custom_hy2", directOutbound: true })
  );

  fireEvent.click(screen.getByRole("button", { name: "一键设为直连出站（1）" }));
  await waitFor(() =>
    expect(runOperation).toHaveBeenCalledWith("proxies.setNodeDirectOutbound", { ids: ["custom_hy2"], directOutbound: true })
  );

  // Import YAML in HTTP system mode: UDP directOutbound checkbox defaults to checked and only applies to UDP nodes.
  fireEvent.click(screen.getByRole("button", { name: "新增代理" }));
  fireEvent.click(screen.getByRole("tab", { name: "Clash YAML / 分享链接" }));
  fireEvent.change(screen.getByLabelText("Clash YAML 或分享链接"), { target: { value: "proxies: []" } });
  fireEvent.click(screen.getByRole("button", { name: "识别节点" }));
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  fireEvent.click(screen.getByRole("button", { name: "保存 2 个节点" }));
  await waitFor(() =>
    expect(runOperation).toHaveBeenCalledWith("proxies.saveCustomConfig", {
      items: [
        { name: "VPS-VLESS", yaml: "type: vless\nserver: 198.51.100.10\nport: 443" },
        { name: "VPS-HY2", yaml: "type: hysteria2\nserver: 198.51.100.10\nport: 443", directOutbound: true },
      ],
    })
  );
});

it("warns when a relay node reports udpSupported: false for UDP-only downstream nodes", () => {
  useKeeperStore.setState({
    proxies: {
      ...useKeeperStore.getState().proxies,
      network: {
        config: { mode: "relay", relayProxyId: "custom_socks", systemProxyUrl: null, outboundInterface: null, autoOutboundInterface: true },
        systemProxy: { server: null, source: "none", detail: "none" },
      },
      nodes: [
        {
          id: "custom_socks", name: "无UDP中转", customKind: "simple", type: "socks5", server: "relay.example.test", port: 1080,
          enabled: true, missing: false, directOutbound: false, udpOnly: false, udpSupported: false,
          localPort: null, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null,
        },
        {
          id: "custom_hy2", name: "自建 HY2", customKind: "yaml", type: "hysteria2", server: "hy2.example.test", port: 443,
          enabled: true, missing: false, directOutbound: false, udpOnly: true, udpSupported: true,
          localPort: null, latencyMs: null, latencyOk: null, latencyMessage: null, latencyTestedAt: null,
        },
      ],
    },
  });

  render(<ProxiesSection />);
  expect(screen.getByRole("alert")).toHaveTextContent("无UDP中转");
  const customTable = within(screen.getByRole("table", { name: "自定义节点" }));
  expect(customTable.getByRole("button", { name: "开启 自建 HY2 直连出站" })).toHaveTextContent("UDP 冲突");
});
