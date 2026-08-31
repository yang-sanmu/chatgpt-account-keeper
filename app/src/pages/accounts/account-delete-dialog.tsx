import * as React from "react";
import { useKeeperStore, type ProfileAction } from "@/store/keeperStore";
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

interface ProfileChoice {
  value: ProfileAction;
  title: string;
  detail: string;
  danger?: boolean;
  recommended?: boolean;
}

/// 三种 Profile 处置方式。
///
/// 文案必须说清「Profile 留不留、能不能恢复」：Profile 目录里是登录态和几百 MB 到几 GB 的
/// 浏览器数据，选错的代价是重新登录几十个账号。
const PROFILE_CHOICES: ProfileChoice[] = [
  {
    value: "archive",
    title: "归档 Profile",
    detail: "移动到归档目录。登录态和全部数据完整保留，之后可以手动恢复或关联到新账号。",
    recommended: true,
  },
  {
    value: "detach",
    title: "保留 Profile，仅解除关联",
    detail: "目录原地不动，只删掉账号记录。目录会变成孤儿，之后可以在 Profile 页处理。",
  },
  {
    value: "purge",
    title: "永久删除 Profile",
    detail: "连同 Cookie、本地存储、扩展数据一起从磁盘删除。不可恢复，也没有回收站。",
    danger: true,
  },
];

export function AccountDeleteDialog({
  open,
  onOpenChange,
  accounts,
}: AccountDeleteDialogProps) {
  // 默认归档而不是删除：这是唯一一个既清理了列表、又不会造成不可逆损失的选项。
  const [action, setAction] = React.useState<ProfileAction>("archive");
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setAction("archive");
      setDeleting(false);
    }
  }, [open]);

  const count = accounts.length;
  const single = count === 1 ? accounts[0] : undefined;

  const handleConfirm = async () => {
    setDeleting(true);
    const store = useKeeperStore.getState();
    try {
      if (single) {
        await store.removeAccount(single.id, action);
      } else {
        await store.bulkRemove(
          accounts.map((account) => account.id),
          action
        );
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
            {single ? "删除这个账号？" : `删除选中的 ${count} 个账号？`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {single
              ? `账号记录、状态和历史都会被删除：${single.name}`
              : "这些账号的记录、状态和历史都会被删除。"}
            {" "}Chrome Profile 目录的处置方式请在下面选择。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          role="radiogroup"
          aria-label="Profile 处置方式"
          className="flex flex-col gap-2 py-2"
        >
          {PROFILE_CHOICES.map((choice) => {
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
            {action === "purge" ? "永久删除" : "确认删除"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
