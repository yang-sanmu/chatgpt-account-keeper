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

interface ConversationDeleteDialogProps {
  target: string | null;
  onClose: () => void;
}

export function ConversationDeleteDialog({ target, onClose }: ConversationDeleteDialogProps) {
  const [submitting, setSubmitting] = React.useState(false);

  const handleDelete = async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      const cid = await newCommandId();
      await agentCall("conversations.remove", { name: target }, cid);
      notify.success("策略已删除", "使用它的账号会在下次运行时回退到默认主题");
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
          <AlertDialogTitle>确定要删除策略 "{target}" 吗？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后，当前正在使用此策略的账号将在下次运行时退回到系统默认策略。此操作不可恢复。
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
