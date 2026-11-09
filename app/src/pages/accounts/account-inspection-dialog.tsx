import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { proxyNodeOptions } from "@/lib/proxy-node-labels";
import { useKeeperStore } from "@/store/keeperStore";

interface AccountInspectionDialogProps {
  title: string;
  ids: readonly string[];
  onClose: () => void;
}

export function AccountInspectionDialog({ title, ids, onClose }: AccountInspectionDialogProps) {
  const proxies = useKeeperStore((s) => s.proxies);
  const bulkRefreshStatus = useKeeperStore((s) => s.bulkRefreshStatus);
  const [useSpecifiedNode, setUseSpecifiedNode] = useState(false);
  const [proxyId, setProxyId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const options = proxyNodeOptions(proxies);
  const canSubmit = !submitting && ids.length > 0 &&
    (!useSpecifiedNode || options.some(({ value }) => value === proxyId));

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await bulkRefreshStatus(ids, useSpecifiedNode ? proxyId : undefined);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>本次巡检 {ids.length} 个账号，检查登录状态并更新 accessToken。</DialogDescription>
        </DialogHeader>
        <fieldset disabled={submitting} className="space-y-3">
          <legend className="mb-2 text-sm font-medium">巡检节点</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="inspection-node" checked={!useSpecifiedNode} onChange={() => setUseSpecifiedNode(false)} />
            账号分组节点
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="inspection-node" checked={useSpecifiedNode} onChange={() => setUseSpecifiedNode(true)} />
            指定节点
          </label>
          {useSpecifiedNode && (
            <div className="space-y-1.5">
              <Label htmlFor="account-inspection-node">本次巡检使用的节点</Label>
              <SearchableSelect id="account-inspection-node" label="选择节点" options={options}
                value={proxyId} onValueChange={setProxyId} />
              {options.length === 0 && <p className="text-sm text-muted">请先在代理管理中启用可用节点。</p>}
            </div>
          )}
          <p className="text-sm text-muted">
            {useSpecifiedNode ? "本次巡检的所有账号都使用所选节点。" : "各账号使用自己的分组节点。未绑定节点时，跟随网络配置。"}
          </p>
        </fieldset>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onClose}>取消</Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>{submitting ? "正在提交…" : "开始巡检"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
