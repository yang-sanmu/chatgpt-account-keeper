import { useKeeperStore } from "@/store/keeperStore";
import { useShallow } from "zustand/react/shallow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

/// 安装阶段的中文名。
///
/// 后端发的是 camelCase 枚举（见 src-tauri/src/update.rs 的 InstallStage），直接显示英文
/// 会让用户在一个不可取消的等待里看不懂当前在做什么。
const STAGE_LABELS: Record<string, string> = {
  preflight: "检查安装条件",
  downloading: "下载更新包",
  draining: "安全排空后台服务",
  stoppingAgent: "等待释放数据库句柄",
  installing: "安装并重启",
};

export function UpdateDialog() {
  const { dialog, install, dismiss } = useKeeperStore(
    useShallow((state) => ({
      dialog: state.updateDialog,
      install: state.installPendingUpdate,
      dismiss: state.dismissUpdateDialog,
    }))
  );

  const { open, status, installing } = dialog;

  // 手动检查无论结果如何都会弹这个窗（否则用户点了「检查更新」界面上什么都不发生），
  // 所以这里必须按 state 分支。后端的取值见 commands.rs 的 check_update：
  // available / current / error / unsupported / installing。
  const state = status?.state ?? "current";
  const isAvailable = state === "available";
  const isError = state === "error";
  const isUnsupported = state === "unsupported";
  const isCurrent = state === "current";

  const title = installing
    ? "正在安装更新"
    : isAvailable
      ? `发现新版本${status?.version ? ` v${status.version}` : ""}`
      : isCurrent
        ? "已是最新版本"
        : isError
          ? "更新检查失败"
          : isUnsupported
            ? "此安装方式不支持应用内更新"
            : "更新";

  const description = installing
    ? "请勿关闭程序。排空开始后本次安装无法中断。"
    : isAvailable
      ? "安装会先排空后台任务再重启，期间正在运行的对话会被安全收尾。"
      : (status?.message ?? "");

  const percent = status?.percent;
  const hasPercent = typeof percent === "number";
  const stageLabel = status?.stage
    ? (STAGE_LABELS[status.stage] ?? status.stage)
    : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !installing && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isCurrent && !installing && <CheckCircle2 className="size-4 text-ok" />}
            {(isError || isUnsupported) && !installing && (
              <TriangleAlert className="size-4 text-warn" />
            )}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* 更新说明。只在真有新版本时显示。 */}
          {!installing && isAvailable && status?.notes && (
            <div className="rounded-panel border border-subtle bg-sunken p-3">
              <ScrollArea className="max-h-[160px]">
                <pre className="font-sans text-xs whitespace-pre-wrap text-secondary">
                  {status.notes}
                </pre>
              </ScrollArea>
            </div>
          )}

          {installing && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-base text-primary">
                <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
                <span className="flex-1">{stageLabel ?? status?.message ?? "处理中"}</span>
                {hasPercent && (
                  <span className="tabular text-xs text-muted">{percent}%</span>
                )}
              </div>
              {/* percent 是 0-100 的整数（后端 report 直接传百分比），不要再乘 100。 */}
              {hasPercent && <Progress value={percent} />}
              {/* 不可取消的阶段要提前说明，否则用户会一直找取消按钮。 */}
              {status?.canCancel === false && (
                <p className="text-xs text-muted">
                  此阶段无法取消：后台服务已进入拒绝写入状态，必须走完才能恢复。
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {installing ? (
            <Button variant="outline" disabled>
              正在安装…
            </Button>
          ) : isAvailable ? (
            <>
              <Button variant="outline" onClick={dismiss}>
                稍后提醒
              </Button>
              <Button onClick={() => void install()}>立即安装并重启</Button>
            </>
          ) : (
            <Button variant="outline" onClick={dismiss}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
