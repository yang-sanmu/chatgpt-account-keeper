import { useEffect, useState } from "react";
import { Copy, ExternalLink, Loader2, Pencil, Plus, RefreshCw, Search, Square, X } from "lucide-react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { agentCall, newCommandId } from "@/ipc/bridge";
import type { IcloudConfig, IcloudEmail, IcloudState } from "@/ipc/generated";
import { useKeeperStore } from "@/store/keeperStore";
import { notify } from "@/lib/notify";

const USAGE = { unknown: "待确认", unused: "未使用", used: "已使用" };
const REMOTE = { active: "活跃", inactive: "已停用", missing: "云端未找到" };
const STATUS = { not_logged_in: "尚未登录", idle: "就绪", running: "正在申请", cooldown: "冷却中", needs_login: "需要登录", paused: "已暂停", uncertain: "结果待核对" };
const ACTION = { open: "打开 iCloud", close: "关闭浏览器", sync: "同步列表", create: "申请 1 个" };
const selectClass = "h-9 rounded-control border border-default bg-panel px-3 text-sm text-primary";
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const searchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
export function selectedEmailText(rows: IcloudEmail[], ids: Set<string>) {
  return [...new Set(rows.filter(row => ids.has(row.id)).map(row => row.email))].join("\n");
}

export function IcloudPage() {
  const state = useKeeperStore(s => s.icloud);
  const connection = useKeeperStore(s => s.connection);
  const draining = useKeeperStore(s => s.draining);
  const runOperation = useKeeperStore(s => s.runOperation);
  const [draft, setDraft] = useState<IcloudConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [usage, setUsage] = useState("all");
  const [remote, setRemote] = useState("all");
  const [selected, setSelected] = useState(new Set<string>());
  const [page, setPage] = useState(0);
  const [edit, setEdit] = useState<{ id: string; email: string; note: string } | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const disabled = !connection.connected || draining;
  const busy = working || state?.busy === true;
  const mode = draft?.mode ?? "single";
  const setSnapshot = (value: IcloudState) => useKeeperStore.setState({ icloud: value });
  const refresh = async () => {
    try { setSnapshot(await agentCall("icloud.getState", {})); setLoadError(false); }
    catch (error) { setLoadError(true); notify.error("读取 iCloud 状态失败", error); }
  };
  useEffect(() => { if (connection.connected) void refresh(); }, [connection.connected]);
  useEffect(() => { if (state && !dirty) setDraft(state.config); }, [state?.config, dirty]);
  useEffect(() => { setPage(0); setSelected(new Set()); }, [query, usage, remote]);
  const change = (patch: Partial<IcloudConfig>) => { if (draft) { setDraft({ ...draft, ...patch }); setDirty(true); } };
  const perform = async (action: keyof typeof ACTION) => {
    setWorking(true);
    try { await runOperation(`icloud.${action}`, {}); notify.success(`${ACTION[action]}完成`); }
    catch (error) { notify.error(`${ACTION[action]}失败`, error); }
    finally { await refresh(); setWorking(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return;
    setWorking(true);
    try { setSnapshot(await agentCall("icloud.saveConfig", draft, await newCommandId())); setDirty(false); notify.success("申请设置已保存"); }
    catch (error) { notify.error("保存设置失败", error); }
    finally { setWorking(false); }
  };
  const stop = async () => {
    try { const value = await agentCall("icloud.stop", {}, await newCommandId()); setSnapshot(value); setDraft(value.config); setDirty(false); }
    catch (error) { notify.error("停止自动申请失败", error); }
  };
  const update = async (ids: string[], patch: { usage?: IcloudEmail["usage"]; localNote?: string }) => {
    if (!ids.length) return;
    setSnapshot(await agentCall("icloud.updateLocal", { ids: ids as [string, ...string[]], ...patch }, await newCommandId()));
  };
  const copy = async (ids: Set<string>, markUsed = false) => {
    const text = selectedEmailText(state?.emails ?? [], ids); if (!text) return;
    setWorking(true);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text); copied = true;
      if (markUsed) await update([...ids], { usage: "used" });
      notify.success(markUsed ? "已复制并标记为已使用" : "已复制，每行一个邮箱");
    } catch (error) { notify.error(copied ? "邮箱已复制，但标记失败，请重试标记" : "复制失败，使用状态未改变", error); }
    finally { setWorking(false); }
  };
  const mark = async (value: IcloudEmail["usage"]) => {
    setWorking(true);
    try { await update([...selected], { usage: value }); notify.success(`已标记为${USAGE[value]}`); }
    catch (error) { notify.error("更新使用状态失败", error); }
    finally { setWorking(false); }
  };
  const rows = state?.emails ?? [];
  const keywords = searchText(query).trim().split(/\s+/).filter(Boolean);
  const hasFilters = query.length > 0 || usage !== "all" || remote !== "all";
  const filtered = rows.filter(row => {
    if (usage !== "all" && row.usage !== usage) return false;
    if (remote !== "all" && row.remoteState !== remote) return false;
    const text = searchText([row.email, row.label, row.cloudNote, row.localNote].join(" "));
    return keywords.every(keyword => text.includes(keyword));
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * 50, currentPage * 50 + 50);
  const selectedRows = rows.filter(row => selected.has(row.id));
  const toggle = (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  return <Page>
    <PageHeader title="iCloud 隐私邮箱" description="使用独立 Chrome Profile 登录，持续申请并管理隐藏邮件地址。" actions={<>
      <Button variant="outline" disabled={disabled || busy} onClick={() => void perform("open")}><ExternalLink className="size-4" />打开 iCloud / 登录</Button>
      <Button variant="outline" disabled={!connection.connected || busy || !state?.browserOpen} onClick={() => void perform("close")}><Square className="size-4" />关闭浏览器</Button>
      <Button variant="outline" disabled={disabled || busy} onClick={() => void perform("sync")}><RefreshCw className="size-4" />同步列表</Button>
      <Button disabled={disabled || busy || !state?.bound || !!state.pendingEmail || dirty} onClick={() => void perform("create")}><Plus className="size-4" />申请 1 个</Button>
    </>} />
    <PageBody className="space-y-5">
      {loadError && <div role="alert" className="text-danger">状态读取失败，当前数据可能过期。<Button variant="ghost" onClick={() => void refresh()}>重试读取</Button></div>}
      {state && ["not_logged_in", "needs_login"].includes(state.status) && <p className="text-sm text-muted">请在专用浏览器中手动登录；如有“保持登录”或“信任此浏览器”选项，请选择后同步列表，以便关闭窗口后继续申请。</p>}
      {!state && !loadError && <p className="flex gap-2 text-muted"><Loader2 className="size-4 animate-spin" />正在读取 iCloud 配置…</p>}
      {state && <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-panel border border-subtle bg-panel p-4 text-sm">
        <strong>{busy ? "处理中" : STATUS[state.status]} · {state.config.enabled ? "持续申请已开启" : "自动申请已关闭"}</strong>
        <span>下次自动申请：{time(state.nextRunAt)}</span><span>最近同步：{time(state.lastSyncAt)}</span>
        {state.cooldownUntil && <span>冷却至：{time(state.cooldownUntil)}</span>}
        <p className="w-full text-muted" role="status">{state.lastMessage}</p>
        {state.browserOpen && state.config.enabled && !state.busy && <p className="w-full text-muted">手动浏览器打开期间，自动申请等待；关闭浏览器后继续。</p>}
      </div>}
      {draft && <Card><CardHeader><CardTitle>申请设置</CardTitle></CardHeader><CardContent>
        <form onSubmit={event => void save(event)} className="space-y-4">
          <fieldset disabled={disabled || busy || loadError} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-2"><Label htmlFor="icloud-mode">申请模式</Label><select id="icloud-mode" className={`${selectClass} w-full`} value={mode} onChange={event => change({ mode: event.target.value as IcloudConfig["mode"], batchSize: draft.batchSize ?? 5,
              ...(mode === "single" && event.target.value !== "single" && draft.intervalMinutes === 15 ? { intervalMinutes: 60 } : {}) })}>
              <option value="single">每次 1 个</option><option value="batch">每轮固定数量</option><option value="until_limit">申请到 iCloud 提示上限</option>
            </select></div>
            {mode === "batch" && <div className="space-y-2"><Label htmlFor="icloud-batch-size">每轮申请数量</Label><Input id="icloud-batch-size" type="number" min={1} max={5} required value={draft.batchSize ?? 5} onChange={event => change({ batchSize: Number(event.target.value) })} /></div>}
            <div className="space-y-2"><Label htmlFor="icloud-label">固定标签 *</Label><Input id="icloud-label" required maxLength={100} value={draft.label} onChange={event => change({ label: event.target.value })} /></div>
            <div className="space-y-2"><Label htmlFor="icloud-note">固定 iCloud 备注</Label><Input id="icloud-note" maxLength={1000} value={draft.note} onChange={event => change({ note: event.target.value })} placeholder="可选，写入新邮箱的云端备注" /></div>
            <div className="space-y-2"><Label htmlFor="icloud-interval">{mode === "single" ? "单个申请间隔（分钟）" : mode === "batch" ? "轮次间隔（分钟）" : "限额后等待（分钟）"}</Label><Input id="icloud-interval" type="number" min={1} max={1440} required value={draft.intervalMinutes} onChange={event => change({ intervalMinutes: Number(event.target.value) })} /></div>
            <div className="space-y-2"><Label htmlFor="icloud-network">网络模式</Label><select id="icloud-network" className={`${selectClass} w-full`} value={draft.networkMode} disabled={state?.browserOpen} onChange={event => change({ networkMode: event.target.value as IcloudConfig["networkMode"] })}>
              <option value="direct">直连（默认）</option><option value="inherit">跟随网络配置</option><option value="system">系统代理</option>
            </select></div>
            <div className="flex items-center gap-3"><Switch id="icloud-enabled" checked={draft.enabled} onCheckedChange={enabled => change({ enabled })} /><Label htmlFor="icloud-enabled">自动申请 · 持续申请</Label></div>
          </fieldset>
          <p className="text-xs leading-5 text-muted">{mode === "single" ? `每隔 ${draft.intervalMinutes} 分钟申请 1 个。` : mode === "batch" ? `每轮连续申请 ${draft.batchSize ?? 5} 个，完成后等待 ${draft.intervalMinutes} 分钟开始下一轮。` : `连续逐个申请，直到 iCloud 返回限额；临时限额后至少等待 ${draft.intervalMinutes} 分钟，服务端要求更久时按服务端时间等待。总量上限或无法判断的限额会暂停。`}
            {mode !== "until_limit" && "滚动一小时最多尝试 5 次，服务端限制优先。"}每个地址确认成功后才申请下一个；出错或点击停止会结束本轮。开启或保存后先等待设定间隔，可查看上方下次自动申请时间。最小化到托盘后继续，完全退出或休眠期间停止，恢复后不集中补跑。</p>
          <div className="flex gap-2"><Button type="submit" disabled={disabled || busy || loadError || !dirty || !draft.label.trim()}>保存设置</Button>
            <Button type="button" variant="outline" disabled={!connection.connected || !state?.config.enabled} onClick={() => void stop()}>停止自动申请</Button>
          </div>
        </form>
      </CardContent></Card>}
      {state?.pendingEmail && <div className="rounded-panel border border-warn p-4 text-sm text-warn">
        <p>待核对地址：{state.pendingEmail}。先同步列表确认创建结果，再继续申请。</p>
        <Button className="mt-2" variant="outline" disabled={disabled || busy} onClick={() => setAcknowledge(true)}>我已在 iCloud 核对结果</Button>
      </div>}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">邮箱列表</h2>
        <div className="flex flex-wrap items-end gap-3 rounded-panel border border-subtle bg-panel p-4">
          <div className="min-w-64 flex-1 space-y-2">
            <Label htmlFor="icloud-search">模糊搜索</Label>
            <div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
              <Input id="icloud-search" className="pl-9" aria-label="搜索邮箱" aria-describedby="icloud-search-help" placeholder="邮箱、标签、iCloud 备注或本地备注" value={query} onChange={event => setQuery(event.target.value)} />
            </div>
          </div>
          <div className="space-y-2"><Label htmlFor="icloud-usage-filter">使用状态</Label>
            <select id="icloud-usage-filter" aria-label="使用状态筛选" className={`${selectClass} block w-full`} value={usage} onChange={event => setUsage(event.target.value)}><option value="all">全部使用状态</option>{Object.entries(USAGE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          </div>
          <div className="space-y-2"><Label htmlFor="icloud-remote-filter">云端状态</Label>
            <select id="icloud-remote-filter" aria-label="云端状态筛选" className={`${selectClass} block w-full`} value={remote} onChange={event => setRemote(event.target.value)}><option value="all">全部云端状态</option>{Object.entries(REMOTE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          </div>
          <Button variant="ghost" disabled={!hasFilters} onClick={() => { setQuery(""); setUsage("all"); setRemote("all"); }}><X className="size-4" />清除筛选</Button>
          <p id="icloud-search-help" className="w-full text-xs text-muted">输入部分文字即可匹配，忽略大小写；多个关键词用空格分隔，需同时匹配。更改筛选条件会清空已选邮箱。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">共 {rows.length} 个 · 筛选 {filtered.length} 个 · 已选 {selectedRows.length} 个</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set([...selected, ...visible.map(row => row.id)]))}>选择当前页</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(filtered.map(row => row.id)))}>选择全部筛选结果</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清空选择</Button>
          <Button size="sm" variant="outline" disabled={!selectedRows.length || busy} onClick={() => void copy(selected)}><Copy className="size-3.5" />复制选中</Button>
          <Button size="sm" variant="outline" disabled={!selectedRows.length || disabled || busy} onClick={() => void copy(selected, true)}>复制并标记已使用</Button>
          {(["unused", "used", "unknown"] as const).map(value => <Button key={value} size="sm" variant="ghost" disabled={!selectedRows.length || disabled || busy} onClick={() => void mark(value)}>标记{USAGE[value]}</Button>)}
        </div>
        <div className="overflow-x-auto rounded-panel border border-subtle">
          <table className="w-full text-left text-sm"><thead className="bg-panel text-muted"><tr>{["选择", "邮箱", "iCloud 标签", "iCloud 备注", "本地备注", "使用状态", "云端状态", "创建时间", "操作"].map(label => <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{visible.map(row => <tr key={row.id} className="border-t border-subtle hover:bg-hover">
              <td className="px-3 py-3"><Checkbox aria-label={`选择 ${row.email}`} checked={selected.has(row.id)} onCheckedChange={checked => toggle(row.id, checked === true)} /></td>
              <td className="whitespace-nowrap px-3 py-3 font-mono text-xs">{row.email}</td>
              <td className="max-w-40 truncate px-3 py-3" title={row.label}>{row.label}</td>
              <td className="max-w-48 truncate px-3 py-3" title={row.cloudNote}>{row.cloudNote || "—"}</td>
              <td className="max-w-48 truncate px-3 py-3" title={row.localNote}>{row.localNote || "—"}</td>
              <td className="whitespace-nowrap px-3 py-3">{USAGE[row.usage]}</td><td className="whitespace-nowrap px-3 py-3">{REMOTE[row.remoteState]}</td>
              <td className="whitespace-nowrap px-3 py-3 text-xs text-muted">{time(row.createdAt)}</td>
              <td className="px-3 py-3"><div className="flex"><Button size="icon-sm" variant="ghost" aria-label={`复制 ${row.email}`} disabled={busy} onClick={() => void copy(new Set([row.id]))}><Copy className="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`编辑 ${row.email} 的本地备注`} disabled={disabled || busy} onClick={() => setEdit({ id: row.id, email: row.email, note: row.localNote })}><Pencil className="size-3.5" /></Button></div></td>
            </tr>)}</tbody>
          </table>
          {!visible.length && <p className="p-8 text-center text-muted">{rows.length ? "没有符合筛选条件的邮箱" : "登录后同步列表，已有邮箱将标为待确认"}</p>}
        </div>
        <div className="flex items-center justify-end gap-3 text-sm"><Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {pageCount}</span><Button variant="ghost" size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>
      </div>
      {!!state?.history.length && <details className="rounded-panel border border-subtle p-4"><summary className="cursor-pointer text-sm font-medium">最近申请与同步记录</summary><div className="mt-3 space-y-2">{state.history.map((entry, index) => <p key={`${entry.at}-${index}`} className="text-xs text-muted">{time(entry.at)} · {entry.message}</p>)}</div></details>}
    </PageBody>
    <Dialog open={edit !== null} onOpenChange={open => { if (!open && !working) setEdit(null); }}><DialogContent><DialogHeader><DialogTitle>编辑本地备注</DialogTitle><DialogDescription>{edit?.email} · 仅保存在本软件中</DialogDescription></DialogHeader>
      <Textarea aria-label="本地备注" value={edit?.note ?? ""} maxLength={2000} disabled={working} onChange={event => { if (edit) setEdit({ ...edit, note: event.target.value }); }} />
      <DialogFooter><Button disabled={working || disabled} onClick={async () => { if (!edit) return; setWorking(true); try { await update([edit.id], { localNote: edit.note }); setEdit(null); } catch (error) { notify.error("保存本地备注失败", error); } finally { setWorking(false); } }}>保存本地备注</Button></DialogFooter>
    </DialogContent></Dialog>
    <AlertDialog open={acknowledge} onOpenChange={setAcknowledge}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认已核对创建结果</AlertDialogTitle><AlertDialogDescription>请先在 iCloud 中查找待核对地址。若已创建，建议先同步列表；继续会清除本地待核对标记，允许下一次申请。自动申请仍保持关闭。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={working}>返回</AlertDialogCancel><Button disabled={working} onClick={async () => { setWorking(true); try { setSnapshot(await agentCall("icloud.acknowledge", {}, await newCommandId())); setAcknowledge(false); } catch (error) { notify.error("确认失败", error); } finally { setWorking(false); } }}>已核对，允许继续</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </Page>;
}
