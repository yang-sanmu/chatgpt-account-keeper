import { useEffect } from "react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import { useConnectionStatus, useSchedulerControls } from "@/store/selectors";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { shortId, formatRelative } from "@/lib/format";
import { agentCall } from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import {
  Server,
  Terminal,
  HardDrive,
  Clock,
  Globe,
  Layers,
  Copy,
  RefreshCw,
  Play,
  Square
} from "lucide-react";

export function OverviewPage() {
  const { connection, agentVersion, instanceId } = useConnectionStatus();
  const startupInfo = useKeeperStore((s) => s.startupInfo);
  
  const { scheduler, running, start, stop } = useSchedulerControls();
  const queue = useKeeperStore((s) => s.queue);
  const browserRuns = useKeeperStore((s) => s.browserRuns);
  const operations = useKeeperStore((s) => s.operations).slice(0, 5);
  
  const refreshQueue = useKeeperStore((s) => s.refreshQueue);
  const refreshBrowserRuns = useKeeperStore((s) => s.refreshBrowserRuns);

  useEffect(() => {
    void refreshQueue();
    void refreshBrowserRuns();
  }, [refreshQueue, refreshBrowserRuns]);

  const managedAccountCount = Object.keys(scheduler.accounts).length;
  const activeLongTaskCount = Object.values(scheduler.accounts).filter((a) => a.busy).length;

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
    <Page className="p-6">
      <PageHeader
        title="总览"
        description="系统状态、队列运行情况与最近活动概览"
      />
      <PageBody className="pb-10 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Connection & Agent Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Server className="size-4" />
                后台服务
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">状态</span>
                <Badge variant={connection.connected ? "ok" : "warn"}>
                  {connection.connected ? "已连接" : "未连接"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">版本</span>
                <span className="text-sm tabular">{agentVersion ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">实例 ID</span>
                <span className="text-sm tabular font-mono">{instanceId ? shortId(instanceId) : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">端点</span>
                <span className="text-sm tabular font-mono">{startupInfo?.endpoint ?? "—"}</span>
              </div>
            </CardContent>
          </Card>

          {/* Scheduler Card */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2">
                <Clock className="size-4" />
                调度器
              </CardTitle>
              <Button
                variant={running ? "danger" : "default"}
                size="sm"
                onClick={() => (running ? stop() : start())}
              >
                {running ? <Square className="size-3" /> : <Play className="size-3" />}
                {running ? "停止" : "启动"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">状态</span>
                <StatusDot status={running ? "ok" : "disabled"} label={running ? "运行中" : "已停止"} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">托管账号</span>
                <span className="text-sm tabular">{managedAccountCount} 个</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary">长时任务</span>
                <span className="text-sm tabular">{activeLongTaskCount} 个</span>
              </div>
            </CardContent>
          </Card>

          {/* Queue & Concurrency Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="size-4" />
                队列与并发
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {queue ? (
                <>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-secondary">工作槽</span>
                      <span className="tabular">{queue.workSlots.used} / {queue.workSlots.limit}</span>
                    </div>
                    <Progress value={(queue.workSlots.used / queue.workSlots.limit) * 100 || 0} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-secondary">Chrome 槽</span>
                      <span className="tabular">{queue.chromeSlots.used} / {queue.chromeSlots.limit}</span>
                    </div>
                    <Progress value={(queue.chromeSlots.used / queue.chromeSlots.limit) * 100 || 0} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-2 text-center">
                    <div className="bg-sunken rounded p-2">
                      <div className="text-xs text-secondary">等待中</div>
                      <div className="text-lg font-semibold tabular">{queue.queuedTotal}</div>
                    </div>
                    <div className="bg-sunken rounded p-2">
                      <div className="text-xs text-secondary">运行中</div>
                      <div className="text-lg font-semibold tabular">{queue.running}</div>
                    </div>
                    <div className="bg-sunken rounded p-2">
                      <div className="text-xs text-secondary">收尾中</div>
                      <div className="text-lg font-semibold tabular">{queue.closing}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted">暂无队列数据</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Data Directories Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4" />
              数据目录
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex-1 overflow-hidden">
                <div className="text-sm text-secondary mb-1">数据根目录</div>
                <div className="text-sm font-mono truncate bg-sunken p-2 rounded border border-subtle">
                  {startupInfo?.dataDirectory ?? "—"}
                </div>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => handleCopy(startupInfo?.dataDirectory ?? "", "数据根目录")}
                disabled={!startupInfo?.dataDirectory}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex-1 overflow-hidden">
                <div className="text-sm text-secondary mb-1">后台日志</div>
                <div className="text-sm font-mono truncate bg-sunken p-2 rounded border border-subtle">
                  {startupInfo?.agentLogFile ?? "—"}
                </div>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => handleCopy(startupInfo?.agentLogFile ?? "", "后台日志路径")}
                disabled={!startupInfo?.agentLogFile}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Chrome Runs */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" />
              浏览器实例
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={() => refreshBrowserRuns()}>
              <RefreshCw className="size-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {browserRuns && browserRuns.active.length > 0 ? (
              <div className="divide-y divide-subtle border border-subtle rounded-panel">
                {browserRuns.active.map((run) => (
                  <div key={run.browserRunId} className="p-3 flex items-center justify-between text-sm">
                    <div className="flex items-center gap-4">
                      <span className="font-mono text-secondary w-16">{shortId(run.browserRunId)}</span>
                      <span className="font-mono text-primary w-20">{shortId(run.accountId)}</span>
                      <Badge variant="outline">{run.purpose}</Badge>
                      <span className="text-secondary tabular w-16 text-right">
                        {run.rootPid ? `PID ${run.rootPid}` : "—"}
                      </span>
                      <span className="text-muted w-24">{formatRelative(run.startedAt)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {run.state === "close_failed" ? (
                        <>
                          <Badge variant="danger">关闭失败</Badge>
                          <Button size="sm" variant="outline" onClick={() => handleCloseRun(run.browserRunId)}>
                            重试关闭
                          </Button>
                        </>
                      ) : (
                        <Badge variant="accent">{run.state}</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted text-center py-4 bg-sunken rounded-panel">
                当前没有运行中的浏览器实例
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="size-4" />
              最近任务
            </CardTitle>
          </CardHeader>
          <CardContent>
            {operations.length > 0 ? (
              <div className="divide-y divide-subtle border border-subtle rounded-panel">
                {operations.map((op) => (
                  <div key={op.id} className="p-3 flex items-center gap-4 text-sm">
                    <Badge
                      variant={
                        op.state === "succeeded"
                          ? "ok"
                          : op.state === "failed" || op.state === "timed_out"
                          ? "danger"
                          : op.state === "cancelled"
                          ? "neutral"
                          : "accent"
                      }
                      className="w-20 justify-center"
                    >
                      {op.state}
                    </Badge>
                    <span className="font-mono text-secondary w-20">{shortId(op.resourceId)}</span>
                    <span className="font-medium flex-1 truncate">{op.kind} {op.stage ? `- ${op.stage}` : ""}</span>
                    <span className="text-muted tabular">{formatRelative(op.startedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted text-center py-4 bg-sunken rounded-panel">
                暂无近期任务记录
              </div>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </Page>
  );
}
