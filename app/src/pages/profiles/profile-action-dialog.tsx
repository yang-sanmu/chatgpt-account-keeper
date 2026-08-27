import * as React from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { notify } from "@/lib/notify";
import { useKeeperStore } from "@/store/keeperStore";
import { formatBytes } from "@/lib/format";
import { narrowCleanCacheResult } from "./clean-result";
import type { ProfileInfo } from "@/ipc/types";

interface ProfileActionDialogProps {
  state: {
    kind: "clean" | "archive" | "purge" | "clean-all" | "archive-all" | "purge-all";
    profile?: ProfileInfo;
  } | null;
  onClose: () => void;
  onBulkAction: (kind: "clean" | "archive" | "purge") => Promise<void>;
}

export function ProfileActionDialog({ state, onClose, onBulkAction }: ProfileActionDialogProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const runOperation = useKeeperStore((s) => s.runOperation);

  const handleConfirm = async () => {
    if (!state) return;
    setSubmitting(true);

    try {
      // 单条操作都需要一个具体的 Profile。缺了就说清楚，而不是让非空断言在运行时炸。
      if (state.kind === "clean" || state.kind === "archive" || state.kind === "purge") {
        const target = state.profile;
        if (!target) {
          notify.error("操作失败", "没有指定要处理的 Profile");
          return;
        }

        if (state.kind === "clean") {
          const op = await runOperation("profiles.cleanCache", { name: target.name });
          const outcome = narrowCleanCacheResult(op.result);
          // 占用中的 Profile 会被跳过而不是报错。这时说「清理成功」是错的：用户会以为
          // 磁盘腾出来了，回头看占用没变。
          if (outcome && outcome.profilesCleaned === 0) {
            const reason = outcome.skipped[0]?.reason;
            notify.warning(
              "未执行清理",
              reason ?? `Profile「${target.name}」正被占用，已跳过`
            );
          } else if (outcome) {
            notify.success(
              "清理完成",
              `释放 ${formatBytes(outcome.freedBytes)}；登录状态未受影响`
            );
          } else {
            notify.info("清理任务已完成", "后台没有返回可核对的清理明细");
          }
        } else if (state.kind === "archive") {
          await runOperation("profiles.archiveOrphan", { name: target.name });
          notify.success("归档完成", `「${target.name}」已移入归档目录，数据完整保留`);
        } else {
          await runOperation("profiles.purgeOrphan", { name: target.name });
          notify.success("已永久删除", `「${target.name}」的磁盘数据已全部删除`);
        }
      } else if (state.kind === "clean-all") {
        await onBulkAction("clean");
      } else if (state.kind === "archive-all") {
        await onBulkAction("archive");
      } else if (state.kind === "purge-all") {
        await onBulkAction("purge");
      }
    } catch (error) {
      notify.error("操作失败", error);
    } finally {
      setSubmitting(false);
      onClose();
    }
  };

  const isOpen = state !== null;

  let title = "";
  let desc = <></>;

  if (state?.kind === "clean") {
    title = `清理 "${state.profile?.name ?? "该 Profile"}" 缓存？`;
    desc = (
      <>
        此操作将清理临时文件、代码缓存和 GPU 缓存。
        <strong>Cookies 和登录会话将得到保留</strong>，不需要重新登录。
      </>
    );
  } else if (state?.kind === "archive") {
    title = `归档孤儿数据 "${state.profile?.name ?? "该 Profile"}"？`;
    desc = (
      <>
        此 Profile 将被移动到归档目录（<code>profiles-archive/</code>）。
        <strong>数据完整保留，之后可以手动恢复或关联到新账号。</strong>
      </>
    );
  } else if (state?.kind === "purge") {
    title = `彻底删除孤儿数据 "${state.profile?.name ?? "该 Profile"}"？`;
    desc = (
      <>
        将永久删除此 Profile 的所有磁盘数据，包括 Cookies 和本地存储。
        <strong className="text-danger block mt-2">此操作不可逆，且无法恢复。</strong>
      </>
    );
  } else if (state?.kind === "clean-all") {
    title = "清理所有缓存？";
    desc = (
      <>
        此操作将清理所有未在使用中的 Profile 的临时文件、代码缓存和 GPU 缓存。
        <strong>Cookies 和登录会话将得到保留</strong>，不需要重新登录。
      </>
    );
  } else if (state?.kind === "archive-all") {
    title = "归档所有孤儿数据？";
    desc = (
      <>
        将所有闲置的孤儿 Profile 移动到归档目录（<code>profiles-archive/</code>）。
        <strong>数据完整保留，之后可以手动恢复。</strong>
        正被 Chrome 或运行中任务占用的会自动跳过。
      </>
    );
  } else if (state?.kind === "purge-all") {
    title = "彻底删除所有孤儿数据？";
    desc = (
      <>
        将永久删除所有闲置孤儿 Profile 的全部磁盘数据，包括 Cookies 和本地存储。
        正在使用中的 Profile 将被自动跳过。
        <strong className="text-danger block mt-2">此操作不可逆，且无法恢复。</strong>
      </>
    );
  }

  const isDanger = state?.kind === "purge" || state?.kind === "purge-all";

  return (
    <AlertDialog open={isOpen} onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 mt-2">{desc}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant={isDanger ? "danger" : "default"}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            确认
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
