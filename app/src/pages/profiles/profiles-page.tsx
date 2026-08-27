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
      <Page className="p-6">
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
    <Page className="p-6">
      <PageHeader
        title="Profile"
        description="管理浏览器用户数据，清理缓存或删除不再关联的孤儿数据"
      >
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void request()} disabled={scanning}>
            <RefreshCw className={`mr-2 size-4 ${scanning ? "animate-spin" : ""}`} />
            扫描
          </Button>
        </div>
      </PageHeader>

      <PageBody className="pb-20 space-y-6">
        {/* Totals Header */}
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted">总数</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{scan?.totals.profiles || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted">占用空间</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular">
                {scan ? formatBytes(scan.totals.bytes) : "—"}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted">可清理缓存</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <div className="text-2xl font-bold tabular text-info">
                {scan ? formatBytes(scan.totals.cacheBytes) : "—"}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkAction("clean")}
                disabled={runningBulk || !scan || scan.totals.cacheBytes === 0}
              >
                清理全部缓存
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted">孤儿数据</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <div className="text-2xl font-bold text-warn">
                {scan?.totals.orphans || 0}
              </div>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  title="归档全部孤儿"
                  onClick={() => setActionDialog({ kind: "archive-all" })}
                  disabled={runningBulk || !scan || scan.totals.orphans === 0}
                >
                  <ArchiveRestore className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-danger hover:text-danger-content hover:bg-danger"
                  title="彻底删除全部孤儿"
                  onClick={() => setActionDialog({ kind: "purge-all" })}
                  disabled={runningBulk || !scan || scan.totals.orphans === 0}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Switch
              id="show-orphans"
              checked={showOrphansOnly}
              onCheckedChange={setShowOrphansOnly}
            />
            <Label htmlFor="show-orphans">仅显示孤儿 Profile</Label>
          </div>
        </div>

        {!scan && !scanning ? (
          <EmptyState icon={<HardDrive />} title="就绪" description="点击扫描加载数据" />
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
                    {!p.linked && <Badge variant="outline" className="text-warn border-warn">孤儿</Badge>}
                    {p.busy && <Badge variant="neutral">使用中</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 pb-3 text-sm">
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
                      {/* We must wrap in span if button is disabled to make Tooltip trigger work on hover */}
                      <span className="inline-block">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setActionDialog({ kind: "clean", profile: p })}
                          disabled={p.busy || runningBulk}
                        >
                          <Eraser className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{p.busy ? "使用中无法操作" : "清理缓存"}</TooltipContent>
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
                            >
                              <ArchiveRestore className="size-4" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{p.busy ? "使用中无法操作" : "归档"}</TooltipContent>
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
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{p.busy ? "使用中无法操作" : "彻底删除"}</TooltipContent>
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
