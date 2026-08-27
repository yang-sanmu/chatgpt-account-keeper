import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { agentCall, newCommandId } from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import { useKeeperStore } from "@/store/keeperStore";
import type { Group } from "@/ipc/types";

interface GroupDialogProps {
  state: { mode: "create" } | { mode: "edit"; group: Group } | null;
  onClose: () => void;
}

export function GroupDialog({ state, onClose }: GroupDialogProps) {
  const proxies = useKeeperStore((s) => s.proxies);
  const [name, setName] = React.useState("");
  const [proxyId, setProxyId] = React.useState<string>("none");
  const [timezone, setTimezone] = React.useState("");
  const [locale, setLocale] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (state?.mode === "edit") {
      setName(state.group.name);
      setProxyId(state.group.proxyId || "none");
      setTimezone(state.group.timezone || "");
      setLocale(state.group.locale || "");
    } else if (state?.mode === "create") {
      setName("");
      setProxyId("none");
      setTimezone("");
      setLocale("");
    }
  }, [state]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state) return;
    if (!name.trim()) return notify.error("保存失败", "分组名称不能为空");

    setSubmitting(true);
    try {
      const cid = await newCommandId();
      const patch = {
        name: name.trim(),
        proxyId: proxyId === "none" ? null : proxyId,
        timezone: timezone.trim() || null,
        locale: locale.trim() || null,
      };

      if (state.mode === "create") {
        await agentCall("groups.create", patch, cid);
        notify.success("分组已创建", patch.name);
      } else {
        await agentCall("groups.update", { id: state.group.id, patch }, cid);
        notify.success("分组已更新", patch.name);
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
          <DialogTitle>{state?.mode === "create" ? "新建分组" : "编辑分组"}</DialogTitle>
        </DialogHeader>
        <form id="group-form" onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="group-name">分组名称</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：美国节点、测试组..."
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="group-proxy">绑定代理节点</Label>
            <Select value={proxyId} onValueChange={setProxyId}>
              <SelectTrigger id="group-proxy">
                <SelectValue placeholder="未绑定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未绑定 (直连或系统代理)</SelectItem>
                {proxies.nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="group-tz">时区</Label>
              <Input
                id="group-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="例如：America/Los_Angeles"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-locale">语言环境</Label>
              <Input
                id="group-locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                placeholder="例如：en-US"
              />
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="group-form" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
