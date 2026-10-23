import { useEffect, useState } from "react";
import {
  Copy,
  Eraser,
  ExternalLink,
  Globe,
  Loader2,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { StatusDot, type StatusDotProps } from "@/components/ui/status-dot";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { agentCall, newCommandId } from "@/ipc/bridge";
import type { TemporaryWindowResult, TemporaryWindowSaveParams } from "@/ipc/generated";
import { formatDateTime } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useKeeperStore } from "@/store/keeperStore";

type WindowAction = "open" | "close" | "detectRegion" | "clearData" | "remove";
type StatusFilter = "all" | "open" | "closed" | "issue";

const ACTION_LABELS: Record<WindowAction, string> = {
  open: "打开窗口",
  close: "关闭窗口",
  detectRegion: "探测时区",
  clearData: "清理浏览数据",
  remove: "删除窗口",
};

const STATE_LABELS: Record<TemporaryWindowResult["state"], string> = {
  closed: "已关闭",
  busy: "处理中",
  open: "已打开",
  close_failed: "关闭失败",
};

function getWindowStatusMeta(
  window: TemporaryWindowResult,
  isBusy: boolean
): {
  label: string;
  dot: NonNullable<StatusDotProps["status"]>;
  badgeVariant: NonNullable<BadgeProps["variant"]>;
  cardBorderClass: string;
} {
  if (isBusy) {
    return {
      label: "处理中",
      dot: "busy",
      badgeVariant: "info",
      cardBorderClass: "border-accent/60 ring-1 ring-accent/25",
    };
  }
  if (window.state === "close_failed") {
    return {
      label: STATE_LABELS.close_failed,
      dot: "failed",
      badgeVariant: "danger",
      cardBorderClass: "border-danger/60 ring-1 ring-danger/25",
    };
  }
  if (window.state === "open") {
    return {
      label: STATE_LABELS.open,
      dot: "ok",
      badgeVariant: "ok",
      cardBorderClass: "border-ok/50 ring-1 ring-ok/20",
    };
  }
  return {
    label: STATE_LABELS.closed,
    dot: "unknown",
    badgeVariant: "neutral",
    cardBorderClass: "border-subtle hover:border-line",
  };
}

function formatLatencyBadge(ms: number | null, ok: boolean | null) {
  if (ok === false) {
    return <span className="text-2xs text-danger tabular">测速失败</span>;
  }
  if (ok !== true || ms === null) return null;
  const colorClass = ms < 200 ? "text-ok" : ms < 500 ? "text-warn" : "text-danger";
  return <span className={cn("font-mono text-2xs tabular", colorClass)}>{ms}ms</span>;
}

export function TemporaryWindowsPage() {
  const windows = useKeeperStore((state) => state.temporaryWindows);
  const proxies = useKeeperStore((state) => state.proxies);
  const connection = useKeeperStore((state) => state.connection);
  const draining = useKeeperStore((state) => state.draining);
  const operations = useKeeperStore((state) => state.operations);
  const runOperation = useKeeperStore((state) => state.runOperation);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<TemporaryWindowSaveParams | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Map<string, WindowAction>>(new Map());
  const [confirmation, setConfirmation] = useState<{
    window: TemporaryWindowResult;
    action: "remove" | "clearData";
  } | null>(null);

  const disabled = !connection.connected || draining;
  const usableNodes = proxies.nodes.filter((node) => node.enabled && !node.missing);

  const activeOp = (windowId: string) =>
    operations.find(
      (op) => op.resourceId === windowId && ["queued", "running"].includes(op.state)
    );

  const busy = (window: TemporaryWindowResult) =>
    pending.has(window.id) || window.state === "busy" || Boolean(activeOp(window.id));

  const isProbing = (window: TemporaryWindowResult) =>
    pending.get(window.id) === "detectRegion" ||
    activeOp(window.id)?.kind === "temporary-window-detectRegion";

  const isNodeUnavailable = (proxyId: string) => {
    const node = proxies.nodes.find((item) => item.id === proxyId);
    return !node || node.missing || !node.enabled;
  };

  const isWindowOpen = (window: TemporaryWindowResult) =>
    window.state === "open" ||
    window.state === "close_failed" ||
    (window.state === "busy" && window.openedAt !== null);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await agentCall("temporaryWindows.list", {});
      useKeeperStore.setState({ temporaryWindows: result });
      setLoadError(false);
    } catch (error) {
      setLoadError(true);
      notify.error("读取临时窗口失败", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connection.connected) void refresh();
  }, [connection.connected]);

  const perform = async (action: WindowAction, window: TemporaryWindowResult) => {
    setPending((current) => new Map(current).set(window.id, action));
    try {
      await runOperation(`temporaryWindows.${action}`, { id: window.id });
      notify.success(`${ACTION_LABELS[action]}成功`);
      setConfirmation((current) =>
        current?.window.id === window.id && current.action === action ? null : current
      );
    } catch (error) {
      notify.error(`${ACTION_LABELS[action]}失败`, error);
    } finally {
      setPending((current) => {
        const next = new Map(current);
        next.delete(window.id);
        return next;
      });
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    try {
      const saved = await agentCall("temporaryWindows.save", draft, await newCommandId());
      useKeeperStore.setState((state) => ({
        temporaryWindows: state.temporaryWindows.some((item) => item.id === saved.id)
          ? state.temporaryWindows.map((item) => (item.id === saved.id ? saved : item))
          : [...state.temporaryWindows, saved],
      }));
      setDraft(null);
      notify.success("临时窗口已保存");
      if (!saved.timezone) void perform("detectRegion", saved);
    } catch (error) {
      notify.error("保存临时窗口失败", error);
    } finally {
      setSaving(false);
    }
  };

  const handleCopyIp = (ip: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(ip).catch(() => {});
    }
    notify.success("已复制出口 IP", ip);
  };

  const openCount = windows.filter(isWindowOpen).length;
  const closedCount = windows.length - openCount;
  const issueCount = windows.filter(
    (w) => w.state === "close_failed" || isNodeUnavailable(w.proxyId)
  ).length;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const hasActiveFilter = normalizedQuery.length > 0 || statusFilter !== "all";

  const filtered = windows.filter((window) => {
    if (statusFilter === "open" && !isWindowOpen(window)) {
      return false;
    }
    if (statusFilter === "closed" && isWindowOpen(window)) {
      return false;
    }
    if (
      statusFilter === "issue" &&
      window.state !== "close_failed" &&
      !isNodeUnavailable(window.proxyId)
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    const nodeName =
      proxies.nodes.find((node) => node.id === window.proxyId)?.name ??
      window.proxyName ??
      "";
    return [
      window.name,
      window.note,
      window.homepage,
      window.timezone ?? "",
      window.exitIp ?? "",
      nodeName,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });

  const filterTabs: { id: StatusFilter; label: string; count: number; dot?: StatusDotProps["status"] }[] = [
    { id: "all", label: "全部", count: windows.length },
    { id: "open", label: "运行中", count: openCount, dot: openCount > 0 ? "ok" : undefined },
    { id: "closed", label: "已关闭", count: closedCount },
    ...(issueCount > 0 || statusFilter === "issue"
      ? [{ id: "issue" as const, label: "异常", count: issueCount, dot: "failed" as const }]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        title="临时窗口"
        description="独立选择出口节点，按实际出口 IP 自动设置时区。关闭后保留浏览数据。"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={() => void refresh()}
              disabled={disabled || loading}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              刷新
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              disabled={disabled}
              onClick={() =>
                setDraft({
                  name: "",
                  note: "",
                  homepage: "https://chatgpt.com/",
                  proxyId: "",
                })
              }
            >
              <Plus className="size-3.5" />
              新增窗口
            </Button>
          </>
        }
      />

      {/* 顶部筛选与状态统计栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="relative w-64 sm:w-72">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted"
          />
          <Input
            aria-label="搜索临时窗口"
            placeholder="搜索名称、备注、主页、节点或 IP…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-8 pr-7 text-xs"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
              className="absolute right-2 top-2 text-muted hover:text-primary"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div
          role="group"
          aria-label="窗口状态筛选"
          className="inline-flex h-8 items-center gap-0.5 rounded-control border border-subtle bg-sunken p-0.5"
        >
          {filterTabs.map((tab) => {
            const active = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={cn(
                  "inline-flex h-full items-center gap-1.5 rounded-chip px-2.5 text-xs transition-colors",
                  active
                    ? "bg-panel font-medium text-primary shadow-panel"
                    : "text-secondary hover:text-primary"
                )}
              >
                {tab.dot && <StatusDot status={tab.dot} className="size-1.5" />}
                <span>{tab.label}</span>
                <span
                  className={cn(
                    "text-2xs tabular",
                    active ? "text-secondary" : "text-muted"
                  )}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {hasActiveFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
            }}
            className="h-8 px-2.5 text-xs text-muted hover:text-primary"
          >
            <X className="size-3.5" />
            清除筛选
          </Button>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-muted tabular">
          <span>可用节点 {usableNodes.length}</span>
          <span className="text-subtle">·</span>
          <span>
            {hasActiveFilter
              ? `${filtered.length} / ${windows.length} 个窗口`
              : `${windows.length} 个窗口`}
          </span>
        </div>
      </div>

      <PageBody className="pb-12">
        {loadError && (
          <div
            role="alert"
            className="mb-4 rounded-panel border border-danger bg-danger-soft px-3.5 py-2 text-xs text-danger"
          >
            临时窗口读取失败，请点击刷新重试。
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <EmptyState
            icon={hasActiveFilter ? <SearchX /> : <PanelsTopLeft />}
            title={hasActiveFilter ? "没有匹配的临时窗口" : "还没有临时窗口"}
            description={
              hasActiveFilter
                ? "当前搜索或状态筛选下没有匹配的窗口，请尝试放宽条件。"
                : "每个临时窗口拥有独立的浏览器 Profile 与出口节点，按实际出口 IP 自动匹配语言和时区。"
            }
            action={
              hasActiveFilter ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    setDraft({
                      name: "",
                      note: "",
                      homepage: "https://chatgpt.com/",
                      proxyId: "",
                    })
                  }
                >
                  <Plus className="size-3.5" />
                  创建第一个窗口
                </Button>
              )
            }
          />
        )}

        {filtered.length > 0 && (
          // 紧凑标签式卡片网格：限制单卡最大宽度 350px，避免在常规窗口下被拉成宽幅横条。
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),350px))] items-start justify-start gap-3.5">
            {filtered.map((window) => {
              const node = proxies.nodes.find((item) => item.id === window.proxyId);
              const nodeDisplayName = node?.name || window.proxyName || "节点已丢失";
              const unavailable = !node || node.missing || !node.enabled;
              const isBusy = busy(window);
              const probing = isProbing(window);
              const isClosed = window.state === "closed";
              const statusMeta = getWindowStatusMeta(window, isBusy);

              return (
                <article
                  key={window.id}
                  aria-label={`临时窗口 ${window.name}`}
                  className={cn(
                    "flex flex-col rounded-panel border bg-panel shadow-panel transition-colors",
                    statusMeta.cardBorderClass
                  )}
                >
                  {/* 卡头：紧凑名称 + 精致微标签 */}
                  <div className="flex items-start justify-between gap-2.5 px-3.5 pt-3 pb-2">
                    <div className="min-w-0 flex-1">
                      <h2
                        className="truncate text-base font-semibold leading-snug text-primary"
                        title={window.name}
                      >
                        {window.name}
                      </h2>
                      <p
                        className="mt-0.5 truncate text-xs text-muted"
                        title={window.note || undefined}
                      >
                        {window.note || "未填写备注"}
                      </p>
                    </div>
                    <Badge
                      variant={statusMeta.badgeVariant}
                      className="shrink-0 gap-1.5 px-1.5 py-0.5 text-2xs font-medium leading-none"
                    >
                      <StatusDot status={statusMeta.dot} className="size-1.5" />
                      {statusMeta.label}
                    </Badge>
                  </div>

                  {/* 卡身：节点、主页与环境探测面板 */}
                  <div className="flex flex-col gap-2 px-3.5 pb-2.5 text-xs">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="shrink-0 text-muted">出口节点</span>
                        <div className="flex min-w-0 items-center gap-1.5">
                          {!unavailable &&
                            node &&
                            formatLatencyBadge(node.latencyMs, node.latencyOk)}
                          <span
                            className={cn(
                              "truncate font-medium",
                              unavailable ? "text-danger" : "text-primary"
                            )}
                            title={
                              unavailable ? `${nodeDisplayName}（不可用）` : nodeDisplayName
                            }
                          >
                            {nodeDisplayName}
                            {unavailable ? "（不可用）" : ""}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <span className="shrink-0 text-muted">默认主页</span>
                        <span
                          className="truncate font-mono text-2xs text-secondary"
                          title={window.homepage}
                        >
                          {window.homepage}
                        </span>
                      </div>
                    </div>

                    {/* 凹陷环境快照区 */}
                    <div className="rounded-control border border-subtle/70 bg-sunken/70 px-2.5 py-2 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="shrink-0 text-2xs text-muted">时区环境</span>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono text-2xs text-primary">
                            {window.timezone || "待探测"}
                          </span>
                          {window.locale && (
                            <span className="shrink-0 rounded-sm bg-panel px-1 py-px font-mono text-2xs text-muted border border-subtle">
                              {window.locale}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span className="shrink-0 text-2xs text-muted">出口 IP</span>
                        {window.exitIp ? (
                          <button
                            type="button"
                            onClick={() => handleCopyIp(window.exitIp!)}
                            title={`${window.exitIp} (点击复制)`}
                            className="group inline-flex items-center gap-1 font-mono text-2xs tabular text-secondary hover:text-accent transition-colors"
                          >
                            <span>{window.exitIp}</span>
                            <Copy className="size-2.5 opacity-0 transition-opacity group-hover:opacity-70" />
                          </button>
                        ) : (
                          <span className="font-mono text-2xs text-muted">—</span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 border-t border-subtle/60 pt-1 text-2xs text-muted">
                        <span
                          className="truncate"
                          title={
                            window.detectedAt
                              ? `上次探测：${formatDateTime(window.detectedAt, { seconds: true })}`
                              : undefined
                          }
                        >
                          {window.detectedAt ? (
                            <>
                              探测于 <RelativeTime value={window.detectedAt} />
                            </>
                          ) : (
                            "保存及打开时自动探测"
                          )}
                        </span>
                        {!isClosed && (
                          <span className="shrink-0 text-warn" title="关闭窗口后可编辑、清理浏览数据或删除">
                            关闭后可改配
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 卡底操作栏：左侧主操作，右侧紧凑图标工具条 */}
                  <div className="mt-auto flex items-center justify-between gap-1.5 border-t border-subtle bg-sunken/40 px-2.5 py-1.5">
                    {isClosed ? (
                      <Button
                        size="sm"
                        className="h-7 px-2.5 text-xs gap-1.5"
                        disabled={disabled || isBusy || unavailable}
                        onClick={() => void perform("open", window)}
                      >
                        {isBusy && !probing ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <ExternalLink className="size-3.5" />
                        )}
                        打开
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={window.state === "close_failed" ? "danger" : "outline"}
                        className="h-7 px-2.5 text-xs gap-1.5"
                        disabled={!connection.connected || isBusy}
                        onClick={() => void perform("close", window)}
                      >
                        {isBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Square className="size-3" />
                        )}
                        {window.state === "close_failed" ? "重试关闭" : "关闭"}
                      </Button>
                    )}

                    <div className="flex items-center gap-0.5">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-7"
                        aria-label="探测时区"
                        title="探测时区"
                        disabled={disabled || isBusy || !isClosed || unavailable}
                        onClick={() => void perform("detectRegion", window)}
                      >
                        <Globe className={cn("size-3.5", probing && "animate-spin text-accent")} />
                      </Button>

                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-7"
                        aria-label="编辑"
                        title="编辑配置"
                        disabled={disabled || isBusy || !isClosed}
                        onClick={() =>
                          setDraft({
                            id: window.id,
                            name: window.name,
                            note: window.note,
                            homepage: window.homepage,
                            proxyId: window.proxyId,
                          })
                        }
                      >
                        <Pencil className="size-3.5" />
                      </Button>

                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-7"
                        aria-label="清理浏览数据"
                        title="清理浏览数据"
                        disabled={disabled || isBusy || !isClosed}
                        onClick={() => setConfirmation({ window, action: "clearData" })}
                      >
                        <Eraser className="size-3.5" />
                      </Button>

                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-7 text-danger hover:bg-danger hover:text-danger-content"
                        aria-label="删除"
                        title="删除窗口"
                        disabled={disabled || isBusy || !isClosed}
                        onClick={() => setConfirmation({ window, action: "remove" })}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </PageBody>

      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "编辑临时窗口" : "新增临时窗口"}</DialogTitle>
            <DialogDescription>
              窗口单独保存登录态，出口节点直接从节点列表选择。
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              id="temporary-window-form"
              onSubmit={(event) => void save(event)}
              className="space-y-4"
            >
              <fieldset disabled={saving} className="space-y-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="temporary-name">名称</Label>
                  <Input
                    id="temporary-name"
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="例如：日本临时窗口"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="temporary-proxy">出口节点</Label>
                  <SearchableSelect
                    id="temporary-proxy"
                    label="选择出口节点"
                    value={draft.proxyId}
                    onValueChange={(proxyId) => setDraft({ ...draft, proxyId })}
                    options={usableNodes.map((node) => ({
                      value: node.id,
                      label: `${node.name}${node.id.startsWith("custom_") ? " · 自定义" : " · 订阅"}`,
                    }))}
                  />
                  {usableNodes.length === 0 && (
                    <p className="text-xs text-warn">
                      暂无可用节点，请先在“分组与代理”页面导入并启用节点。
                    </p>
                  )}
                  {draft.proxyId &&
                    !usableNodes.some((node) => node.id === draft.proxyId) && (
                      <p className="text-xs text-danger">原节点不可用，请重新选择。</p>
                    )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="temporary-homepage">默认主页</Label>
                  <Input
                    id="temporary-homepage"
                    type="url"
                    maxLength={4096}
                    value={draft.homepage || ""}
                    onChange={(event) =>
                      setDraft({ ...draft, homepage: event.target.value })
                    }
                    placeholder="https://chatgpt.com/"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="temporary-note">备注</Label>
                  <Textarea
                    id="temporary-note"
                    rows={2}
                    maxLength={2000}
                    value={draft.note || ""}
                    onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                    placeholder="用途或说明（可选）"
                  />
                </div>

                <p className="rounded-control bg-sunken px-3 py-2 text-xs text-muted">
                  时区由节点实际出口 IP 自动推测，每次打开前重新探测。前置网络连接沿用“网络配置”。
                </p>
              </fieldset>
            </form>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form="temporary-window-form"
              disabled={
                disabled ||
                saving ||
                !draft?.name.trim() ||
                !usableNodes.some((node) => node.id === draft?.proxyId)
              }
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && confirmation && !pending.has(confirmation.window.id)) {
            setConfirmation(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.action === "remove" ? "删除临时窗口" : "清理浏览数据"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              将重置“{confirmation?.window.name}
              ”的全部浏览器数据，包括 Cookie、登录态、缓存、历史记录、书签及扩展设置，此操作无法撤销。
              {confirmation?.action === "remove"
                ? "窗口配置也会删除。"
                : "名称、备注、默认主页和出口节点配置将保留。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={!!confirmation && pending.has(confirmation.window.id)}
            >
              取消
            </AlertDialogCancel>
            <Button
              variant="danger"
              disabled={
                disabled || !confirmation || pending.has(confirmation.window.id)
              }
              onClick={() => {
                if (confirmation) void perform(confirmation.action, confirmation.window);
              }}
            >
              {confirmation && pending.has(confirmation.window.id) && (
                <Loader2 className="size-4 animate-spin" />
              )}
              确认{confirmation?.action === "remove" ? "删除" : "清理"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

