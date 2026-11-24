import * as React from "react";
import { useKeeperStore } from "@/store/keeperStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Activity, ChevronDown, ChevronRight, Play, Search, X } from "lucide-react";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { agentCall, newCommandId } from "@/ipc/bridge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { CustomNodeDialog } from "./custom-node-dialog";
import { NodeRenameDialog } from "./node-rename-dialog";
import { SubscriptionsSection } from "./subscriptions-section";
import type { ProxyNode } from "@/ipc/types";

function matchesQuery(node: ProxyNode, keywords: string[], sourceName?: string) {
  if (!keywords.length) return true;
  const haystack = [
    node.name,
    node.originalName ?? "",
    node.type ?? "",
    node.server ? `${node.server}:${node.port ?? ""}` : "",
    sourceName ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase();
  return keywords.every((keyword) => haystack.includes(keyword));
}

export function ProxiesSection() {
  const proxies = useKeeperStore((s) => s.proxies);
  const runOperation = useKeeperStore((s) => s.runOperation);
  const groups = useKeeperStore((s) => s.groups);

  const [testingTarget, setTestingTarget] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ node: ProxyNode; action: "remove" } | null>(null);
  const [nodeEditor, setNodeEditor] = React.useState<{ id?: string; kind?: "simple" | "yaml" } | null>(null);
  const [renaming, setRenaming] = React.useState<ProxyNode | null>(null);
  const [search, setSearch] = React.useState("");
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [customExpanded, setCustomExpanded] = React.useState(true);
  const [unassignedExpanded, setUnassignedExpanded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const sources = proxies.subscriptions ?? [];
  const sourceIds = React.useMemo(() => new Set(sources.map((source) => source.id)), [sources]);
  const sourceNames = React.useMemo(() => new Map(sources.map((source) => [source.id, source.name])), [sources]);

  const customNodes = React.useMemo(
    () => proxies.nodes.filter((node) => node.id.startsWith("custom_")),
    [proxies.nodes]
  );
  const nodesBySource = React.useMemo(() => {
    const map = new Map<string, ProxyNode[]>();
    for (const source of sources) map.set(source.id, []);
    for (const node of proxies.nodes) {
      if (node.id.startsWith("custom_")) continue;
      if (node.sourceId && map.has(node.sourceId)) {
        map.get(node.sourceId)!.push(node);
      }
    }
    return map;
  }, [proxies.nodes, sources]);
  const unassignedNodes = React.useMemo(
    () => proxies.nodes.filter((node) => !node.id.startsWith("custom_") && (!node.sourceId || !sourceIds.has(node.sourceId))),
    [proxies.nodes, sourceIds]
  );

  const keywords = React.useMemo(
    () => search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),
    [search]
  );
  const searching = keywords.length > 0;

  const filteredNodesBySource = React.useMemo(() => {
    const map = new Map<string, ProxyNode[]>();
    for (const source of sources) {
      const list = nodesBySource.get(source.id) ?? [];
      map.set(
        source.id,
        searching ? list.filter((node) => matchesQuery(node, keywords, sourceNames.get(source.id))) : list
      );
    }
    return map;
  }, [sources, nodesBySource, searching, keywords, sourceNames]);

  const filteredCustomNodes = React.useMemo(
    () => (searching ? customNodes.filter((node) => matchesQuery(node, keywords, "自定义节点")) : customNodes),
    [customNodes, searching, keywords]
  );
  const filteredUnassignedNodes = React.useMemo(
    () => (searching ? unassignedNodes.filter((node) => matchesQuery(node, keywords, "订阅节点")) : unassignedNodes),
    [unassignedNodes, searching, keywords]
  );

  const totalFilteredCount = React.useMemo(() => {
    let total = filteredCustomNodes.length + filteredUnassignedNodes.length;
    for (const list of filteredNodesBySource.values()) total += list.length;
    return total;
  }, [filteredCustomNodes.length, filteredUnassignedNodes.length, filteredNodesBySource]);

  const referencedGroups = editing ? groups.filter((group) => group.proxyId === editing.node.id) : [];

  const toggleSourceExpand = (sourceId: string) => {
    setExpanded((previous) => ({ ...previous, [sourceId]: !previous[sourceId] }));
  };

  const handleSaveNode = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      await runOperation("proxies.removeCustom", { id: editing.node.id });
      notify.success("节点已删除");
      setEditing(null);
    } catch (error) {
      notify.error("操作失败", error);
    } finally {
      setSaving(false);
    }
  };

  const handleTestScope = async (
    targetKey: string,
    params: { scope?: "all" | "custom" | "source" | "unassigned"; sourceId?: string },
    label: string
  ) => {
    if (testingTarget !== null) return;
    setTestingTarget(targetKey);
    try {
      await runOperation("proxies.testAll", params);
      notify.success("测速完成", `${label}的启用节点连通性测试已完成`);
    } catch (error) {
      notify.error("测速失败", error);
    } finally {
      setTestingTarget(null);
    }
  };

  const handleToggleNode = async (id: string, enabled: boolean) => {
    try {
      const cid = await newCommandId();
      await agentCall("proxies.setNodeEnabled", { id, enabled }, cid);
    } catch (error) {
      notify.error("切换状态失败", error);
    }
  };

  const handleTestNode = async (id: string) => {
    try {
      await runOperation("proxies.testNode", { id });
    } catch {
      // 节点测不通是测速的正常结果，结果会通过 proxyNode.tested 回填到当前行。
    }
  };

  const formatLatency = (ms: number | null, ok: boolean | null) => {
    if (ok === null) return <span className="text-muted">未测速</span>;
    if (ok === false) return <span className="text-danger">失败</span>;
    if (ms === null) return <span className="text-muted">—</span>;

    let colorClass = "text-danger";
    if (ms < 200) colorClass = "text-ok";
    else if (ms < 500) colorClass = "text-warn";
    else colorClass = "text-danger";

    return <span className={cn("tabular", colorClass)}>{ms} ms</span>;
  };

  const renderNodeTable = (nodes: ProxyNode[], { custom, label, emptyText }: { custom: boolean; label: string; emptyText: string }) => (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full text-sm">
        <thead className="bg-sunken/70 border-b border-subtle">
          <tr>
            <th className="text-left font-normal text-muted px-4 py-2 w-12">状态</th>
            <th className="text-left font-normal text-muted px-4 py-2">节点名称</th>
            <th className="text-left font-normal text-muted px-4 py-2 w-48">服务器</th>
            <th className="text-left font-normal text-muted px-4 py-2 w-24">协议</th>
            <th className="text-left font-normal text-muted px-4 py-2 w-24">本地端口</th>
            <th className="text-left font-normal text-muted px-4 py-2 w-24">延迟</th>
            <th className="text-right font-normal text-muted px-4 py-2">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-subtle bg-panel">
          {nodes.length === 0 ? (
            <tr>
              <td colSpan={7} className="text-center text-muted py-6">{emptyText}</td>
            </tr>
          ) : (
            nodes.map((node) => (
              <tr key={node.id} className={cn(!node.enabled && "opacity-60")}>
                <td className="px-4 py-2">
                  <Switch
                    checked={node.enabled}
                    disabled={node.missing}
                    onCheckedChange={(c) => handleToggleNode(node.id, c)}
                    aria-label="启用/停用节点"
                  />
                </td>
                <td className="px-4 py-2 max-w-[260px]" title={node.customNamed && node.originalName ? `${node.name}（原名：${node.originalName}）` : node.name}>
                  <div className="truncate font-medium text-primary">
                    {node.name}
                    {node.missing && <span className="ml-2 text-xs font-normal text-warn">失效</span>}
                  </div>
                  {node.customNamed && node.originalName && (
                    <div className="truncate text-xs text-muted">原名：{node.originalName}</div>
                  )}
                </td>
                <td className="px-4 py-2 truncate font-mono text-xs text-secondary" title={node.server ? `${node.server}:${node.port}` : ""}>
                  {node.server ? `${node.server}:${node.port}` : "—"}
                </td>
                <td className="px-4 py-2 text-secondary">
                  {node.type || "—"}
                </td>
                <td className="px-4 py-2 text-secondary tabular">
                  {node.localPort || "—"}
                </td>
                <td
                  className="px-4 py-2"
                  title={node.latencyTestedAt ? `测于: ${formatDateTime(node.latencyTestedAt, { seconds: true })}\n${node.latencyMessage || ""}` : ""}
                >
                  {formatLatency(node.latencyMs, node.latencyOk)}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={node.missing || !node.enabled}
                    onClick={() => handleTestNode(node.id)}
                    aria-label="测速"
                  >
                    <Play className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenaming(node)}>
                    重命名
                  </Button>
                  {custom && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setNodeEditor({ id: node.id, kind: node.customKind === "yaml" ? "yaml" : "simple" })}
                      >
                        编辑
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ node, action: "remove" })}>
                        删除
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  const mihomoState = proxies.status.running ? "ok" : "unknown";
  const mihomoLabel = proxies.status.running ? "Mihomo 运行中" : "Mihomo 未运行";
  const testableCustomCount = customNodes.filter((node) => node.enabled && !node.missing).length;
  const testableUnassignedCount = unassignedNodes.filter((node) => node.enabled && !node.missing).length;
  const isCustomOpen = searching ? filteredCustomNodes.length > 0 : customExpanded;
  const isUnassignedOpen = searching ? filteredUnassignedNodes.length > 0 : unassignedExpanded;
  const anySourceCollapsed = sources.some((source) => !expanded[source.id]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-primary">代理节点与订阅</h2>
          <Badge variant="outline" className="font-normal border-subtle bg-sunken flex gap-1.5 items-center">
            <StatusDot status={mihomoState} label={mihomoLabel} />
            {proxies.status.running && (
              <span className="text-muted ml-2 border-l border-subtle pl-2">
                基础端口: {proxies.status.basePort}
                {proxies.status.basePortShifted && <span className="text-warn ml-1">(已偏移)</span>}
              </span>
            )}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              aria-label="搜索代理节点"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索节点名、协议或地址…"
              className="h-8 pl-8 pr-7 text-xs"
            />
            {search && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-primary"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {sources.length > 1 && !searching && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const nextState = anySourceCollapsed;
                setExpanded(Object.fromEntries(sources.map((source) => [source.id, nextState])));
              }}
            >
              {anySourceCollapsed ? "全部展开" : "全部收起"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleTestScope("all", {}, "所有")}
            disabled={testingTarget !== null || proxies.nodes.length === 0}
          >
            <Activity className={cn("mr-1.5 size-4", testingTarget === "all" && "animate-pulse")} />
            {testingTarget === "all" ? "测速中…" : "全部测速"}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-5">
          {searching && totalFilteredCount === 0 && (
            <p role="status" className="rounded-panel border border-subtle bg-sunken/40 px-3 py-2 text-xs text-muted">
              没有匹配「{search.trim()}」的代理节点。
            </p>
          )}

          <SubscriptionsSection
            sources={sources}
            nodesBySource={nodesBySource}
            filteredNodesBySource={filteredNodesBySource}
            searching={searching}
            expanded={expanded}
            onToggleExpand={toggleSourceExpand}
            testingTarget={testingTarget}
            onTestSource={(sourceId, sourceName) =>
              void handleTestScope(`source:${sourceId}`, { scope: "source", sourceId }, `「${sourceName}」`)
            }
            renderSourceNodes={(source, nodes) =>
              renderNodeTable(nodes, {
                custom: false,
                label: `${source.name} 节点`,
                emptyText: searching ? "当前订阅下没有匹配节点" : "该订阅暂无节点",
              })
            }
          />

          {unassignedNodes.length > 0 && (
            <section className="rounded-panel border border-line bg-panel overflow-hidden" aria-label="订阅节点">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-sunken/40 px-3 py-2.5">
                <button
                  type="button"
                  aria-expanded={isUnassignedOpen}
                  aria-controls="unassigned-subscription-nodes"
                  onClick={() => setUnassignedExpanded(!unassignedExpanded)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="text-muted shrink-0" aria-hidden="true">
                    {isUnassignedOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </span>
                  <span className="text-sm font-semibold text-primary">订阅节点</span>
                  <Badge variant="outline" className="text-xs font-normal tabular">
                    {searching ? `匹配 ${filteredUnassignedNodes.length} / ${unassignedNodes.length}` : `${unassignedNodes.length} 个节点`}
                  </Badge>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={testingTarget !== null || testableUnassignedCount === 0}
                  onClick={() => void handleTestScope("unassigned", { scope: "unassigned" }, "未分类订阅")}
                >
                  <Activity className={cn("mr-1 size-3.5", testingTarget === "unassigned" && "animate-pulse")} />
                  {testingTarget === "unassigned" ? "测速中…" : "测速本组"}
                </Button>
              </div>
              {isUnassignedOpen && (
                <div id="unassigned-subscription-nodes" className="border-t border-subtle">
                  {renderNodeTable(filteredUnassignedNodes, {
                    custom: false,
                    label: "订阅节点",
                    emptyText: searching ? "没有匹配的订阅节点" : "暂无订阅节点",
                  })}
                </div>
              )}
            </section>
          )}

          <section className="rounded-panel border border-line bg-panel overflow-hidden" aria-label="自定义节点分组">
            <div className="flex flex-wrap items-center justify-between gap-2 bg-sunken/40 px-3 py-2.5">
              <button
                type="button"
                aria-expanded={isCustomOpen}
                aria-controls="custom-proxy-nodes"
                onClick={() => setCustomExpanded(!customExpanded)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="text-muted shrink-0" aria-hidden="true">
                  {isCustomOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </span>
                <h3 className="text-sm font-semibold text-primary">自定义节点</h3>
                <Badge variant="outline" className="text-xs font-normal tabular">
                  {searching ? `匹配 ${filteredCustomNodes.length} / ${customNodes.length}` : `${customNodes.length} 个节点`}
                </Badge>
              </button>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={testingTarget !== null || testableCustomCount === 0}
                  onClick={() => void handleTestScope("custom", { scope: "custom" }, "自定义节点")}
                >
                  <Activity className={cn("mr-1 size-3.5", testingTarget === "custom" && "animate-pulse")} />
                  {testingTarget === "custom" ? "测速中…" : "测速本组"}
                </Button>
                <Button size="sm" onClick={() => setNodeEditor({})}>新增代理</Button>
              </div>
            </div>
            {isCustomOpen && (
              <div id="custom-proxy-nodes" className="border-t border-subtle">
                {renderNodeTable(filteredCustomNodes, {
                  custom: true,
                  label: "自定义节点",
                  emptyText: searching ? "没有匹配的自定义节点" : "暂无自定义节点（可添加 HTTP/SOCKS5 或自建 Clash YAML / 分享链接）",
                })}
              </div>
            )}
          </section>
        </CardContent>
      </Card>

      {nodeEditor && (
        <CustomNodeDialog
          nodeId={nodeEditor.id}
          kind={nodeEditor.kind}
          onClose={() => setNodeEditor(null)}
        />
      )}

      <NodeRenameDialog node={renaming} onClose={() => setRenaming(null)} />

      <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除自定义节点</DialogTitle>
            <DialogDescription>
              {referencedGroups.length
                ? "该节点正被分组使用，请先修改这些分组的代理出口：" + referencedGroups.map((g) => g.name).join("、")
                : "确认删除节点“" + (editing?.node.name ?? "") + "”？"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>取消</Button>
            <Button onClick={handleSaveNode} disabled={saving || referencedGroups.length > 0}>
              {saving ? "处理中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
