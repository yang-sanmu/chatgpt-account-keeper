import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { agentCall } from "@/ipc/bridge";
import { useKeeperStore } from "@/store/keeperStore";
import { notify } from "@/lib/notify";
import type { CustomProxyDetails } from "@/ipc/generated";

export function CustomNodeDialog({ nodeId, onClose }: { nodeId?: string; onClose: () => void }) {
  const [fields, setFields] = React.useState<CustomProxyDetails>({ name: "", protocol: "http", server: "", port: 3000, username: "", password: "" });
  const [port, setPort] = React.useState("3000");
  const [loading, setLoading] = React.useState(!!nodeId);
  const [loadError, setLoadError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const passwordId = React.useId();
  const runOperation = useKeeperStore((s) => s.runOperation);

  React.useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    void agentCall("proxies.getCustom", { id: nodeId }).then((node) => {
      if (!cancelled) { setFields(node); setPort(String(node.port)); }
    }).catch((error) => {
      if (!cancelled) { setLoadError(true); notify.error("读取节点失败", error); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [nodeId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || saving || loadError) return;
    setSaving(true);
    try {
      await runOperation("proxies.saveCustom", { ...fields, ...(nodeId ? { id: nodeId } : {}), name: fields.name.trim(), server: fields.server.trim(), port: Number(port) });
      notify.success("节点已保存");
      onClose();
    } catch (error) { notify.error("保存失败", error); }
    finally { setSaving(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{nodeId ? "编辑自定义节点" : "新增自定义节点"}</DialogTitle>
        <DialogDescription>填写节点连接信息。修改已使用节点的连接信息会重新连接代理，分组绑定保持不变。</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        {loading && <p role="status">正在读取节点…</p>}
        {loadError && <p role="alert">无法读取节点，请关闭后重试。</p>}
        <fieldset disabled={loading || saving || loadError} className="space-y-3">
          <label className="block text-sm space-y-1">节点名称<Input required maxLength={200} value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })} /></label>
          <label className="block text-sm space-y-1">协议
            <select className="block w-full rounded-md border border-line bg-sunken px-3 py-2" value={fields.protocol} onChange={e => setFields({ ...fields, protocol: e.target.value as CustomProxyDetails["protocol"] })}>
              <option value="http">HTTP</option><option value="socks5">SOCKS5</option><option value="https">HTTPS</option>
            </select>
          </label>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <label className="block text-sm space-y-1">服务器<Input required maxLength={253} placeholder="proxy.example.com" value={fields.server} onChange={e => setFields({ ...fields, server: e.target.value })} /></label>
            <label className="block text-sm space-y-1">端口<Input required type="number" min={1} max={65535} step={1} value={port} onChange={e => setPort(e.target.value)} /></label>
          </div>
          <label className="block text-sm space-y-1">用户名<Input autoComplete="off" maxLength={4096} value={fields.username} onChange={e => setFields({ ...fields, username: e.target.value })} /></label>
          <div className="text-sm space-y-1">
            <label htmlFor={passwordId}>密码</label>
            <div className="relative">
              <Input id={passwordId} type={showPassword ? "text" : "password"} className="pr-10" autoComplete="new-password" maxLength={4096} value={fields.password} onChange={e => setFields({ ...fields, password: e.target.value })} />
              <Button type="button" variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 -translate-y-1/2" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-controls={passwordId} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted">无需认证时，用户名和密码均留空。</p>
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={loading || saving || loadError}>{saving ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
