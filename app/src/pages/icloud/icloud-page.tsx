import { useEffect, useState } from "react";
import { Activity, Clock, Copy, ExternalLink, Filter, Loader2, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Square, Tag, X } from "lucide-react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { StatusDot } from "@/components/ui/status-dot";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { agentCall, newCommandId } from "@/ipc/bridge";
import type { IcloudConfig, IcloudEmail, IcloudState } from "@/ipc/generated";
import { useKeeperStore } from "@/store/keeperStore";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

const USAGE = { unknown: "待确认", unused: "未使用", used: "已使用" } as const;
const REMOTE = { active: "活跃", inactive: "已停用", missing: "云端未找到" } as const;
const STATUS = { not_logged_in: "尚未登录", idle: "就绪", running: "正在申请", cooldown: "冷却中", needs_login: "需要登录", paused: "已暂停", uncertain: "结果待核对" } as const;
const NETWORK = { direct: "直连", inherit: "跟随网络配置", system: "系统代理" } as const;
const ACTION = { open: "打开 iCloud", close: "关闭浏览器", sync: "同步列表", create: "申请 1 个", runNow: "立即执行一轮" } as const;
const ACTION_RUNNING_TEXT: Record<keyof typeof ACTION, string> = {
  open: "正在打开专用 iCloud 浏览器…",
  close: "正在关闭并回收 iCloud 浏览器…",
  sync: "正在同步云端隐藏邮件地址列表…",
  create: "正在向 iCloud 申请 1 个新的隐藏邮件地址…",
  runNow: "正在立即执行本轮申请任务…",
};
const HISTORY_ACTION_LABELS: Record<string, string> = {
  open: "打开浏览器",
  sync: "同步列表",
  create: "申请邮箱",
  round: "申请轮次",
  settings: "策略设置",
  reconcile: "结果核对",
};

const controlSelectClass = "h-9 rounded-control border border-subtle bg-sunken px-3 text-xs text-primary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";
const filterSelectClass = "h-8 rounded-control border border-subtle bg-sunken px-2.5 text-xs text-primary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const searchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

export function selectedEmailText(rows: IcloudEmail[], ids: Set<string>) {
  return [...new Set(rows.filter(row => ids.has(row.id)).map(row => row.email))].join("\n");
}

function strategySummary(config: IcloudConfig) {
  const mode = config.mode ?? "single";
  if (mode === "batch") return `每轮 ${config.batchSize ?? 5} 个 · 间隔 ${config.intervalMinutes} 分钟`;
  if (mode === "until_limit") return `申请至上限 · 冷却 ${config.intervalMinutes} 分钟`;
  return `每次 1 个 · 间隔 ${config.intervalMinutes} 分钟`;
}

function statusIndicator(status: IcloudState["status"], busy: boolean): { dot: "ok" | "busy" | "needs_login" | "unknown"; badge: "ok" | "info" | "warn" | "neutral" } {
  if (busy || status === "running") return { dot: "busy", badge: "info" };
  if (status === "idle") return { dot: "ok", badge: "ok" };
  if (status === "paused") return { dot: "unknown", badge: "neutral" };
  return { dot: "needs_login", badge: "warn" };
}

function parseBatchProgress(message: string | undefined, config: IcloudConfig): { current: number; total: number; percent: number } | null {
  if (!message || (config.mode ?? "single") !== "batch") return null;
  const match = message.match(/已申请\s*(\d+)\s*\/\s*(\d+)/);
  if (match) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (total > 0) return { current, total, percent: Math.min(100, Math.round((current / total) * 100)) };
  }
  if (/开始/.test(message)) {
    const total = config.batchSize ?? 5;
    return { current: 0, total, percent: 8 };
  }
  return null;
}

export function IcloudPage() {
  const state = useKeeperStore(s => s.icloud);
  const connection = useKeeperStore(s => s.connection);
  const draining = useKeeperStore(s => s.draining);
  const runOperation = useKeeperStore(s => s.runOperation);
  const [draft, setDraft] = useState<IcloudConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [activeAction, setActiveAction] = useState<keyof typeof ACTION | null>(null);
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
  const isRunning = activeAction !== null || state?.busy === true || state?.status === "running";
  const needsLogin = !!state && (!state.bound || ["not_logged_in", "needs_login"].includes(state.status));
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
  const openConfig = () => {
    if (!state) return;
    if (!dirty || !draft) setDraft(state.config);
    setConfigOpen(true);
  };
  const closeConfig = () => {
    if (working) return;
    setConfigOpen(false);
    setDirty(false);
    if (state) setDraft(state.config);
  };
  const perform = async (action: keyof typeof ACTION) => {
    if (action === "runNow" && dirty) {
      notify.error("请先保存或取消申请设置，再立即执行一轮");
      return;
    }
    setWorking(true);
    setActiveAction(action);
    try { await runOperation(`icloud.${action}`, {}); notify.success(`${ACTION[action]}完成`); }
    catch (error) { notify.error(`${ACTION[action]}失败`, error); }
    finally { await refresh(); setWorking(false); setActiveAction(null); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return;
    setWorking(true);
    try {
      setSnapshot(await agentCall("icloud.saveConfig", draft, await newCommandId()));
      setDirty(false);
      setConfigOpen(false);
      notify.success("申请设置已保存");
    }
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
  const rows = state?.emails ?? [];
  const selectedRows = rows.filter(row => selected.has(row.id));
  const unusedCount = rows.filter(row => row.usage === "unused").length;
  const usedCount = rows.filter(row => row.usage === "used").length;
  const unknownCount = rows.filter(row => row.usage === "unknown").length;

  const copy = async (ids: Set<string>, markUsed = false) => {
    const validIds = rows.filter(row => ids.has(row.id)).map(row => row.id);
    const text = selectedEmailText(rows, ids); if (!text) return;
    setWorking(true);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text); copied = true;
      if (markUsed) await update(validIds, { usage: "used" });
      notify.success(markUsed ? "已复制并标记为已使用" : "已复制，每行一个邮箱");
    } catch (error) { notify.error(copied ? "邮箱已复制，但标记失败，请重试标记" : "复制失败，使用状态未改变", error); }
    finally { setWorking(false); }
  };
  const mark = async (value: IcloudEmail["usage"]) => {
    setWorking(true);
    try { await update(selectedRows.map(row => row.id), { usage: value }); notify.success(`已标记为${USAGE[value]}`); }
    catch (error) { notify.error("更新使用状态失败", error); }
    finally { setWorking(false); }
  };
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
  const toggle = (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  const indicator = state ? statusIndicator(state.status, isRunning) : null;
  const isRoundRunning = activeAction === "runNow" || (!activeAction && state?.status === "running");
  const batchProgress = state && isRoundRunning ? parseBatchProgress(state.lastMessage, state.config) : null;
  const runningHeadline = activeAction
    ? ACTION_RUNNING_TEXT[activeAction]
    : state?.status === "running"
    ? `正在执行自动申请（${strategySummary(state.config)}）…`
    : "正在后台处理 iCloud 任务…";

  return <Page>
    <PageHeader title="iCloud 隐私邮箱" description="使用独立 Chrome Profile 登录，持续申请并管理隐藏邮件地址。" actions={<>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void perform("open")}>
        {activeAction === "open" ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}打开 iCloud / 登录
      </Button>
      <Button size="sm" variant="outline" disabled={!connection.connected || busy || !state?.browserOpen} onClick={() => void perform("close")}>
        {activeAction === "close" ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}关闭浏览器
      </Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void perform("sync")}>
        <RefreshCw className={cn("size-3.5", activeAction === "sync" && "animate-spin")} />同步列表
      </Button>
      <Button size="sm" variant="outline" disabled={!state} onClick={openConfig}>
        <SlidersHorizontal className="size-3.5" />申请设置
      </Button>
      <Button size="sm" disabled={disabled || busy || !state?.bound || !!state.pendingEmail || dirty} onClick={() => void perform("create")}>
        {activeAction === "create" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}申请 1 个
      </Button>
    </>} />

    <PageBody className="space-y-4 pb-10">
      {loadError && <div role="alert" className="flex items-center justify-between rounded-panel border border-danger bg-danger-soft px-3.5 py-2 text-xs text-danger">
        <span>状态读取失败，当前数据可能过期。</span>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void refresh()}>重试读取</Button>
      </div>}

      {!state && !loadError && <p className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-4 animate-spin" />正在读取 iCloud 配置…</p>}

      {state && indicator && (
        <div
          className={cn(
            "relative overflow-hidden rounded-panel border bg-panel transition-colors",
            isRunning ? "border-info shadow-panel" : "border-subtle"
          )}
        >
          {isRunning && (
            <div className="h-1 w-full overflow-hidden bg-info-soft">
              <div className="h-full w-full animate-pulse bg-info" />
            </div>
          )}

          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={indicator.badge} className="gap-1.5 px-2.5 py-1 font-medium">
                  {isRunning ? <Loader2 className="size-3 animate-spin" /> : <StatusDot status={indicator.dot} />}
                  {isRunning ? "处理中" : STATUS[state.status]}
                </Badge>
                <Badge variant={state.config.enabled ? "accent" : "neutral"} className="px-2.5 py-1 font-normal">
                  {state.config.enabled ? "持续申请已开启" : "自动申请已关闭"}
                </Badge>
                {state.browserOpen && (
                  <Badge variant="warn" className="gap-1.5 px-2.5 py-1 font-normal">
                    <StatusDot status="needs_login" />
                    专用浏览器已打开
                  </Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-3 text-xs"
                  title="跳过本地冷却立即执行；成功申请后重新计时，零成功保留原冷却和下次自动申请时间"
                  disabled={disabled || working}
                  onClick={() => void perform("runNow")}
                >
                  {isRoundRunning ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  立即执行一轮
                </Button>
                {state.config.enabled && (
                  <Button
                    type="button"
                    size="sm"
                    variant={isRunning ? "danger" : "outline"}
                    className="h-7 px-3 text-xs"
                    disabled={!connection.connected}
                    onClick={() => void stop()}
                  >
                    <Square className="size-3" />
                    停止自动申请
                  </Button>
                )}
              </div>
            </div>

            {isRunning && (
              <div className="rounded-control border border-info bg-info-soft px-3.5 py-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium text-info">
                    <Activity className="size-4 animate-pulse shrink-0" />
                    <span>{runningHeadline}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {batchProgress && (
                      <Badge variant="info" className="tabular">
                        本轮进度 {batchProgress.current} / {batchProgress.total}
                      </Badge>
                    )}
                    {state.pendingEmail && (
                      <Badge variant="warn" className="font-mono font-normal">
                        待确认：{state.pendingEmail}
                      </Badge>
                    )}
                  </div>
                </div>
                {batchProgress && (
                  <div className="mt-2">
                    <Progress value={batchProgress.percent} className="h-1.5" />
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-2.5 rounded-control border border-subtle bg-sunken/60 p-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-muted">
                  <SlidersHorizontal className="size-3" />
                  <span>申请策略与网络</span>
                </div>
                <p className="font-medium text-primary">
                  {strategySummary(state.config)} · <span className="font-normal text-secondary">{NETWORK[state.config.networkMode]}</span>
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-muted">
                  <Tag className="size-3" />
                  <span>默认标签与云端备注</span>
                </div>
                <p className="truncate text-secondary" title={`${state.config.label}${state.config.note ? ` · ${state.config.note}` : ""}`}>
                  标签：<strong className="font-medium text-primary">{state.config.label || "—"}</strong>
                  {state.config.note ? ` · 备注：${state.config.note}` : " · 无固定备注"}
                </p>
              </div>

              <div className="space-y-1 tabular">
                <div className="flex items-center gap-1.5 text-muted">
                  <Clock className="size-3" />
                  <span>调度计划</span>
                </div>
                <div className="flex flex-col gap-0.5 text-secondary">
                  <span>下次自动申请：{state.config.enabled && needsLogin ? "等待登录" : time(state.nextRunAt)}</span>
                  {state.cooldownUntil && <span className="text-warn">冷却至：{time(state.cooldownUntil)}</span>}
                </div>
              </div>

              <div className="space-y-1 tabular">
                <div className="flex items-center gap-1.5 text-muted">
                  <ShieldCheck className="size-3" />
                  <span>同步与库存统计</span>
                </div>
                <div className="flex flex-col gap-0.5 text-secondary">
                  <span>最近同步：{time(state.lastSyncAt)}</span>
                  <span className="text-muted">
                    库存：<span className="text-ok font-medium">未使用 {unusedCount}</span> · 待确认 {unknownCount} · 已使用 {usedCount}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span role="status" className={cn("font-medium", isRunning ? "text-info" : "text-secondary")}>
                {state.lastMessage || "请在专用浏览器中手动登录，勾选“保持登录/信任此浏览器”后同步列表。"}
              </span>
              {["not_logged_in", "needs_login"].includes(state.status) && state.lastMessage && (
                <span>登录时请勾选“保持登录 / 信任此浏览器”，以便关闭窗口后继续申请。</span>
              )}
              {state.browserOpen && state.config.enabled && !state.busy && (
                <span className="text-warn">手动浏览器打开期间自动申请暂停，关闭浏览器后继续。</span>
              )}
            </div>
          </div>
        </div>
      )}

      {state?.config.enabled && needsLogin && <div role="alert" className="rounded-panel border border-warn bg-warn-soft px-4 py-2.5 text-xs leading-5 text-warn">
        自动申请已开启，但 iCloud 尚未登录或登录已失效。请点击“打开 iCloud / 登录”，登录并同步成功后等待 {state.config.intervalMinutes} 分钟开始申请；请关闭专用浏览器，以便后台自动运行。
      </div>}

      {state?.pendingEmail && <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-warn bg-warn-soft px-4 py-2.5 text-xs text-warn">
        <p>待核对地址：<strong className="font-mono">{state.pendingEmail}</strong>。{state.busy ? "正在处理，完成后自动同步确认结果…" : "自动同步未能确认结果，请检查登录或网络后重试同步。"}</p>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={disabled || busy} onClick={() => setAcknowledge(true)}>我已在 iCloud 核对结果</Button>
      </div>}

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64 sm:w-72">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted" />
            <Input
              id="icloud-search"
              className="h-8 pl-8 text-xs"
              aria-label="搜索邮箱"
              placeholder="搜索邮箱、标签或备注（空格分隔多词）…"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </div>

          <div className="flex items-center rounded-control border border-subtle bg-sunken p-0.5 text-xs tabular">
            {([
              { key: "all", label: "全部", count: rows.length },
              { key: "unused", label: "未使用", count: unusedCount },
              { key: "unknown", label: "待确认", count: unknownCount },
              { key: "used", label: "已使用", count: usedCount },
            ] as const).map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setUsage(tab.key)}
                className={cn(
                  "rounded-chip px-2 py-1 text-xs transition-colors cursor-pointer",
                  usage === tab.key ? "bg-panel font-medium text-primary shadow-panel" : "text-muted hover:text-secondary"
                )}
              >
                {tab.label} <span className="opacity-75">({tab.count})</span>
              </button>
            ))}
          </div>

          <select id="icloud-usage-filter" aria-label="使用状态筛选" className={`${filterSelectClass} sr-only`} value={usage} onChange={event => setUsage(event.target.value)}>
            <option value="all">全部使用状态</option>
            {Object.entries(USAGE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>

          <select id="icloud-remote-filter" aria-label="云端状态筛选" className={filterSelectClass} value={remote} onChange={event => setRemote(event.target.value)}>
            <option value="all">全部云端状态</option>
            {Object.entries(REMOTE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>

          {hasFilters && (
            <Button size="sm" variant="ghost" className="h-8 px-2.5 text-xs text-muted hover:text-primary" onClick={() => { setQuery(""); setUsage("all"); setRemote("all"); }}>
              <X className="size-3.5" />清除筛选
            </Button>
          )}
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted tabular">
            <Filter className="size-3" />
            共 {rows.length} 个 · 筛选 {filtered.length} 个 · 已选 <strong className={cn("font-medium", selectedRows.length > 0 ? "text-accent" : "text-secondary")}>{selectedRows.length}</strong> 个
          </span>
        </div>

        <div className="overflow-hidden rounded-panel border border-line bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle bg-sunken px-3 py-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set([...selected, ...visible.map(row => row.id)]))}>选择当前页</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set(filtered.map(row => row.id)))}>选择全部筛选结果</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!selectedRows.length} onClick={() => setSelected(new Set())}>清空选择</Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={!selectedRows.length || busy} onClick={() => void copy(selected)}><Copy className="size-3.5" />复制选中</Button>
              <Button size="sm" variant={selectedRows.length ? "default" : "outline"} className="h-7 px-2.5 text-xs" disabled={!selectedRows.length || disabled || busy} onClick={() => void copy(selected, true)}>复制并标记已使用</Button>
              <div className="mx-0.5 hidden h-3.5 w-px bg-subtle sm:block" />
              {(["unused", "used", "unknown"] as const).map(value => (
                <Button key={value} size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!selectedRows.length || disabled || busy} onClick={() => void mark(value)}>
                  标记{USAGE[value]}
                </Button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-subtle bg-sunken/50 text-xs text-muted">
                <tr>
                  {["选择", "邮箱", "iCloud 标签", "iCloud 备注", "本地备注", "使用状态", "云端状态", "创建时间", "操作"].map(label => (
                    <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle bg-panel">
                {visible.map(row => {
                  const isRowSelected = selected.has(row.id);
                  return (
                    <tr key={row.id} className={cn("transition-colors hover:bg-hover", isRowSelected && "bg-accent-soft/40")}>
                      <td className="px-3 py-2">
                        <Checkbox aria-label={`选择 ${row.email}`} checked={isRowSelected} onCheckedChange={checked => toggle(row.id, checked === true)} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-primary">{row.email}</td>
                      <td className="max-w-40 truncate px-3 py-2 text-xs text-secondary" title={row.label}>{row.label}</td>
                      <td className="max-w-48 truncate px-3 py-2 text-xs text-secondary" title={row.cloudNote}>{row.cloudNote || "—"}</td>
                      <td className="max-w-48 truncate px-3 py-2 text-xs text-secondary" title={row.localNote}>{row.localNote || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <Badge variant={row.usage === "unused" ? "ok" : row.usage === "used" ? "neutral" : "warn"} className="font-normal">
                          {USAGE[row.usage]}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <Badge variant={row.remoteState === "active" ? "ok" : row.remoteState === "missing" ? "danger" : "neutral"} className="font-normal">
                          {REMOTE[row.remoteState]}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted tabular">{time(row.createdAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center">
                          <Button size="icon-sm" variant="ghost" aria-label={`复制 ${row.email}`} disabled={busy} onClick={() => void copy(new Set([row.id]))}><Copy className="size-3.5" /></Button>
                          <Button size="icon-sm" variant="ghost" aria-label={`编辑 ${row.email} 的本地备注`} disabled={disabled || busy} onClick={() => setEdit({ id: row.id, email: row.email, note: row.localNote })}><Pencil className="size-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visible.length && <p className="p-8 text-center text-xs text-muted">{rows.length ? "没有符合筛选条件的邮箱" : "登录后同步列表，已有邮箱将标为待确认"}</p>}
          </div>

          <div className="flex items-center justify-between border-t border-subtle bg-sunken/40 px-3 py-1.5 text-xs text-muted tabular">
            <span>每页 50 条</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
              <span>{currentPage + 1} / {pageCount}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button>
            </div>
          </div>
        </div>
      </div>

      {!!state?.history.length && (
        <details className="rounded-panel border border-subtle bg-panel px-4 py-2.5">
          <summary className="cursor-pointer text-xs font-medium text-secondary">最近申请与同步记录（{state.history.length}）</summary>
          <div className="mt-2.5 divide-y divide-subtle border-t border-subtle pt-1">
            {state.history.map((entry, index) => {
              const outcomeDot = entry.outcome === "ok" ? "ok" : ["started", "retry", "cooldown", "uncertain", "unchanged"].includes(entry.outcome) ? "needs_login" : "failed";
              return (
                <div key={`${entry.at}-${index}`} className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
                  <StatusDot status={outcomeDot} />
                  <span className="text-muted tabular">{time(entry.at)}</span>
                  <Badge variant="neutral" className="px-1.5 py-0 text-2xs font-normal">
                    {HISTORY_ACTION_LABELS[entry.action] ?? entry.action}
                  </Badge>
                  <span className="text-secondary">{entry.message}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </PageBody>

    <Dialog open={configOpen} onOpenChange={open => { if (!open) closeConfig(); else setConfigOpen(true); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>申请设置</DialogTitle>
          <DialogDescription>配置隐藏邮件地址的申请策略、固定标签与自动申请开关。</DialogDescription>
        </DialogHeader>
        {draft && (
          <form onSubmit={event => void save(event)} className="space-y-4">
            <fieldset disabled={disabled || busy || loadError} className="grid gap-3.5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="icloud-mode">申请模式</Label>
                <select
                  id="icloud-mode"
                  className={`${controlSelectClass} w-full`}
                  value={mode}
                  onChange={event => change({
                    mode: event.target.value as IcloudConfig["mode"],
                    batchSize: draft.batchSize ?? 5,
                    ...(mode === "single" && event.target.value !== "single" && draft.intervalMinutes === 15 ? { intervalMinutes: 60 } : {}),
                  })}
                >
                  <option value="single">每次 1 个</option>
                  <option value="batch">每轮固定数量</option>
                  <option value="until_limit">申请到 iCloud 提示上限</option>
                </select>
              </div>
              {mode === "batch" && (
                <div className="space-y-1.5">
                  <Label htmlFor="icloud-batch-size">每轮申请数量</Label>
                  <Input id="icloud-batch-size" type="number" min={1} max={5} required value={draft.batchSize ?? 5} onChange={event => change({ batchSize: Number(event.target.value) })} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="icloud-interval">{mode === "single" ? "单个申请间隔（分钟）" : mode === "batch" ? "轮次间隔（分钟）" : "限额后等待（分钟）"}</Label>
                <Input id="icloud-interval" type="number" min={1} max={1440} required value={draft.intervalMinutes} onChange={event => change({ intervalMinutes: Number(event.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="icloud-network">网络模式</Label>
                <select id="icloud-network" className={`${controlSelectClass} w-full`} value={draft.networkMode} disabled={state?.browserOpen} onChange={event => change({ networkMode: event.target.value as IcloudConfig["networkMode"] })}>
                  <option value="direct">直连（默认）</option>
                  <option value="inherit">跟随网络配置</option>
                  <option value="system">系统代理</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="icloud-label">固定标签 *</Label>
                <Input id="icloud-label" required maxLength={100} value={draft.label} onChange={event => change({ label: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="icloud-note">固定 iCloud 备注</Label>
                <Input id="icloud-note" maxLength={1000} value={draft.note} onChange={event => change({ note: event.target.value })} placeholder="可选，写入新邮箱的云端备注" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-control border border-subtle bg-sunken px-3.5 py-2.5 sm:col-span-2">
                <Label htmlFor="icloud-enabled" className="cursor-pointer">自动申请 · 持续申请</Label>
                <Switch id="icloud-enabled" checked={draft.enabled} onCheckedChange={enabled => change({ enabled })} />
              </div>
            </fieldset>
            <p className="rounded-control bg-sunken px-3.5 py-2.5 text-xs leading-5 text-muted">
              {mode === "single" ? `每隔 ${draft.intervalMinutes} 分钟申请 1 个。` : mode === "batch" ? `每轮连续申请 ${draft.batchSize ?? 5} 个，完成后等待 ${draft.intervalMinutes} 分钟开始下一轮。` : `连续逐个申请，直到 iCloud 返回限额；达到限额即结束本轮并自动同步，持续申请保持开启，冷却后继续。至少等待 ${draft.intervalMinutes} 分钟，冷却要求更久时按冷却时间等待。`}
              {mode !== "until_limit" && "定时申请滚动一小时最多尝试 5 次，服务端限制优先。"}每个地址确认成功后才申请下一个；出错或点击停止会结束本轮。开启或保存后先等待设定间隔，也可点击“立即执行一轮”跳过本地冷却：成功至少 1 个后从本轮结束重新计时，零成功保留原冷却和下次自动申请时间。可查看上方下次自动申请时间。最小化到托盘后继续，完全退出或休眠期间停止，恢复后不集中补跑。
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={working} onClick={closeConfig}>取消</Button>
              <Button type="submit" disabled={disabled || busy || loadError || !dirty || !draft.label.trim()}>保存设置</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>

    <Dialog open={edit !== null} onOpenChange={open => { if (!open && !working) setEdit(null); }}><DialogContent><DialogHeader><DialogTitle>编辑本地备注</DialogTitle><DialogDescription>{edit?.email} · 仅保存在本软件中</DialogDescription></DialogHeader>
      <Textarea aria-label="本地备注" value={edit?.note ?? ""} maxLength={2000} disabled={working} onChange={event => { if (edit) setEdit({ ...edit, note: event.target.value }); }} />
      <DialogFooter><Button disabled={working || disabled} onClick={async () => { if (!edit) return; setWorking(true); try { await update([edit.id], { localNote: edit.note }); setEdit(null); } catch (error) { notify.error("保存本地备注失败", error); } finally { setWorking(false); } }}>保存本地备注</Button></DialogFooter>
    </DialogContent></Dialog>

    <AlertDialog open={acknowledge} onOpenChange={setAcknowledge}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认已核对创建结果</AlertDialogTitle><AlertDialogDescription>请先在 iCloud 中查找待核对地址。若已创建，建议先同步列表；继续会清除本地待核对标记，允许下一次申请。自动申请仍保持关闭。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={working}>返回</AlertDialogCancel><Button disabled={working} onClick={async () => { setWorking(true); try { setSnapshot(await agentCall("icloud.acknowledge", {}, await newCommandId())); setAcknowledge(false); } catch (error) { notify.error("确认失败", error); } finally { setWorking(false); } }}>已核对，允许继续</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </Page>;
}

