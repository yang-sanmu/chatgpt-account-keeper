import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  LogIn,
  KeyRound,
  AppWindow,
  MonitorX,
  Play,
  RefreshCw,
  Scan,
  History,
  Trash2,
  ChevronDown,
  Loader2,
} from "lucide-react";
import {
  useAccountRecord,
  useAccountActions,
  useAccountRunningOperation,
  useAccountLastRun,
} from "@/store/selectors";
import { useKeeperStore } from "@/store/keeperStore";
import { RelativeTime } from "@/components/ui/relative-time";
import { displayEmail, shortId } from "@/lib/format";
import { describeOperation } from "@/lib/operation-labels";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { SwitchRule } from "@/ipc/types";
import type { AccountDraft } from "@/store/accountModel";
import { describeAccountStatus, statusNeedsAttention } from "./account-status";

/// 卡片内容区的固定高度（未展开「详细配置」时）。
///
/// 容纳 4 项基础信息（分组与出口 32px、轮换进度 26px、下次运行/在途任务 48px、切换规则 32px）
/// 加上底部折叠按钮(28px)、元素间距(4 * 8px = 32px)与下内边距(12px)。
/// 定高确保网格中所有卡片高度严格一致，避免单行错误信息或字段差异导致网格参差不齐；
/// 仅当用户主动展开「详细配置」时才切换为自适应高度撑开。
const CARD_BODY_COLLAPSED_CLASS = "h-[210px]";

interface AccountCardProps {
  id: string;
  onDelete: (id: string, email: string) => void;
}

export const AccountCard = React.memo(({ id, onDelete }: AccountCardProps) => {
  const record = useAccountRecord(id);
  const runningOp = useAccountRunningOperation(id);
  const lastRun = useAccountLastRun(id);
  const actions = useAccountActions();
  const selected = useKeeperStore((s) => s.selectedAccountIds.has(id));
  const toggle = useKeeperStore((s) => s.toggleAccountSelected);
  const emailsRevealed = useKeeperStore((s) => s.emailsRevealed);
  const groups = useKeeperStore((s) => s.groups);
  const [expanded, setExpanded] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);

  if (!record) return null;

  const acc = record.effective;
  const dirty = record.dirtyFields.size > 0;
  const inFlight = record.inFlight !== null;

  const isWaitingUser = runningOp?.state === "waiting_user";
  // acc.running 是 Agent 给的权威占用标记（契约的 accountResult.running）。
  //
  // 单靠 operations 会漏掉一种情况：前端刚连上，而调度早就在跑这个账号了 —— 那次运行的
  // operation 记录不在前端手里，卡片会显示成空闲，用户点「立即运行」得到一个 RESOURCE_BUSY。
  const isRunning = runningOp?.state === "running" || (acc.running && !isWaitingUser);
  const isQueued = runningOp?.state === "queued";
  const opMeta = runningOp ? describeOperation(runningOp.kind, Boolean(runningOp.resourceId)) : null;

  const handleActionClick = async (actionKey: string, fn: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(actionKey);
    try {
      await fn();
    } finally {
      setPendingAction(null);
    }
  };

  const handleGroupChange = (val: string) => {
    const groupId = val === "none" ? null : val;
    actions.save(id, { groupId });
  };

  const handleDraftChange = (patch: AccountDraft) => {
    actions.edit(id, patch);
  };

  /// 窗口数输入。
  ///
  /// 不能直接 Number(e.target.value)：清空输入框时那是空串，Number("") === 0，而 0 会被
  /// 当成一个合法草稿存下去（下限是 1）。清空时保持原值，等用户敲进有效数字再更新。
  const handleWindowChange = (field: "minWindows" | "maxWindows", raw: string) => {
    if (raw.trim() === "") return;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 1) return;
    handleDraftChange({ [field]: value });
  };

  const handleSave = () => {
    actions.save(id, record.draft);
  };

  const handleDiscard = () => {
    actions.discard(id);
  };

  const onEnterSubmit = (e: React.KeyboardEvent) => {
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      if (dirty && !inFlight) handleSave();
    }
  };

  const status = describeAccountStatus(acc.status, {
    stale: acc.stale,
    enabled: acc.enabled,
    promoEligibility: acc.promoEligibility,
    promoStale: acc.promoStale,
  });

  return (
    <Card
      className={cn(
        "flex flex-col transition-colors",
        dirty
          ? "border-accent ring-1 ring-accent"
          : isWaitingUser
          ? "border-warn ring-1 ring-warn/60"
          : isRunning
          ? "border-accent/60 ring-1 ring-accent/30"
          : isQueued
          ? "border-line"
          : ""
      )}
    >
      <CardHeader className="shrink-0 p-3 pb-2">
        <div className="flex items-center gap-2.5">
          <Checkbox
            checked={selected}
            onCheckedChange={() => toggle(id)}
            aria-label="选择账号"
          />
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base" title={acc.email || "未登录"}>
              {displayEmail(acc.email, emailsRevealed)}
            </CardTitle>
          </div>
          {acc.gptName && (
            <Badge variant="outline" className="max-w-24 shrink-0 truncate text-2xs">
              {acc.gptName}
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          {/* 状态文案也要能截断：status 在契约里是开放字符串，Agent 新增一个较长的状态
              就会把卡头顶成两行，定高就白定了。 */}
          <StatusDot
            status={status.dot}
            label={status.label}
            className="min-w-0 [&>span]:truncate"
          />
          <RelativeTime
            value={acc.statusCheckedAt}
            className="shrink-0 text-xs text-muted"
          />
        </div>
      </CardHeader>

      {/* overflow-hidden 是定高的一部分：没有它，任何算漏的内容会直接溢出卡片边框，
          看起来比参差不齐更糟。 */}
      <CardContent
        className={cn(
          "flex flex-col gap-2 overflow-hidden p-3 pt-0 pb-3",
          expanded ? "h-auto min-h-[210px]" : CARD_BODY_COLLAPSED_CLASS
        )}
      >
        {/* 分组与出口节点 */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Select value={acc.groupId ?? "none"} onValueChange={handleGroupChange}>
              <SelectTrigger className="h-8 text-xs" aria-label="选择分组">
                <SelectValue placeholder="未分组" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未分组</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 text-right">
            {acc.exitNodeMissing ? (
              <span className="text-xs text-danger">节点已失效</span>
            ) : acc.exitNode ? (
              <span className="text-xs text-secondary truncate max-w-full block" title={acc.exitNode}>
                {acc.exitNode}
              </span>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </div>
        </div>

        {/* 轮换进度 */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-secondary">
            <span className="truncate max-w-[150px]" title={acc.rotationTopic || "无会话"}>
              {acc.rotationTopic || "暂无轮换策略"}
            </span>
            <span className="tabular">
              {acc.rotationDone} / {acc.rotationTarget}
            </span>
          </div>
          <Progress 
            value={acc.rotationTarget > 0 ? (acc.rotationDone / acc.rotationTarget) * 100 : 0} 
            className="h-1.5"
          />
        </div>

        {/* 下次运行 / 运行中任务状态块（定高保形） */}
        <div
          className={cn(
            "flex flex-col justify-center rounded-sm py-1.5 px-2 min-h-[48px] transition-colors",
            isWaitingUser
              ? "bg-warn-soft border border-warn/30"
              : isRunning
              ? "bg-accent-soft border border-accent/20"
              : "bg-sunken"
          )}
        >
          {runningOp || isRunning ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  {isWaitingUser ? (
                    <span className="size-1.5 rounded-full bg-warn animate-pulse shrink-0" />
                  ) : isRunning ? (
                    <span className="size-1.5 rounded-full bg-accent animate-pulse shrink-0" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-muted shrink-0" />
                  )}
                  <span
                    className={cn(
                      "text-xs font-medium truncate",
                      isWaitingUser ? "text-warn" : isRunning ? "text-accent" : "text-secondary"
                    )}
                  >
                    {isWaitingUser
                      ? `需人工介入 · ${opMeta?.action ?? "登录"}`
                      : isQueued
                      ? `排队 · ${opMeta?.action ?? "任务"}`
                      : (opMeta?.action ?? "正在运行")}
                  </span>
                </div>
                {typeof runningOp?.progress === "number" && (
                  <span className="text-2xs font-mono tabular text-secondary shrink-0">
                    {Math.round(runningOp.progress * 100)}%
                  </span>
                )}
              </div>
              <div
                className="truncate text-2xs text-secondary"
                title={runningOp?.stage || runningOp?.message || "进行中"}
              >
                {runningOp?.stage
                  ? `阶段: ${runningOp.stage}`
                  : (runningOp?.message ?? "调度已占用此账号")}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">下次运行</span>
                <RelativeTime
                  value={acc.nextRunAt}
                  className="text-xs text-primary"
                />
              </div>
              {lastRun.lastRunOk === false && lastRun.lastRunReason ? (
                <div
                  tabIndex={0}
                  title={`失败: ${lastRun.lastRunReason}`}
                  className="text-2xs text-danger mt-1 bg-danger-soft px-1.5 py-0.5 rounded-sm truncate cursor-help focus-visible:ring-1"
                >
                  失败: {lastRun.lastRunReason}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* 轮换规则 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">切换规则</span>
          {/* 下拉选择即时保存，和上面的分组一致：下拉不像文本框那样有「还在输入」的状态，
              选完却要再点一次保存会让人以为没生效。 */}
          <Select
            value={acc.switchRule}
            onValueChange={(value) => void actions.save(id, { switchRule: value as SwitchRule })}
          >
            <SelectTrigger className="w-24 h-8 text-xs" aria-label="切换规则">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="random">随机</SelectItem>
              <SelectItem value="sequential">顺序</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 详细配置 折叠区 */}
        <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-auto">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full h-7 text-xs text-muted gap-1">
              {expanded ? "收起详细配置" : "展开详细配置"}
              <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2.5 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor={`note-${id}`} className="text-xs text-muted">
                备注
              </Label>
              <Input
                id={`note-${id}`}
                value={acc.note}
                onChange={(e) => handleDraftChange({ note: e.target.value })}
                onKeyDown={onEnterSubmit}
                className="h-8 text-xs"
                placeholder="添加备注…"
              />
            </div>

            {/* 启用开关。停用的账号不参与调度，这是个需要能直接看到并切换的状态，
                原来只能通过底部批量栏改。 */}
            <div className="flex items-center justify-between">
              <Label htmlFor={`enabled-${id}`} className="text-xs text-muted">
                参与自动调度
              </Label>
              <Switch
                id={`enabled-${id}`}
                checked={acc.enabled}
                onCheckedChange={(checked) => void actions.save(id, { enabled: checked })}
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor={`min-windows-${id}`} className="text-xs text-muted">
                  最小窗口
                </Label>
                <Input
                  id={`min-windows-${id}`}
                  type="number"
                  value={acc.minWindows}
                  onChange={(e) => handleWindowChange("minWindows", e.target.value)}
                  onKeyDown={onEnterSubmit}
                  className="tabular h-8 text-xs"
                  min={1}
                />
              </div>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor={`max-windows-${id}`} className="text-xs text-muted">
                  最大窗口
                </Label>
                <Input
                  id={`max-windows-${id}`}
                  type="number"
                  value={acc.maxWindows}
                  onChange={(e) => handleWindowChange("maxWindows", e.target.value)}
                  onKeyDown={onEnterSubmit}
                  className="tabular h-8 text-xs"
                  min={1}
                />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <div className="mt-auto">
        {dirty ? (
          <div className="flex items-center justify-end gap-2 p-2.5 bg-accent-soft border-t border-accent/20 rounded-b-panel">
            <span className="text-xs text-accent mr-auto">未保存的更改</span>
            <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={inFlight} className="h-7 text-xs">
              放弃
            </Button>
            <Button variant="default" size="sm" onClick={handleSave} disabled={inFlight} className="h-7 text-xs">
              {inFlight && <Loader2 className="mr-1.5 size-3 animate-spin" />}
              保存
            </Button>
          </div>
        ) : (
          <CardFooter className="p-2 border-t border-subtle bg-sunken/50 justify-between">
            <div className="flex gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pendingAction !== null}
                onClick={() => handleActionClick("login", () => actions.startLogin(id, false))}
                aria-label="登录"
                title="登录"
              >
                {pendingAction === "login" ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <LogIn className="size-4" />
                )}
              </Button>

              {(statusNeedsAttention(acc.status) || lastRun.lastRunOk === false) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={pendingAction !== null}
                  onClick={() => handleActionClick("forceLogin", () => actions.startLogin(id, true))}
                  aria-label="强制重登"
                  title="强制重登"
                >
                  {pendingAction === "forceLogin" ? (
                    <Loader2 className="size-4 animate-spin text-warn" />
                  ) : (
                    <KeyRound className="size-4 text-warn" />
                  )}
                </Button>
              )}

              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pendingAction !== null}
                onClick={() => handleActionClick("togglePage", () => actions.togglePage(id, acc.pageOpen))}
                aria-label={acc.pageOpen ? "关闭网页" : "打开网页"}
                title={acc.pageOpen ? "关闭网页" : "打开网页"}
              >
                {pendingAction === "togglePage" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : acc.pageOpen ? (
                  <MonitorX className="size-4 text-info" />
                ) : (
                  <AppWindow className="size-4" />
                )}
              </Button>
              
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pendingAction !== null}
                onClick={() => handleActionClick("runNow", () => actions.runNow(id))}
                aria-label="立即运行"
                title="立即运行"
              >
                {pendingAction === "runNow" ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <Play className="size-4" />
                )}
              </Button>
              
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pendingAction !== null}
                onClick={() => handleActionClick("refreshStatus", () => actions.refreshStatus(id))}
                aria-label="刷新状态"
                title="刷新状态"
              >
                {pendingAction === "refreshStatus" ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
              
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pendingAction !== null}
                onClick={() => handleActionClick("checkSelectors", () => actions.checkSelectors(id))}
                aria-label="检查选择器"
                title="检查选择器"
              >
                {pendingAction === "checkSelectors" ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <Scan className="size-4" />
                )}
              </Button>
            </div>
            
            <div className="flex gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => actions.openHistory(id)}
                aria-label="历史记录"
                title="历史记录"
              >
                <History className="size-4" />
              </Button>
              
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onDelete(id, acc.email || shortId(id))}
                className="text-danger hover:text-danger-content hover:bg-danger"
                aria-label="删除"
                title="删除"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </CardFooter>
        )}
      </div>
    </Card>
  );
});
