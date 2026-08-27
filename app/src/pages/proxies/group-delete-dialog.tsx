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
import { agentCall, newCommandId } from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import type { Group } from "@/ipc/types";

interface GroupDeleteDialogProps {
  target: Group | null;
  onClose: () => void;
}

export function GroupDeleteDialog({ target, onClose }: GroupDeleteDialogProps) {
  const [submitting, setSubmitting] = React.useState(false);

  const handleDelete = async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      const cid = await newCommandId();
      await agentCall("groups.remove", { id: target.id }, cid);
      notify.success("分组已删除", `原属该分组的账号已转为未分组`);
      onClose();
    } catch (error) {
      notify.error("删除失败", error);
    } finally {
      setSubmitting(false);
    }
  };

  const isOpen = target !== null;

  return (
    <AlertDialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确定要删除分组 "{target?.name}" 吗？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后，原本属于该分组的账号将变为「未分组」。账号本身的数据与浏览器 Profile 将保持原样，不会被触碰。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            确认删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
