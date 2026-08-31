import { useKeeperStore } from "@/store/keeperStore";
import { useShallow } from "zustand/react/shallow";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/format";

/// 退出各阶段的说明。让用户知道等的是什么，而不是只看到一个转圈。
const STAGE_LABELS: Record<string, string> = {
  connecting: "连接后台服务",
  draining: "收尾正在运行的任务",
  waiting: "等待 Chrome 与数据库释放句柄",
  forcing: "强制回收进程树",
  done: "已完成",
};

export function ExitProgressDialog() {
  const { progress, forceExit } = useKeeperStore(
    useShallow((state) => ({
      progress: state.exitProgress,
      forceExit: state.forceExit,
    }))
  );

  const done = progress?.stage === "done";
  const stageLabel = progress ? (STAGE_LABELS[progress.stage] ?? progress.stage) : "";

  return (
    <AlertDialog open={progress !== null}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {done ? (
              <CheckCircle2 className="size-4 text-ok" />
            ) : (
              <Loader2 className="size-4 animate-spin text-accent" />
            )}
            {done ? "已安全退出" : "正在退出"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            正在让后台服务完成任务收尾与数据库检查点。等它自己走完最安全。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <div className="flex items-center gap-2 text-base">
            <span className="flex-1 text-primary">
              {progress?.message ?? stageLabel}
            </span>
            {progress !== null && progress.elapsedSeconds > 0 && (
              <span className="tabular text-xs text-muted">
                已等待 {formatDuration(progress.elapsedSeconds)}
              </span>
            )}
          </div>
          {!done && (
            <p className="text-xs text-muted">
              阶段：{stageLabel}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          {/* canForce 在开头几秒刻意是 false：那时候强制结束会跳过数据库检查点，
              这个按钮不该在用户还没等够的时候就可点。 */}
          {progress?.canForce ? (
            <Button variant="danger" onClick={forceExit}>
              不再等待，强制结束
            </Button>
          ) : (
            !done && (
              <span className="text-xs text-muted">
                收尾期间无法强制结束，以免留下损坏的数据库
              </span>
            )
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
