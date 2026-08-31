import { useShallow } from "zustand/react/shallow";
import { useKeeperStore } from "@/store/keeperStore";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function SchedulerStartDialog() {
  const { open, starting, confirm, dismiss } = useKeeperStore(useShallow((state) => ({
    open: state.schedulerStartDialogOpen,
    starting: state.schedulerStarting,
    confirm: state.confirmSchedulerStart,
    dismiss: state.dismissSchedulerStartDialog,
  })));

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <AlertDialogContent aria-busy={starting}>
        <AlertDialogHeader>
          <AlertDialogTitle>启动调度，并在以后自动启动吗？</AlertDialogTitle>
          <AlertDialogDescription>
            仅本次启动不会修改设置。选择“以后自动启动”后，应用启动并连接后台服务时会自动开始调度；
            可在“设置 → 桌面偏好”中关闭“启动后自动开始调度”。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-0">
          <AlertDialogCancel disabled={starting}>取消</AlertDialogCancel>
          <Button variant="outline" disabled={starting} onClick={() => void confirm(false)}>
            仅本次启动
          </Button>
          <Button disabled={starting} onClick={() => void confirm(true)}>
            以后自动启动
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
