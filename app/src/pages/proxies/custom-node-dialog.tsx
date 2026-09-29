import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { agentCall } from "@/ipc/bridge";
import { useKeeperStore } from "@/store/keeperStore";
import { notify } from "@/lib/notify";
import type { CustomProxyDetails } from "@/ipc/generated";
import { parseCustomProxyInput } from "../../../../src/customProxyInput.js";

type ProxyDraft = Omit<CustomProxyDetails, "port"> & { port: string };

function proxyUrl(fields: ProxyDraft) {
  const server = fields.server.trim();
  const host = server.includes(":") && !server.startsWith("[") ? `[${server}]` : server;
  const auth = fields.username ? `${encodeURIComponent(fields.username)}:${encodeURIComponent(fields.password)}@` : "";
  return `${fields.protocol}://${auth}${host}:${fields.port}#${encodeURIComponent(fields.name.trim())}`;
}

export function CustomNodeDialog({ nodeId, onClose }: { nodeId?: string; onClose: () => void }) {
  const [drafts, setDrafts] = React.useState<ProxyDraft[]>([{ name: "", protocol: "http", server: "", port: "3000", username: "", password: "" }]);
  const [input, setInput] = React.useState("");
  const [recognitionError, setRecognitionError] = React.useState("");
  const [recognitionStatus, setRecognitionStatus] = React.useState("");
  const generatedName = React.useRef<string | null>(null);
  const [loading, setLoading] = React.useState(!!nodeId);
  const [loadError, setLoadError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const inputId = React.useId();
  const runOperation = useKeeperStore((s) => s.runOperation);

  React.useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    void agentCall("proxies.getCustom", { id: nodeId }).then((node) => {
      if (!cancelled) setDrafts([{ ...node, port: String(node.port) }]);
    }).catch((error) => {
      if (!cancelled) { setLoadError(true); notify.error("读取节点失败", error); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [nodeId]);

  const recognize = () => {
    try {
      const parsed = parseCustomProxyInput(input, drafts[0]?.protocol ?? "http");
      if (nodeId && parsed.length !== 1) throw new Error("编辑节点时请只输入一条代理。");
      const previousName = drafts[0]?.name;
      const retainedName = nodeId || previousName !== generatedName.current ? previousName : "";
      setDrafts(parsed.map((node) => ({
        ...node,
        name: node.name || (parsed.length === 1 ? retainedName : "") || `${node.protocol.toUpperCase()} ${node.server}:${node.port}`,
        port: String(node.port),
      })));
      const first = parsed[0]!;
      generatedName.current = first.name || `${first.protocol.toUpperCase()} ${first.server}:${first.port}`;
      setRecognitionError("");
      setRecognitionStatus(`已识别 ${parsed.length} 条代理，请核对下方信息后保存。`);
    } catch (error) {
      setRecognitionStatus("");
      setRecognitionError(error instanceof Error ? error.message : "无法识别代理格式，请检查输入。");
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || saving || loadError) return;
    setSaving(true);
    try {
      for (const draft of drafts) {
        if (!draft.name.trim() || !draft.server.trim() || /[\s/@?#\\]/.test(draft.server.trim()) || (draft.password && !draft.username)) {
          throw new Error("请填写节点名称和有效的服务器；填写密码时必须填写用户名。");
        }
      }
      // Validate all drafts before a batch is sent, so invalid input cannot be partially saved.
      const urls = drafts.map(proxyUrl).join("\n");
      parseCustomProxyInput(urls);
      const fields = drafts[0]!;
      if (drafts.length === 1) {
        await runOperation("proxies.saveCustom", { ...fields, ...(nodeId ? { id: nodeId } : {}), name: fields.name.trim(), server: fields.server.trim(), port: Number(fields.port) });
      } else {
        await runOperation("proxies.importCustom", { input: urls });
      }
      notify.success("节点已保存");
      onClose();
    } catch (error) { notify.error("保存失败", error); }
    finally { setSaving(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{nodeId ? "编辑自定义节点" : "新增自定义代理"}</DialogTitle>
        <DialogDescription>{nodeId ? "修改已使用节点的连接信息会重新连接代理，分组绑定保持不变。" : "粘贴代理字符串并自动识别，或直接手动填写下方连接信息。"}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        {loading && <p role="status">正在读取节点…</p>}
        {loadError && <p role="alert">无法读取节点，请关闭后重试。</p>}
        <fieldset disabled={loading || saving || loadError} className="space-y-3">
          <div className="space-y-2 rounded-panel border border-line bg-sunken p-3">
            <label htmlFor={inputId} className="text-sm font-medium">代理字符串</label>
            <textarea id={inputId} value={input} onChange={e => { setInput(e.target.value); setRecognitionError(""); setRecognitionStatus(""); }}
              rows={3} maxLength={65536} autoComplete="off" spellCheck={false} aria-describedby={`${inputId}-help`}
              placeholder="IP:PORT:USER:PWD"
              className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            <p id={`${inputId}-help`} className="text-xs text-muted">支持 IP:PORT:USER:PWD、主机:端口@用户名:密码（也支持 \@）、代理 URL 和 curl 命令。{nodeId ? "每次识别一条。" : "每行一条，最多 100 条。"}未指定协议时使用下方所选协议。</p>
            <Button type="button" variant="outline" onClick={recognize} disabled={!input.trim()}>自动识别</Button>
            {recognitionError && <p role="alert" className="text-xs text-danger">{recognitionError}</p>}
            {recognitionStatus && <p role="status" className="text-xs text-secondary">{recognitionStatus}</p>}
          </div>
          {drafts.map((fields, index) => <fieldset key={index} className="space-y-3">
            {drafts.length > 1 && <legend className="py-2 text-sm font-semibold">代理 {index + 1}</legend>}
            <ProxyFields fields={fields} onChange={value => setDrafts(previous => previous.map((draft, i) => i === index ? value : draft))} />
          </fieldset>)}
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={loading || saving || loadError}>{saving ? "保存中…" : drafts.length > 1 ? `保存 ${drafts.length} 条代理` : "保存"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function ProxyFields({ fields, onChange: setFields }: { fields: ProxyDraft; onChange: (fields: ProxyDraft) => void }) {
  const [showPassword, setShowPassword] = React.useState(false);
  const passwordId = React.useId();
  return <>
          <label className="block text-sm space-y-1">节点名称<Input required maxLength={200} value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })} /></label>
          <label className="block text-sm space-y-1">协议
            <select className="block w-full rounded-md border border-line bg-sunken px-3 py-2" value={fields.protocol} onChange={e => setFields({ ...fields, protocol: e.target.value as CustomProxyDetails["protocol"] })}>
              <option value="http">HTTP</option><option value="socks5">SOCKS5</option><option value="https">HTTPS</option>
            </select>
          </label>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <label className="block text-sm space-y-1">服务器<Input required maxLength={253} placeholder="proxy.example.com" value={fields.server} onChange={e => setFields({ ...fields, server: e.target.value })} /></label>
            <label className="block text-sm space-y-1">端口<Input required type="number" min={1} max={65535} step={1} value={fields.port} onChange={e => setFields({ ...fields, port: e.target.value })} /></label>
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
  </>;
}
