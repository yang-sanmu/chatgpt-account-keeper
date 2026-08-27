import * as React from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MinusSquare, PowerOff } from "lucide-react";

/// 关闭窗口的去向选择。
///
/// 这个弹窗不能缺席：Rust 侧对 CloseRequested 调了 prevent_close()，窗口关不关全看前端。
/// 它曾经因为嵌在会提前 return 的页面组件里而在首次启动页上不存在，结果点关闭毫无反应，
/// 用户只能去任务管理器结束进程。所以它挂在 GlobalOverlays 里，与页面同级。
export function CloseConfirmDialog() {
  const { open, dismiss, minimize, exit } = useKeeperStore(
    useShallow((state) => ({
      open: state.closeDialogOpen,
      dismiss: state.dismissCloseDialog,
      minimize: state.minimizeToTray,
      exit: state.exitEverything,
    }))
  );

  const [remember, setRemember] = React.useState(false);

  // 关掉后复位。不复位的话下次打开还带着上次勾的「记住」，用户一点「退出全部」就把
  // 默认行为改掉了，而他这次并没有想改。
  React.useEffect(() => {
    if (!open) setRemember(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>关闭窗口后要怎么做？</AlertDialogTitle>
          <AlertDialogDescription>
            隐藏到托盘时后台调度会继续运行；退出全部会先安全收尾正在跑的任务再结束进程。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <button
            type="button"
            onClick={() => void minimize(remember)}
            className="flex items-start gap-3 rounded-panel border border-subtle bg-panel p-3 text-left transition-colors hover:border-line hover:bg-hover"
          >
            <MinusSquare className="mt-0.5 size-4 shrink-0 text-accent" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-primary">隐藏到托盘</span>
              <span className="text-xs text-secondary">
                窗口收起，账号轮换和状态巡检照常进行。
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => void exit(remember)}
            className="flex items-start gap-3 rounded-panel border border-subtle bg-panel p-3 text-left transition-colors hover:border-danger hover:bg-hover"
          >
            <PowerOff className="mt-0.5 size-4 shrink-0 text-danger" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-primary">退出全部</span>
              <span className="text-xs text-secondary">
                停止调度、关闭所有 Chrome 窗口并结束后台服务。
              </span>
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="close-remember"
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          <Label htmlFor="close-remember" className="text-xs font-normal text-secondary">
            记住这次选择，以后不再询问（可在设置里改回）
          </Label>
        </div>

        <AlertDialogFooter>
          {/* 「继续使用」而不是「取消」：和旁边的「退出全部」放在一起时，「取消」指的是
              取消关闭还是取消退出并不明确。 */}
          <Button variant="ghost" onClick={dismiss}>
            继续使用
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
