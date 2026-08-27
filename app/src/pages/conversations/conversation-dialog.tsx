import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2 } from "lucide-react";
import { agentCall, newCommandId } from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import type { ConversationSet } from "@/ipc/types";

interface ConversationDialogProps {
  state: { mode: "create" } | { mode: "edit"; name: string; set: ConversationSet } | null;
  onClose: () => void;
}

export function ConversationDialog({ state, onClose }: ConversationDialogProps) {
  const [name, setName] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [minRounds, setMinRounds] = React.useState("1");
  const [maxRounds, setMaxRounds] = React.useState("1");
  const [submitting, setSubmitting] = React.useState(false);

  // 改名等于「新建 + 删旧」，是非原子的。这个标记用来提前警告用户。
  const isRenaming = state?.mode === "edit" && state.name !== name;

  React.useEffect(() => {
    if (state?.mode === "edit") {
      setName(state.name);
      setTopic(state.set.topic);
      setMinRounds(String(state.set.minRounds));
      setMaxRounds(String(state.set.maxRounds));
    } else if (state?.mode === "create") {
      setName("");
      setTopic("");
      setMinRounds("3");
      setMaxRounds("5");
    }
  }, [state]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state) return;
    if (!name.trim()) return notify.error("保存失败", "策略名称不能为空");
    if (!topic.trim()) return notify.error("保存失败", "主题不能为空");

    const min = parseInt(minRounds, 10);
    const max = parseInt(maxRounds, 10);
    if (isNaN(min) || isNaN(max) || min < 1 || max < 1) {
      return notify.error("保存失败", "轮数必须为大于 0 的有效数字");
    }
    if (min > max) {
      return notify.error("保存失败", "最小轮数不能大于最大轮数");
    }

    setSubmitting(true);
    try {
      const cid = await newCommandId();
      await agentCall(
        "conversations.upsert",
        {
          name: name.trim(),
          set: { topic: topic.trim(), minRounds: min, maxRounds: max },
        },
        cid
      );

      if (isRenaming) {
        try {
          const deleteCid = await newCommandId();
          await agentCall("conversations.remove", { name: state.name }, deleteCid);
        } catch (err) {
          notify.error(
            "清理旧策略失败",
            "重命名第一步成功但删除旧名称失败，两个策略现在同时存在，请手动删除旧的，否则它会继续参与调度"
          );
          setSubmitting(false);
          // 刻意不关弹窗：让用户看着当前状态决定下一步，而不是回到一个看不出
          // 发生了什么的列表。
          return;
        }
        notify.success("策略已重命名", `${state.name} → ${name.trim()}`);
      } else {
        notify.success(
          state.mode === "create" ? "策略已创建" : "策略已更新",
          name.trim()
        );
      }

      onClose();
    } catch (error) {
      notify.error("保存失败", error);
    } finally {
      setSubmitting(false);
    }
  };

  const isOpen = state !== null;

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.mode === "create" ? "新建会话策略" : "编辑会话策略"}</DialogTitle>
          <DialogDescription>
            分配给账号的会话策略决定了其在调度期间生成的对话话题与长度。
          </DialogDescription>
        </DialogHeader>

        <form id="conversation-form" onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="conv-name">策略名称</Label>
            <Input
              id="conv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：科技新闻、日常闲聊..."
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="conv-topic">话题 Prompt</Label>
            <Input
              id="conv-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：谈论最新的科技新闻"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="conv-min">最小轮数</Label>
              <Input
                id="conv-min"
                type="number"
                min="1"
                value={minRounds}
                onChange={(e) => setMinRounds(e.target.value)}
                className="tabular"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conv-max">最大轮数</Label>
              <Input
                id="conv-max"
                type="number"
                min="1"
                value={maxRounds}
                onChange={(e) => setMaxRounds(e.target.value)}
                className="tabular"
              />
            </div>
          </div>

          {isRenaming && (
            <div className="flex items-start gap-2 rounded-panel bg-warn-soft p-3 text-warn">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">即将重命名策略</p>
                <p className="text-warn/80 mt-1">
                  由于名称是策略的唯一标识，这实际上是创建一个新策略并删除旧的。如果有账号正在使用旧策略，这可能会影响它们的调度。
                </p>
              </div>
            </div>
          )}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="conversation-form" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
