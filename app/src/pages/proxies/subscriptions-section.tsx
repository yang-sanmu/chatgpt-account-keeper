import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { Textarea } from "@/components/ui/textarea";
import type { ProxyState } from "@/ipc/types";
import { notify } from "@/lib/notify";
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

export function SubscriptionsSection({ sources }: { sources: Source[] }) {
  const run = useKeeperStore((state) => state.runOperation);
  const [links, setLinks] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<Outcome[]>([]);
  const [editing, setEditing] = React.useState<Source | null>(null);
  const [removing, setRemoving] = React.useState<Source | null>(null);
  const [name, setName] = React.useState("");
  const [replacement, setReplacement] = React.useState("");
  const urls = links.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setReport([]);
    try { await action(); }
    catch (error) { notify.error("订阅操作失败", error); }
    finally { setBusy(false); }
  }

  const add = () => perform(async () => {
    const [first, ...remaining] = urls;
    if (!first) return;
    const result = outcomes((await run("proxies.addSubscriptions", { urls: [first, ...remaining] })).result);
    setReport(result);
    setLinks(result.filter((item) => item.error && !item.duplicate).map((item) => urls[item.index]).join("\n"));
  });
  const refresh = (id?: string) => perform(async () => {
    setReport(outcomes((await run("proxies.refreshSubscriptions", id ? { ids: [id] } : {})).result));
  });
  const save = () => perform(async () => {
    if (!editing) return;
    const result = outcomes((await run("proxies.updateSubscription", {
      id: editing.id, name: name.trim(), ...(replacement.trim() ? { url: replacement.trim() } : {}),
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
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">订阅源</h3>
        <Button variant="outline" disabled={busy || !sources.some((source) => source.configured)} onClick={() => refresh()}>
          刷新全部订阅
        </Button>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="subscription-links">订阅链接（每行一条）</Label>
          <Textarea id="subscription-links" rows={2} value={links} disabled={busy} onChange={(event) => setLinks(event.target.value)}
            spellCheck={false} autoComplete="off" placeholder="https://…" />
        </div>
        <Button disabled={busy || !urls.length || urls.length > 32} onClick={add}>导入订阅</Button>
      </div>
      {urls.length > 32 && <p className="text-xs text-warn">每次最多导入 32 条链接。</p>}
      {sources.length ? (
        <ul className="divide-y divide-subtle rounded-panel border border-line">
          {sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium">{source.name}</p>
                <p className="text-xs text-muted">
                  {source.host ?? "待填写链接"} · 可用 {source.count} · 失效 {source.missingCount} ·
                  {" 上次成功 "}<RelativeTime value={source.updatedAt} fallback="—" />
                </p>
                {source.error && <p className="text-xs text-warn">{source.error}，已保留原有节点。</p>}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={busy || !source.configured} onClick={() => refresh(source.id)}>刷新</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                  setName(source.name);
                  setReplacement("");
                  setEditing(source);
                }}>编辑</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(source)}>删除</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">暂无订阅源</p>}
      {report.length > 0 && (
        <ul aria-label="订阅操作结果" aria-live="polite" className="space-y-1 text-xs text-secondary">
          {report.map((item) => (
            <li key={item.index} className={item.error ? "text-warn" : undefined}>
              {item.name} · {item.error ?? (item.added === undefined
                ? "已保存"
                : `新增 ${item.added} · 更新 ${item.updated} · 移除 ${item.removed} · 失效 ${item.missing?.length ?? 0} · 跳过 ${item.skipped}`)}
              {item.missing?.map((node) => <div key={node.id}>
                {node.name} 已失效{node.bindings.length ? `，请检查 ${node.bindings.join("、")}` : ""}
              </div>)}
            </li>
          ))}
        </ul>
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
            <Input id="subscription-replacement" type="password" autoComplete="off" value={replacement}
              onChange={(event) => setReplacement(event.target.value)} />
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
