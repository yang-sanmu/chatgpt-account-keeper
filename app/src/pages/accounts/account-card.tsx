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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { useAccountRecord, useAccountActions } from "@/store/selectors";
import { useKeeperStore } from "@/store/keeperStore";
import { displayEmail, formatRelative, formatDateTime, shortId } from "@/lib/format";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { SwitchRule } from "@/ipc/types";
import type { AccountDraft } from "@/store/accountModel";
import { describeAccountStatus } from "./account-status";

interface AccountCardProps {
  id: string;
  onDelete: (id: string, email: string) => void;
}

export const AccountCard = React.memo(({ id, onDelete }: AccountCardProps) => {
  const record = useAccountRecord(id);
  const actions = useAccountActions();
  const selected = useKeeperStore((s) => s.selectedAccountIds.has(id));
  const toggle = useKeeperStore((s) => s.toggleAccountSelected);
  const emailsRevealed = useKeeperStore((s) => s.emailsRevealed);
  const groups = useKeeperStore((s) => s.groups);
  const [expanded, setExpanded] = React.useState(false);

  if (!record) return null;

  const acc = record.effective;
  const dirty = record.dirtyFields.size > 0;
  const inFlight = record.inFlight !== null;

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
  });

  return (
    <Card className={cn(
      "flex flex-col transition-colors",
      dirty && "border-accent ring-1 ring-accent"
    )}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <Checkbox 
            checked={selected} 
            onCheckedChange={() => toggle(id)} 
            aria-label="选择账号"
          />
          <div className="flex-1 min-w-0">
            <CardTitle className="truncate text-base" title={acc.email || "未登录"}>
              {displayEmail(acc.email, emailsRevealed)}
            </CardTitle>
          </div>
          {acc.gptName && <Badge variant="outline">{acc.gptName}</Badge>}
        </div>
        <div className="flex items-center justify-between mt-2">
          <StatusDot status={status.dot} label={status.label} />
          <span 
            className="text-xs text-muted tabular" 
            title={formatDateTime(acc.statusCheckedAt)}
          >
            {formatRelative(acc.statusCheckedAt)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pb-3">
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

        {/* 下次运行 */}
        <div className="flex flex-col gap-1 rounded-sm bg-sunken p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">下次运行</span>
            <span className="text-xs text-primary tabular" title={formatDateTime(acc.nextRunAt)}>
              {formatRelative(acc.nextRunAt)}
            </span>
          </div>
          {acc.lastRunOk === false && acc.lastRunReason && (
            <div className="text-xs text-danger mt-1 bg-danger-soft p-1 rounded-sm">
              失败: {acc.lastRunReason}
            </div>
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
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full h-7 text-xs text-muted mt-1 gap-1">
              {expanded ? "收起详细配置" : "展开详细配置"}
              <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
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
          <div className="flex items-center justify-end gap-2 p-3 bg-accent-soft border-t border-accent/20 rounded-b-panel">
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => actions.startLogin(id, false)} aria-label="登录">
                    <LogIn className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>登录</TooltipContent>
              </Tooltip>

              {(acc.status === "needs_login" || acc.status === "waf" || acc.lastRunOk === false) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => actions.startLogin(id, true)} aria-label="强制重登">
                      <KeyRound className="size-4 text-warn" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>强制重登</TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => actions.togglePage(id, acc.pageOpen)} aria-label={acc.pageOpen ? "关闭网页" : "打开网页"}>
                    {acc.pageOpen ? <MonitorX className="size-4 text-info" /> : <AppWindow className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{acc.pageOpen ? "关闭网页" : "打开网页"}</TooltipContent>
              </Tooltip>
              
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => actions.runNow(id)} aria-label="立即运行">
                    <Play className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>立即运行</TooltipContent>
              </Tooltip>
              
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => actions.refreshStatus(id)} aria-label="刷新状态">
                    <RefreshCw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>刷新状态</TooltipContent>
              </Tooltip>
              
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => actions.checkSelectors(id)} aria-label="检查选择器">
                    <Scan className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>检查选择器</TooltipContent>
              </Tooltip>
            </div>
            
            <div className="flex gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => actions.openHistory(id)} aria-label="历史记录">
                    <History className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>历史记录</TooltipContent>
              </Tooltip>
              
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onDelete(id, acc.email || shortId(id))} className="text-danger hover:text-danger-content hover:bg-danger" aria-label="删除">
                    <Trash2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>删除</TooltipContent>
              </Tooltip>
            </div>
          </CardFooter>
        )}
      </div>
    </Card>
  );
});
