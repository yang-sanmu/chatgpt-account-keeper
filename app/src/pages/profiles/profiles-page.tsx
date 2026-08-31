import * as React from "react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { useProfileScanState } from "@/store/selectors";
import { useKeeperStore } from "@/store/keeperStore";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  HardDrive,
  Eraser,
  ArchiveRestore,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProfileActionDialog } from "./profile-action-dialog";
import { narrowCleanCacheResult as narrowCleanResult } from "./clean-result";
import type { ProfileInfo } from "@/ipc/types";

export function ProfilesPage() {
  const { scan, scanning, failed, request } = useProfileScanState();
  const runOperation = useKeeperStore((s) => s.runOperation);

  const [showOrphansOnly, setShowOrphansOnly] = React.useState(false);
  const [actionDialog, setActionDialog] = React.useState<{
    kind: "clean" | "archive" | "purge" | "clean-all" | "archive-all" | "purge-all";
    profile?: ProfileInfo;
  } | null>(null);
  
  // 批量操作进行中禁止重复提交：每一项都是真实的磁盘操作，重复提交会叠加。
  const [runningBulk, setRunningBulk] = React.useState(false);

  React.useEffect(() => {
    if (scan === null && !scanning && !failed) {
      void request();
    }
  }, [scan, scanning, failed, request]);

  if (failed) {
    return (
      <Page>
        <PageHeader title="Profile" description="管理浏览器用户数据与缓存" />
        <PageBody className="pb-20">
          <EmptyState
            icon={<AlertTriangle className="text-warn" />}
            title="扫描失败"
            description="扫描数据目录时发生错误，这里既不代表有也不代表没有 Profile。"
            action={
              <Button onClick={() => void request()} disabled={scanning}>
                {scanning && <Loader2 className="mr-2 size-4 animate-spin" />}
                重试扫描
              </Button>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const handleBulkAction = async (kind: "clean" | "archive" | "purge") => {
    setRunningBulk(true);
    let succeeded = 0;
    let failedCount = 0;
    let skipped = 0;

    try {
      if (kind === "clean") {
        const op = await runOperation("profiles.cleanCache", { scope: "all" });
        const outcome = narrowCleanResult(op.result);

        if (!outcome) {
          // 结果里没有可识别的字段，只能陈述「跑完了」。
          // 说成「已清理全部缓存」在结果实际是「全部跳过」时是错的，而用户会据此以为
          // 磁盘已经腾出来了。
          notify.info("清理任务已完成", "后台没有返回可核对的清理明细");
        } else if (outcome.profilesCleaned > 0) {
          const freed = formatBytes(outcome.freedBytes);
          notify.success(
            "清理完成",
            outcome.skipped.length > 0
              ? `清理 ${outcome.profilesCleaned} 个，释放 ${freed}；跳过占用中 ${outcome.skipped.length} 个`
              : `清理 ${outcome.profilesCleaned} 个，释放 ${freed}`
          );
        } else if (outcome.skipped.length > 0) {
          notify.warning(
            "未清理任何缓存",
            `${outcome.skipped.length} 个 Profile 正被 Chrome 或运行中的任务占用，已跳过`
          );
        } else {
          notify.info("没有可清理的缓存", "当前所有 Profile 都没有可回收的缓存文件");
        }
      } else {
        // 孤儿的批量归档 / 删除。
        if (!scan) return;
        const targets = scan.orphans.filter(p => !p.busy);
        skipped = scan.orphans.length - targets.length;

        let firstError: unknown = null;
        for (const target of targets) {
          try {
            if (kind === "archive") {
              await runOperation("profiles.archiveOrphan", { name: target.name });
            } else {
              await runOperation("profiles.purgeOrphan", { name: target.name });
            }
            succeeded++;
          } catch (error) {
            failedCount++;
            firstError ??= error;
          }
        }

        const action = kind === "archive" ? "归档" : "永久删除";
        const skippedTail = skipped > 0 ? `，跳过占用中 ${skipped} 个` : "";

        if (failedCount > 0) {
          // 部分失败必须报错并带上第一个稳定错误码：报成功会让用户以为清干净了。
          notify.error(
            `${action}部分失败`,
            firstError ?? `成功 ${succeeded} 个，失败 ${failedCount} 个${skippedTail}`
          );
        } else if (succeeded > 0) {
          notify.success(`${action}完成`, `共 ${succeeded} 个孤儿 Profile${skippedTail}`);
        } else if (skipped > 0) {
          notify.warning(
            `未执行${action}`,
            `${skipped} 个孤儿 Profile 正被占用，已全部跳过`
          );
        } else {
          notify.info("没有可处理的孤儿 Profile");
        }
      }
    } catch (e) {
      notify.error("操作失败", e);
    } finally {
      setRunningBulk(false);
      void request();
    }
  };

  const list = scan ? (showOrphansOnly ? scan.orphans : [...scan.profiles, ...scan.orphans]) : [];

  return (
    <Page>
      <PageHeader
        title="Profile"
        description="管理浏览器用户数据，清理缓存或删除不再关联的孤儿数据"
        actions={
          <Button variant="outline" size="sm" onClick={() => void request()} disabled={scanning} className="h-8 text-xs gap-1.5">
            <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} />
            扫描
          </Button>
        }
      />

      <PageBody className="pb-20 space-y-6">
        {/* Pure Metrics Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-xs font-medium text-muted mb-1">Profile 总数</div>
            <div className="metric text-primary">{scan?.totals.profiles ?? 0}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs font-medium text-muted mb-1">占用空间</div>
            <div className="metric tabular text-primary">
              {scan ? formatBytes(scan.totals.bytes) : "—"}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs font-medium text-muted mb-1">可清理缓存</div>
            <div className="metric tabular text-info">
              {scan ? formatBytes(scan.totals.cacheBytes) : "—"}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs font-medium text-muted mb-1">孤儿 Profile</div>
            <div className="metric tabular text-warn">
              {scan?.totals.orphans ?? 0}
            </div>
          </Card>
        </div>

        {/* Action Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-3 rounded-panel border border-subtle bg-panel">
          <div className="flex items-center gap-2">
            <Switch
              id="show-orphans"
              checked={showOrphansOnly}
              onCheckedChange={setShowOrphansOnly}
            />
            <Label htmlFor="show-orphans" className="text-xs text-secondary cursor-pointer">
              仅显示孤儿 Profile
            </Label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkAction("clean")}
              disabled={runningBulk || !scan || scan.totals.cacheBytes === 0}
              className="h-8 text-xs gap-1.5"
            >
              {runningBulk ? <Loader2 className="size-3.5 animate-spin" /> : <Eraser className="size-3.5" />}
              清理全部缓存
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActionDialog({ kind: "archive-all" })}
              disabled={runningBulk || !scan || scan.totals.orphans === 0}
              className="h-8 text-xs gap-1.5"
            >
              <ArchiveRestore className="size-3.5" />
              归档全部孤儿
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5 text-danger hover:text-danger-content hover:bg-danger"
              onClick={() => setActionDialog({ kind: "purge-all" })}
              disabled={runningBulk || !scan || scan.totals.orphans === 0}
            >
              <Trash2 className="size-3.5" />
              彻底删除全部孤儿
            </Button>
          </div>
        </div>

        {!scan && !scanning ? (
          <EmptyState icon={<HardDrive />} title="就绪" description="点击右上角扫描加载数据" />
        ) : scanning && !scan ? (
          <div className="flex items-center justify-center py-20 text-muted">
            <Loader2 className="size-8 animate-spin" />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<HardDrive />}
            title="暂无 Profile"
            description={showOrphansOnly ? "没有找到孤儿数据" : "数据目录为空"}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4 items-start">
            {list.map((p) => (
              <Card key={p.name} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base truncate flex-1" title={p.name}>
                      {p.name}
                    </CardTitle>
                    {!p.linked && <Badge variant="outline" className="text-warn border-warn text-2xs">孤儿</Badge>}
                    {p.busy && <Badge variant="neutral" className="text-2xs">使用中</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 pb-3 text-xs">
                  {p.linked ? (
                    <div className="text-secondary truncate" title={p.accountLabels.join(", ")}>
                      关联: {p.accountLabels.join(", ")}
                    </div>
                  ) : (
                    <div className="text-muted">无关联账号</div>
                  )}
                  <div className="flex justify-between items-center text-muted">
                    <span>体积: <span className="text-primary tabular">{formatBytes(p.bytes)}</span></span>
                    <span>缓存: <span className="text-primary tabular">{formatBytes(p.cacheBytes)}</span></span>
                  </div>
                </CardContent>
                <CardFooter className="p-2 border-t border-subtle bg-sunken/50 justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-block">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setActionDialog({ kind: "clean", profile: p })}
                          disabled={p.busy || runningBulk}
                          aria-label="清理缓存"
                        >
                          <Eraser className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>清理缓存</TooltipContent>
                  </Tooltip>
                  
                  {!p.linked && (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-block">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setActionDialog({ kind: "archive", profile: p })}
                              disabled={p.busy || runningBulk}
                              aria-label="归档"
                            >
                              <ArchiveRestore className="size-4" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>归档</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-block">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-danger hover:text-danger-content hover:bg-danger"
                              onClick={() => setActionDialog({ kind: "purge", profile: p })}
                              disabled={p.busy || runningBulk}
                              aria-label="彻底删除"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>彻底删除</TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </PageBody>

      <ProfileActionDialog
        state={actionDialog}
        onClose={() => setActionDialog(null)}
        onBulkAction={handleBulkAction}
      />
    </Page>
  );
}
