import * as React from "react";
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
import { Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface AccountDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: { id: string; name: string }[];
}

interface AccountChoice {
  value: "disable" | "purge";
  title: string;
  detail: string;
  danger?: boolean;
  recommended?: boolean;
}

/// 账号生命周期只有两个用户语义：暂时不用就停用，确认不要了才永久删除。
///
/// 归档仍保留给 Profile 页处理真正的孤儿目录，但不再作为删除账号的默认中间状态。
const ACCOUNT_CHOICES: AccountChoice[] = [
  {
    value: "disable",
    title: "停用账号并保留 Profile",
    detail: "账号继续显示在列表中，但不参与调度；登录态、历史和全部 Profile 数据均保留，可随时重新启用。",
    recommended: true,
  },
  {
    value: "purge",
    title: "永久删除账号和 Profile",
    detail: "删除账号记录，并清除 Cookie、本地存储、扩展数据和其它 Profile 文件。不可恢复。",
    danger: true,
  },
];

export function AccountDeleteDialog({
  open,
  onOpenChange,
  accounts,
}: AccountDeleteDialogProps) {
  const [action, setAction] = React.useState<"disable" | "purge">("disable");
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setAction("disable");
      setDeleting(false);
    }
  }, [open]);

  const count = accounts.length;
  const single = count === 1 ? accounts[0] : undefined;

  const handleConfirm = async () => {
    setDeleting(true);
    const store = useKeeperStore.getState();
    try {
      const ids = accounts.map((account) => account.id);
      if (action === "disable") {
        await store.bulkSetEnabled(ids, false);
      } else if (single) {
        await store.removeAccount(single.id, "purge");
      } else {
        await store.bulkRemove(ids, "purge");
      }
      onOpenChange(false);
    } catch {
      // 失败提示已经由 store 发出（带稳定错误码）。这里保持弹窗打开，让用户能换一个
      // 处置方式重试，而不是回到一个看不出发生了什么的列表。
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && onOpenChange(next)}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {single ? "停用或永久删除这个账号？" : `停用或永久删除选中的 ${count} 个账号？`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {single ? `账号：${single.name}` : "请选择这些账号的处理方式。"}
            {" "}不确定时请选择停用，之后可以直接重新启用。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          role="radiogroup"
          aria-label="账号处置方式"
          className="flex flex-col gap-2 py-2"
        >
          {ACCOUNT_CHOICES.map((choice) => {
            const active = action === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={deleting}
                onClick={() => setAction(choice.value)}
                className={cn(
                  "flex flex-col gap-1 rounded-panel border p-3 text-left transition-colors disabled:opacity-50",
                  active && choice.danger && "border-danger bg-danger-soft",
                  active && !choice.danger && "border-accent bg-accent-soft",
                  !active && "border-subtle hover:border-line hover:bg-hover"
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-3.5 shrink-0 rounded-full border-2",
                      active && choice.danger && "border-danger bg-danger",
                      active && !choice.danger && "border-accent bg-accent",
                      !active && "border-strong"
                    )}
                  />
                  <span
                    className={cn(
                      "text-base font-medium",
                      active && choice.danger ? "text-danger" : "text-primary"
                    )}
                  >
                    {choice.title}
                  </span>
                  {choice.recommended && (
                    <span className="rounded-chip bg-ok-soft px-1.5 py-0.5 text-xs text-ok">
                      推荐
                    </span>
                  )}
                  {choice.danger && (
                    <TriangleAlert className="size-3.5 shrink-0 text-danger" />
                  )}
                </span>
                <span className="pl-5.5 text-xs text-secondary">{choice.detail}</span>
              </button>
            );
          })}
        </div>

        {action === "purge" && (
          <p className="rounded-panel border border-danger-soft bg-danger-soft px-3 py-2 text-xs text-danger">
            将永久删除 {count} 个 Profile 的全部磁盘数据，无法撤销。
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <Button
            variant={action === "purge" ? "danger" : "default"}
            onClick={() => void handleConfirm()}
            disabled={deleting}
          >
            {deleting && <Loader2 className="animate-spin" />}
            {action === "purge" ? "永久删除" : "停用并保留"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
