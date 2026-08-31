import * as React from "react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import {
  useConnectionStatus,
  useSchedulerControls,
  useAccountLabeler,
} from "@/store/selectors";
import { describeBrowserPurpose } from "@/lib/operation-labels";
import {
  HEALTH_LABELS,
  healthBucketOf,
  type HealthBucket,
} from "@/pages/accounts/account-status";
import { resolveOperationSubject } from "@/lib/operation-subject";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { RelativeTime } from "@/components/ui/relative-time";
import { shortId } from "@/lib/format";
import { agentCall } from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  Server,
  Terminal,
  HardDrive,
  Clock,
  Globe,
  Copy,
  RefreshCw,
  Play,
  Square,
} from "lucide-react";

function localizeBrowserRunState(state: string): string {
  const map: Record<string, string> = {
    waiting: "等待中",
    launching: "启动中",
    running: "运行中",
    closing: "关闭中",
    closed: "已关闭",
    close_failed: "关闭失败",
  };
  return map[state] ?? state;
}

export function OverviewPage() {
  const { connection, agentVersion, instanceId } = useConnectionStatus();
  const startupInfo = useKeeperStore((s) => s.startupInfo);

  const { scheduler, running, start, stop } = useSchedulerControls();
  const queue = useKeeperStore((s) => s.queue);
  const browserRuns = useKeeperStore((s) => s.browserRuns);
  const operations = useKeeperStore((s) => s.operations).slice(0, 6);
  const proxyNodes = useKeeperStore((s) => s.proxies.nodes);
  const accounts = useKeeperStore((s) => s.accounts);
  const accountLabeler = useAccountLabeler();

  const refreshQueue = useKeeperStore((s) => s.refreshQueue);
  const refreshBrowserRuns = useKeeperStore((s) => s.refreshBrowserRuns);

  React.useEffect(() => {
    void refreshQueue();
    void refreshBrowserRuns();
  }, [refreshQueue, refreshBrowserRuns]);

  const managedAccountCount = Object.keys(scheduler.accounts).length;

  const accountList = React.useMemo(() => Object.values(accounts), [accounts]);
  const totalAccounts = accountList.length;

  /// 健康度分布。
  ///
  /// 用共享的 healthBucketOf 而不是在这里重写一套 status 判断：之前这里比对的是
  /// `needs_login` / `waf`，而 Agent 发的是 `reauth` / `out`，于是真正掉线的账号全被
  /// 计进「其它」，这块统计长期显示 0。
  const health = React.useMemo(() => {
    const counts: Record<HealthBucket, number> = {
      ok: 0,
      reauth: 0,
      out: 0,
      unknown: 0,
      disabled: 0,
    };
    for (const record of accountList) {
      counts[healthBucketOf(record.effective)] += 1;
    }
    return counts;
  }, [accountList]);

  const workUsed = queue?.workSlots.used ?? 0;
  const workLimit = queue?.workSlots.limit ?? 0;
  const chromeUsed = queue?.chromeSlots.used ?? 0;
  const chromeLimit = queue?.chromeSlots.limit ?? 0;
  const queuedCount = queue?.queuedTotal ?? 0;
  const runningTaskCount = queue?.running ?? 0;
  const closingCount = queue?.closing ?? 0;

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    notify.success("已复制", label);
  };

  const handleCloseRun = async (browserRunId: string) => {
    try {
      await agentCall("browserRuns.close", { browserRunId });
      void refreshBrowserRuns();
    } catch (e) {
      notify.error("关闭失败", e);
    }
  };

  return (
    <Page>
      <PageHeader
        title="总览"
        description="系统状态、队列运行情况与最近活动概览"
      />
      <PageBody className="pb-10 space-y-6">
        {/* Connection + Scheduler Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-3.5 rounded-panel border border-subtle bg-panel">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <Server className="size-4 text-muted" />
              <span className="text-secondary">后台服务:</span>
              <Badge variant={connection.connected ? "ok" : "warn"} className="text-2xs">
                {connection.connected ? "已连接" : "未连接"}
              </Badge>
            </div>
            {agentVersion && (
              <div className="text-muted tabular">
                版本 <span className="text-primary font-mono">{agentVersion}</span>
              </div>
            )}
            {instanceId && (
              <div className="text-muted tabular font-mono">
                实例 <span className="text-primary">{shortId(instanceId)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs">
              <Clock className="size-4 text-muted" />
              <span className="text-secondary">调度器:</span>
              <StatusDot
                status={running ? "ok" : "disabled"}
                label={running ? "运行中" : "已停止"}
              />
              <span className="text-muted tabular">({managedAccountCount} 托管)</span>
            </div>
            <Button
              variant={running ? "outline" : "default"}
              size="sm"
              onClick={() => (running ? stop() : start())}
              className="h-7 text-xs gap-1.5"
            >
              {running ? (
                <>
                  <Square className="size-3" /> 停止调度
                </>
              ) : (
                <>
                  <Play className="size-3" /> 启动调度
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Top Metric Row: Dashboard Numbers */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Metric 1: Account Health */}
          <Card className="p-4 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-muted mb-1">账号健康度</div>
              <div className="flex items-baseline gap-2">
                <span className="metric-lg text-primary">{totalAccounts}</span>
                <span className="text-xs text-muted">总账号</span>
              </div>
            </div>
            {/* 只列非零档位。全绿的时候不该有一排「0 需重登 / 0 未登录」占着视觉带宽。 */}
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-subtle pt-2 text-2xs">
              <span className="font-medium text-ok">
                {health.ok} {HEALTH_LABELS.ok}
              </span>
              {health.reauth > 0 && (
                <span className="font-medium text-warn">
                  {health.reauth} {HEALTH_LABELS.reauth}
                </span>
              )}
              {health.out > 0 && (
                <span className="font-medium text-danger">
                  {health.out} {HEALTH_LABELS.out}
                </span>
              )}
              {health.unknown > 0 && (
                <span className="text-secondary">
                  {health.unknown} {HEALTH_LABELS.unknown}
                </span>
              )}
              {health.disabled > 0 && (
                <span className="text-muted">
                  {health.disabled} {HEALTH_LABELS.disabled}
                </span>
              )}
            </div>
          </Card>

          {/* Metric 2: Work Slots */}
          <Card className="p-4 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-muted mb-1">工作并发槽</div>
              <div className="flex items-baseline gap-2">
                <span className="metric-lg text-primary">{workUsed}</span>
                <span className="text-xs text-muted">/ {workLimit} 槽位</span>
              </div>
            </div>
            <div className="mt-3 space-y-1 pt-2 border-t border-subtle">
              <Progress
                value={workLimit > 0 ? (workUsed / workLimit) * 100 : 0}
                className="h-1.5"
              />
              <div className="flex justify-between text-2xs text-muted">
                <span>利用率 {workLimit > 0 ? Math.round((workUsed / workLimit) * 100) : 0}%</span>
                <span>空闲 {Math.max(0, workLimit - workUsed)}</span>
              </div>
            </div>
          </Card>

          {/* Metric 3: Chrome Slots */}
          <Card className="p-4 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-muted mb-1">Chrome 实例槽</div>
              <div className="flex items-baseline gap-2">
                <span className="metric-lg text-primary">{chromeUsed}</span>
                <span className="text-xs text-muted">/ {chromeLimit} 实例</span>
              </div>
            </div>
            <div className="mt-3 space-y-1 pt-2 border-t border-subtle">
              <Progress
                value={chromeLimit > 0 ? (chromeUsed / chromeLimit) * 100 : 0}
                className="h-1.5"
              />
              <div className="flex justify-between text-2xs text-muted">
                <span>占用 {chromeUsed} 实例</span>
                <span>剩余 {Math.max(0, chromeLimit - chromeUsed)}</span>
              </div>
            </div>
          </Card>

          {/* Metric 4: Queue Depth */}
          <Card className="p-4 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-muted mb-1">任务队列概况</div>
              <div className="flex items-baseline gap-2">
                <span className="metric-lg text-primary">{runningTaskCount}</span>
                <span className="text-xs text-muted">运行中</span>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-2xs pt-2 border-t border-subtle">
              <span className="text-secondary">等待中: <span className="tabular font-medium text-primary">{queuedCount}</span></span>
              <span className="text-muted">收尾中: <span className="tabular font-medium text-primary">{closingCount}</span></span>
            </div>
          </Card>
        </div>

        {/* Chrome Runs & Recent Tasks: Side by Side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Chrome Runs */}
          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Globe className="size-4 text-muted" />
                运行中的浏览器 ({browserRuns?.active.length ?? 0})
              </CardTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => refreshBrowserRuns()}
                aria-label="刷新浏览器实例"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </CardHeader>
            <CardContent className="flex-1">
              {browserRuns && browserRuns.active.length > 0 ? (
                <div className="divide-y divide-subtle border border-subtle rounded-panel overflow-hidden">
                  {browserRuns.active.map((run) => {
                    const { label, known } = accountLabeler(run.accountId);
                    const isDeleted = !known && run.accountId;
                    const accountDisplay = isDeleted ? `已删除账号 (${label})` : label;
                    const purposeLabel = describeBrowserPurpose(run.purpose);
                    const stateLabel = localizeBrowserRunState(run.state);

                    return (
                      <div key={run.browserRunId} className="p-3 flex items-center justify-between text-xs gap-3">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <span className="font-mono text-2xs text-muted w-14 shrink-0" title={run.browserRunId}>
                            {shortId(run.browserRunId)}
                          </span>
                          <span
                            className={cn(
                              "font-medium truncate max-w-[130px]",
                              isDeleted ? "text-muted" : "text-primary"
                            )}
                            title={accountDisplay}
                          >
                            {accountDisplay}
                          </span>
                          <Badge variant="outline" className="shrink-0 text-2xs">
                            {purposeLabel}
                          </Badge>
                          <span className="text-muted tabular shrink-0 text-2xs">
                            {run.rootPid ? `PID ${run.rootPid}` : "—"}
                          </span>
                          <RelativeTime
                            value={run.startedAt}
                            className="text-muted shrink-0 text-2xs"
                          />
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {run.state === "close_failed" ? (
                            <>
                              <Badge variant="danger" className="text-2xs">关闭失败</Badge>
                              <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => handleCloseRun(run.browserRunId)}>
                                重试关闭
                              </Button>
                            </>
                          ) : (
                            <Badge variant={run.state === "running" ? "accent" : "neutral"} className="text-2xs">
                              {stateLabel}
                            </Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted text-center py-8 bg-sunken rounded-panel">
                  当前没有运行中的浏览器实例
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Tasks */}
          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Terminal className="size-4 text-muted" />
                最近任务记录
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
              {operations.length > 0 ? (
                <div className="divide-y divide-subtle border border-subtle rounded-panel overflow-hidden">
                  {operations.map((op) => {
                    const {
                      title: resourceTitle,
                      action,
                      deletedAccount: isDeletedAccount,
                    } = resolveOperationSubject(op, { account: accountLabeler, nodes: proxyNodes });

                    const badgeVariant =
                      op.state === "succeeded"
                        ? "ok"
                        : op.state === "failed" || op.state === "timed_out"
                        ? "danger"
                        : op.state === "cancelled"
                        ? "neutral"
                        : "accent";

                    const stateLabel =
                      op.state === "succeeded"
                        ? "成功"
                        : op.state === "failed"
                        ? "失败"
                        : op.state === "timed_out"
                        ? "超时"
                        : op.state === "cancelled"
                        ? "已取消"
                        : op.state === "running"
                        ? "运行中"
                        : op.state === "queued"
                        ? "排队中"
                        : op.state === "waiting_user"
                        ? "需介入"
                        : op.state;

                    return (
                      <div key={op.id} className="p-3 flex items-center gap-2.5 text-xs">
                        <Badge variant={badgeVariant} className="w-14 justify-center shrink-0 text-2xs">
                          {stateLabel}
                        </Badge>
                        <span
                          className={cn(
                            "font-medium truncate max-w-[120px]",
                            isDeletedAccount ? "text-muted" : "text-primary"
                          )}
                          title={resourceTitle}
                        >
                          {resourceTitle}
                        </span>
                        <span className="text-secondary truncate flex-1">
                          {action} {op.stage ? `· ${op.stage}` : ""}
                        </span>
                        <RelativeTime
                          value={op.startedAt}
                          className="text-muted shrink-0 text-2xs"
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted text-center py-8 bg-sunken rounded-panel">
                  暂无近期任务记录
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quiet Reference Block: Data Directory & Log File */}
        <div className="rounded-panel border border-subtle bg-sunken/60 p-3 text-xs text-muted">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <HardDrive className="size-3.5 text-muted shrink-0" />
              <span className="text-secondary shrink-0">数据根目录:</span>
              <span className="font-mono text-muted truncate text-2xs" title={startupInfo?.dataDirectory ?? "—"}>
                {startupInfo?.dataDirectory ?? "—"}
              </span>
              {startupInfo?.dataDirectory && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-5 w-5 text-muted hover:text-primary shrink-0"
                  onClick={() => handleCopy(startupInfo.dataDirectory!, "数据根目录")}
                  title="复制路径"
                >
                  <Copy className="size-3" />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-secondary shrink-0">后台日志:</span>
              <span className="font-mono text-muted truncate text-2xs" title={startupInfo?.agentLogFile ?? "—"}>
                {startupInfo?.agentLogFile ?? "—"}
              </span>
              {startupInfo?.agentLogFile && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-5 w-5 text-muted hover:text-primary shrink-0"
                  onClick={() => handleCopy(startupInfo.agentLogFile!, "后台日志路径")}
                  title="复制路径"
                >
                  <Copy className="size-3" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
