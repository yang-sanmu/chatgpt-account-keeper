import * as React from "react";
import { useKeeperStore } from "@/store/keeperStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { SwitchRule } from "@/ipc/types";
import { Loader2 } from "lucide-react";
import { notify } from "@/lib/notify";

interface AccountCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccountCreateDialog({ open, onOpenChange }: AccountCreateDialogProps) {
  const groups = useKeeperStore((s) => s.groups);
  
  const [note, setNote] = React.useState("");
  const [groupId, setGroupId] = React.useState<string>("none");
  const [switchRule, setSwitchRule] = React.useState<SwitchRule>("random");
  const [minWindows, setMinWindows] = React.useState(1);
  const [maxWindows, setMaxWindows] = React.useState(3);
  const [submitting, setSubmitting] = React.useState(false);

  // 每次打开重置表单
  React.useEffect(() => {
    if (open) {
      setNote("");
      setGroupId("none");
      setSwitchRule("random");
      setMinWindows(1);
      setMaxWindows(3);
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    
    try {
      await useKeeperStore.getState().createAccount({
        note,
        groupId: groupId === "none" ? null : groupId,
        switchRule,
        minWindows,
        maxWindows,
        enabled: true,
      });
      // 成功后由 store 发起通知并调起登录，只需关闭弹窗
      onOpenChange(false);
    } catch (err) {
      notify.error("创建账号失败", err);
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => !submitting && onOpenChange(val)}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>新建账号</DialogTitle>
            <DialogDescription>
              创建成功后，系统会自动打开浏览器窗口要求您完成首次登录。
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="create-note">备注 (可选)</Label>
              <Input
                id="create-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：主账号、备用..."
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>分组</Label>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未分组</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid gap-2">
                <Label>切换规则</Label>
                <Select value={switchRule} onValueChange={(v) => setSwitchRule(v as SwitchRule)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="random">随机</SelectItem>
                    <SelectItem value="sequential">顺序</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="min-windows">最小窗口数</Label>
                <Input
                  id="min-windows"
                  type="number"
                  min={1}
                  value={minWindows}
                  onChange={(e) => setMinWindows(Number(e.target.value))}
                />
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="max-windows">最大窗口数</Label>
                <Input
                  id="max-windows"
                  type="number"
                  min={1}
                  value={maxWindows}
                  onChange={(e) => setMaxWindows(Number(e.target.value))}
                />
              </div>
            </div>
          </div>
          
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              创建并登录
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
