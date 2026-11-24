import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useKeeperStore } from "@/store/keeperStore";
import { notify } from "@/lib/notify";
import type { ProxyNode } from "@/ipc/types";

export function NodeRenameDialog({ node, onClose }: { node: ProxyNode | null; onClose: () => void }) {
  const runOperation = useKeeperStore((s) => s.runOperation);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (node) setName(node.name);
  }, [node]);

  if (!node) return null;
  const isCustom = node.id.startsWith("custom_");
  const canRestore = !isCustom && Boolean(node.customNamed);

  const submitName = async (nextName: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await runOperation("proxies.renameNode", { id: node.id, name: nextName });
      notify.success(nextName ? "节点已重命名" : "已恢复订阅原名");
      onClose();
    } catch (error) {
      notify.error("重命名失败", error);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (isCustom && !trimmed) {
      notify.error("重命名失败", "节点名称不能为空");
      return;
    }
    void submitName(trimmed || null);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名代理节点</DialogTitle>
          <DialogDescription>
            {isCustom
              ? "修改节点展示名称不会中断正在运行的代理连接。"
              : "修改节点展示名称不会中断正在运行的代理连接，刷新订阅后也会保留该名称。留空可恢复订阅原名。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="proxy-rename-input">节点名称</Label>
            <Input
              id="proxy-rename-input"
              maxLength={200}
              value={name}
              disabled={saving}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder={isCustom ? "请输入节点名称" : node.originalName ?? node.name}
            />
          </div>
          {!isCustom && node.customNamed && node.originalName && (
            <p className="text-xs text-muted">订阅原名：{node.originalName}</p>
          )}
          <DialogFooter className="gap-2">
            {canRestore && (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => void submitName(null)}
                className="mr-auto"
              >
                恢复原名
              </Button>
            )}
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving || (isCustom && !name.trim())}>
              {saving ? "保存中…" : "保存名称"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
