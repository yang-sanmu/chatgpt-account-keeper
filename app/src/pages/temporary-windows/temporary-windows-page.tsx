import { useEffect, useState } from "react";
import { Eraser, ExternalLink, Globe, Loader2, Pencil, Plus, RefreshCw, Search, Square, Trash2 } from "lucide-react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { agentCall, newCommandId } from "@/ipc/bridge";
import type { TemporaryWindowResult, TemporaryWindowSaveParams } from "@/ipc/generated";
import { notify } from "@/lib/notify";
import { useKeeperStore } from "@/store/keeperStore";

type WindowAction = "open" | "close" | "detectRegion" | "clearData" | "remove";
const ACTION_LABELS: Record<WindowAction, string> = { open: "打开窗口", close: "关闭窗口", detectRegion: "探测时区", clearData: "清理浏览数据", remove: "删除窗口" };
const STATE_LABELS = { closed: "已关闭", busy: "处理中", open: "已打开", close_failed: "关闭失败" };

export function TemporaryWindowsPage() {
  const windows = useKeeperStore(state => state.temporaryWindows);
  const proxies = useKeeperStore(state => state.proxies);
  const connection = useKeeperStore(state => state.connection);
  const draining = useKeeperStore(state => state.draining);
  const operations = useKeeperStore(state => state.operations);
  const runOperation = useKeeperStore(state => state.runOperation);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<TemporaryWindowSaveParams | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{ window: TemporaryWindowResult; action: "remove" | "clearData" } | null>(null);
  const disabled = !connection.connected || draining;
  const usableNodes = proxies.nodes.filter(node => node.enabled && !node.missing);
  const busy = (window: TemporaryWindowResult) => pending.has(window.id) || window.state === "busy" || operations.some(op =>
    op.resourceId === window.id && ["queued", "running"].includes(op.state));

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await agentCall("temporaryWindows.list", {});
      useKeeperStore.setState({ temporaryWindows: result }); setLoadError(false);
    } catch (error) { setLoadError(true); notify.error("读取临时窗口失败", error); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (connection.connected) void refresh(); }, [connection.connected]);

  const perform = async (action: WindowAction, window: TemporaryWindowResult) => {
    setPending(current => new Set(current).add(window.id));
    try {
      await runOperation(`temporaryWindows.${action}`, { id: window.id });
      notify.success(`${ACTION_LABELS[action]}成功`);
      setConfirmation(current => current?.window.id === window.id && current.action === action ? null : current);
    } catch (error) { notify.error(`${ACTION_LABELS[action]}失败`, error); }
    finally { setPending(current => { const next = new Set(current); next.delete(window.id); return next; }); }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    try {
      const saved = await agentCall("temporaryWindows.save", draft, await newCommandId());
      useKeeperStore.setState(state => ({ temporaryWindows: state.temporaryWindows.some(item => item.id === saved.id)
        ? state.temporaryWindows.map(item => item.id === saved.id ? saved : item) : [...state.temporaryWindows, saved] }));
      setDraft(null); notify.success("临时窗口已保存");
      if (!saved.timezone) void perform("detectRegion", saved);
    } catch (error) { notify.error("保存临时窗口失败", error); }
    finally { setSaving(false); }
  };

  const filtered = windows.filter(window => [window.name, window.note, window.homepage,
    proxies.nodes.find(node => node.id === window.proxyId)?.name ?? ""].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return <Page>
    <PageHeader title="临时窗口" description="独立选择出口节点，按实际出口 IP 自动设置时区。关闭后保留浏览数据。" actions={<>
      <Button variant="outline" onClick={() => void refresh()} disabled={disabled || loading}><RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />刷新</Button>
      <Button disabled={disabled} onClick={() => setDraft({ name: "", note: "", homepage: "https://chatgpt.com/", proxyId: "" })}><Plus className="size-4" />新增窗口</Button>
    </>} />
    <div className="mb-4 flex items-center gap-3"><Search className="size-4 text-muted" /><Input aria-label="搜索临时窗口" placeholder="搜索名称、备注、主页或节点" value={query} onChange={event => setQuery(event.target.value)} className="max-w-md" /><span className="text-xs text-muted">{windows.length} 个窗口</span></div>
    <PageBody>
      {loadError && <div role="alert" className="mb-4 text-sm text-danger">临时窗口读取失败，请点击刷新重试。</div>}
      {!loading && filtered.length === 0 && <div className="rounded-panel border border-dashed border-subtle p-12 text-center text-secondary">{query ? "没有匹配的临时窗口" : "还没有临时窗口，点击“新增窗口”开始。"}</div>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {filtered.map(window => {
          const node = proxies.nodes.find(node => node.id === window.proxyId);
          const unavailable = !node || node.missing || !node.enabled;
          const isBusy = busy(window);
          const isClosed = window.state === "closed";
          return <article key={window.id} aria-label={`临时窗口 ${window.name}`} className="flex flex-col gap-4 rounded-panel border border-subtle bg-panel p-4">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold text-primary" title={window.name}>{window.name}</h2><p className="mt-1 whitespace-pre-wrap break-words text-xs text-secondary">{window.note || "未填写备注"}</p></div><Badge variant={window.state === "close_failed" ? "danger" : window.state === "open" ? "ok" : "neutral"}>{isBusy ? "处理中" : STATE_LABELS[window.state]}</Badge></div>
            <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted">默认主页</dt><dd className="truncate text-secondary" title={window.homepage}>{window.homepage}</dd>
              <dt className="text-muted">出口节点</dt><dd className={unavailable ? "text-danger" : "text-secondary"}>{node?.name || "节点已丢失"}{unavailable ? "（不可用）" : ""}</dd>
              <dt className="text-muted">时区</dt><dd className="break-words text-secondary">{window.timezone || "待探测"}</dd>
              <dt className="text-muted">出口 IP</dt><dd className="text-secondary">{window.exitIp || "—"}</dd>
            </dl>
            <p className="text-xs text-muted">{window.detectedAt ? `上次探测：${new Date(window.detectedAt).toLocaleString()}` : "保存及打开时自动探测，也可手动重试。"}</p>
            <div className="mt-auto flex flex-wrap gap-2 border-t border-subtle pt-3">
              {isClosed ? <Button size="sm" disabled={disabled || isBusy || unavailable} onClick={() => void perform("open", window)}><ExternalLink className="size-3.5" />打开</Button>
                : <Button size="sm" variant="outline" disabled={!connection.connected || isBusy} onClick={() => void perform("close", window)}><Square className="size-3.5" />{window.state === "close_failed" ? "重试关闭" : "关闭"}</Button>}
              <Button size="sm" variant="ghost" disabled={disabled || isBusy || !isClosed} onClick={() => setDraft({ id: window.id, name: window.name, note: window.note, homepage: window.homepage, proxyId: window.proxyId })}><Pencil className="size-3.5" />编辑</Button>
              <Button size="sm" variant="ghost" disabled={disabled || isBusy || !isClosed || unavailable} onClick={() => void perform("detectRegion", window)}><Globe className="size-3.5" />探测时区</Button>
              <Button size="sm" variant="ghost" disabled={disabled || isBusy || !isClosed} onClick={() => setConfirmation({ window, action: "clearData" })}><Eraser className="size-3.5" />清理浏览数据</Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={disabled || isBusy || !isClosed} onClick={() => setConfirmation({ window, action: "remove" })}><Trash2 className="size-3.5" />删除</Button>
            </div>
            {!isClosed && <p className="text-xs text-muted">关闭窗口后可编辑、清理浏览数据或删除。</p>}
          </article>;
        })}
      </div>
    </PageBody>
    <Dialog open={draft !== null} onOpenChange={open => { if (!open && !saving) setDraft(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{draft?.id ? "编辑临时窗口" : "新增临时窗口"}</DialogTitle><DialogDescription>窗口单独保存登录态，出口节点直接从节点列表选择。</DialogDescription></DialogHeader>
        {draft && <form id="temporary-window-form" onSubmit={event => void save(event)} className="space-y-4">
          <fieldset disabled={saving} className="space-y-4">
            <div className="space-y-2"><Label htmlFor="temporary-name">名称</Label><Input id="temporary-name" required maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：日本临时窗口" /></div>
            <div className="space-y-2"><Label htmlFor="temporary-note">备注</Label><Textarea id="temporary-note" maxLength={2000} value={draft.note || ""} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="用途或说明（可选）" /></div>
            <div className="space-y-2"><Label htmlFor="temporary-homepage">默认主页</Label><Input id="temporary-homepage" type="url" maxLength={4096} value={draft.homepage || ""} onChange={event => setDraft({ ...draft, homepage: event.target.value })} placeholder="https://chatgpt.com/" /></div>
            <div className="space-y-2"><Label htmlFor="temporary-proxy">出口节点</Label><SearchableSelect id="temporary-proxy" label="选择出口节点" value={draft.proxyId} onValueChange={proxyId => setDraft({ ...draft, proxyId })} options={usableNodes.map(node => ({ value: node.id, label: `${node.name}${node.id.startsWith("custom_") ? " · 自定义" : " · 订阅"}` }))} />
              {usableNodes.length === 0 && <p className="text-xs text-warn">暂无可用节点，请先在“分组与代理”页面导入并启用节点。</p>}
              {draft.proxyId && !usableNodes.some(node => node.id === draft.proxyId) && <p className="text-xs text-danger">原节点不可用，请重新选择。</p>}
            </div>
            <p className="text-xs text-muted">时区由节点实际出口 IP 自动推测，每次打开前重新探测。前置网络连接沿用“网络配置”。</p>
          </fieldset>
        </form>}
        <DialogFooter><Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>取消</Button><Button type="submit" form="temporary-window-form" disabled={disabled || saving || !draft?.name.trim() || !usableNodes.some(node => node.id === draft?.proxyId)}>{saving && <Loader2 className="size-4 animate-spin" />}保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && confirmation && !pending.has(confirmation.window.id)) setConfirmation(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation?.action === "remove" ? "删除临时窗口" : "清理浏览数据"}</AlertDialogTitle><AlertDialogDescription>
        将重置“{confirmation?.window.name}”的全部浏览器数据，包括 Cookie、登录态、缓存、历史记录、书签及扩展设置，此操作无法撤销。
        {confirmation?.action === "remove" ? "窗口配置也会删除。" : "名称、备注、默认主页和出口节点配置将保留。"}
      </AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={!!confirmation && pending.has(confirmation.window.id)}>取消</AlertDialogCancel><Button variant="danger" disabled={disabled || !confirmation || pending.has(confirmation.window.id)} onClick={() => { if (confirmation) void perform(confirmation.action, confirmation.window); }}>{confirmation && pending.has(confirmation.window.id) && <Loader2 className="size-4 animate-spin" />}确认{confirmation?.action === "remove" ? "删除" : "清理"}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </Page>;
}
