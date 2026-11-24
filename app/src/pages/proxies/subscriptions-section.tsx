import * as React from "react";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import type { ProxyNode, ProxyState } from "@/ipc/types";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useKeeperStore } from "@/store/keeperStore";

type Source = NonNullable<ProxyState["subscriptions"]>[number];
type Outcome = {
  index: number;
  name: string;
  host?: string | null;
  error?: string;
  duplicate?: boolean;
  added?: number;
  updated?: number;
  removed?: number;
  skipped?: number;
  missing?: { id: string; name: string; bindings: string[] }[];
};

function outcomes(result: unknown): Outcome[] {
  return result && typeof result === "object" && "results" in result && Array.isArray(result.results)
    ? result.results
    : [];
}

function parseSubscriptionLine(line: string): { url: string; name: string | null } {
  const match = line.match(/^([^|]+?)\s*\|\s*(https?:\/\/\S+)$/i);
  if (match) {
    const alias = match[1]?.trim() || null;
    const url = match[2]?.trim() || line;
    return { url, name: alias };
  }
  return { url: line, name: null };
}

export interface SubscriptionsSectionProps {
  sources: Source[];
  nodesBySource: Map<string, ProxyNode[]>;
  filteredNodesBySource: Map<string, ProxyNode[]>;
  searching: boolean;
  expanded: Record<string, boolean>;
  onToggleExpand: (sourceId: string) => void;
  testingTarget: string | null;
  onTestSource: (sourceId: string, sourceName: string) => void;
  renderSourceNodes: (source: Source, nodes: ProxyNode[]) => React.ReactNode;
}

export function SubscriptionsSection({
  sources,
  nodesBySource,
  filteredNodesBySource,
  searching,
  expanded,
  onToggleExpand,
  testingTarget,
  onTestSource,
  renderSourceNodes,
}: SubscriptionsSectionProps) {
  const run = useKeeperStore((state) => state.runOperation);
  const [links, setLinks] = React.useState("");
  const [importAlias, setImportAlias] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<Outcome[]>([]);
  const [editing, setEditing] = React.useState<Source | null>(null);
  const [removing, setRemoving] = React.useState<Source | null>(null);
  const [name, setName] = React.useState("");
  const [replacement, setReplacement] = React.useState("");

  const rawLines = links.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsedEntries = rawLines.map(parseSubscriptionLine);
  const showSingleAliasInput = parsedEntries.length <= 1 && !parsedEntries[0]?.name;

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setReport([]);
    try { await action(); }
    catch (error) { notify.error("订阅操作失败", error); }
    finally { setBusy(false); }
  }

  const add = () => perform(async () => {
    const [first, ...remaining] = parsedEntries;
    if (!first) return;
    const entries = [first, ...remaining];
    const urls = entries.map((item) => item.url) as [string, ...string[]];
    const names = entries.map((item, index) => (
      index === 0 && showSingleAliasInput ? (importAlias.trim() || null) : item.name
    ));
    const hasAnyName = names.some((item) => item !== null);
    const payload = hasAnyName
      ? { urls, names: names as [string | null, ...(string | null)[]] }
      : { urls };
    const result = outcomes((await run("proxies.addSubscriptions", payload)).result);
    setReport(result);
    const failedLines = result
      .filter((item) => item.error && !item.duplicate)
      .map((item) => rawLines[item.index])
      .filter(Boolean);
    setLinks(failedLines.join("\n"));
    if (failedLines.length === 0) setImportAlias("");
  });

  const refresh = (id?: string) => perform(async () => {
    setReport(outcomes((await run("proxies.refreshSubscriptions", id ? { ids: [id] } : {})).result));
  });

  const save = () => perform(async () => {
    if (!editing) return;
    const result = outcomes((await run("proxies.updateSubscription", {
      id: editing.id,
      name: name.trim(),
      ...(replacement.trim() ? { url: replacement.trim() } : {}),
    })).result);
    setReport(result);
    if (result[0]?.error) notify.error("保存订阅失败", result[0].error);
    else {
      setEditing(null);
      setReplacement("");
    }
  });

  const remove = () => perform(async () => {
    if (!removing) return;
    const result = outcomes((await run("proxies.removeSubscription", { id: removing.id })).result);
    if (result[0]?.error) notify.error("删除订阅失败", result[0].error);
    else {
      setRemoving(null);
      notify.success("订阅已删除");
    }
  });

  return (
    <section className="space-y-3" aria-label="订阅源">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">订阅源</h3>
        <Button variant="outline" size="sm" disabled={busy || !sources.some((source) => source.configured)} onClick={() => refresh()}>
          刷新全部订阅
        </Button>
      </div>

      <div className="space-y-2 rounded-panel border border-subtle bg-sunken/40 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1 space-y-1">
            <Label htmlFor="subscription-links">订阅链接（每行一条）</Label>
            <Textarea
              id="subscription-links"
              rows={2}
              value={links}
              disabled={busy}
              onChange={(event) => setLinks(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={"https://…\n批量命名也可写作：订阅别名 | https://…"}
            />
          </div>
          {showSingleAliasInput && (
            <div className="w-full sm:w-52 space-y-1">
              <Label htmlFor="subscription-import-name">订阅别名（选填）</Label>
              <Input
                id="subscription-import-name"
                maxLength={200}
                value={importAlias}
                disabled={busy}
                onChange={(event) => setImportAlias(event.target.value)}
                placeholder="留空自动使用域名"
              />
            </div>
          )}
          <Button disabled={busy || !parsedEntries.length || parsedEntries.length > 32} onClick={add}>
            导入订阅
          </Button>
        </div>
        {parsedEntries.length > 32 && <p className="text-xs text-warn">每次最多导入 32 条链接。</p>}
      </div>

      {report.length > 0 && (
        <ul aria-label="订阅操作结果" aria-live="polite" className="space-y-1 rounded-panel border border-subtle bg-sunken/30 px-3 py-2 text-xs text-secondary">
          {report.map((item) => (
            <li key={item.index} className={item.error ? "text-warn" : undefined}>
              {item.name} · {item.error ?? (item.added === undefined
                ? "已保存"
                : `新增 ${item.added} · 更新 ${item.updated} · 移除 ${item.removed} · 失效 ${item.missing?.length ?? 0} · 跳过 ${item.skipped}`)}
              {item.missing?.map((node) => (
                <div key={node.id}>
                  {node.name} 已失效{node.bindings.length ? `，请检查 ${node.bindings.join("、")}` : ""}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}

      {sources.length ? (
        <div className="space-y-3">
          {sources.map((source) => {
            const allNodes = nodesBySource.get(source.id) ?? [];
            const visibleNodes = filteredNodesBySource.get(source.id) ?? [];
            const isOpen = searching ? visibleNodes.length > 0 : Boolean(expanded[source.id]);
            const testableCount = allNodes.filter((node) => node.enabled && !node.missing).length;
            const isTestingThis = testingTarget === `source:${source.id}`;
            const panelId = `subscription-group-${source.id}`;

            return (
              <div key={source.id} className="rounded-panel border border-line bg-panel overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-sunken/40 px-3 py-2.5">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => onToggleExpand(source.id)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="mt-0.5 text-muted shrink-0" aria-hidden="true">
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </span>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-primary">{source.name}</span>
                        <Badge variant="outline" className="text-xs font-normal tabular">
                          {searching ? `匹配 ${visibleNodes.length} / ${allNodes.length}` : `${allNodes.length} 个节点`}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted">
                        {source.host ?? "待填写链接"} · 可用 {source.count} · 失效 {source.missingCount} ·
                        {" 上次成功 "}<RelativeTime value={source.updatedAt} fallback="—" />
                      </p>
                      {source.error && <p className="text-xs text-warn">{source.error}，已保留原有节点。</p>}
                    </div>
                  </button>

                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || testingTarget !== null || testableCount === 0}
                      onClick={() => onTestSource(source.id, source.name)}
                    >
                      <Activity className={cn("mr-1 size-3.5", isTestingThis && "animate-pulse")} />
                      {isTestingThis ? "测速中…" : "测速本组"}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy || !source.configured} onClick={() => refresh(source.id)}>
                      刷新
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setName(source.name);
                        setReplacement("");
                        setEditing(source);
                      }}
                    >
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(source)}>
                      删除
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div id={panelId} className="border-t border-subtle">
                    {renderSourceNodes(source, visibleNodes)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">暂无订阅源</p>
      )}

      <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) { setEditing(null); setReplacement(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑订阅</DialogTitle>
            <DialogDescription>更换链接时，成功获取节点后才会保存新链接。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="subscription-name">别名</Label>
            <Input id="subscription-name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
            <Label htmlFor="subscription-replacement">新链接（选填）</Label>
            <Input
              id="subscription-replacement"
              type="password"
              autoComplete="off"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button disabled={busy || !name.trim()} onClick={save}>{busy ? "处理中…" : "保存订阅"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除订阅</DialogTitle>
            <DialogDescription>删除「{removing?.name}」及其节点。仍在使用的节点需要先改绑。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={busy} variant="outline" onClick={() => setRemoving(null)}>取消</Button>
            <Button disabled={busy} onClick={remove}>确认删除订阅</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
