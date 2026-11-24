import * as React from "react";
import { Eye, EyeOff, FileUp, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { agentCall } from "@/ipc/bridge";
import { useKeeperStore } from "@/store/keeperStore";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import type { CustomProxyDetails } from "@/ipc/generated";
import { parseCustomProxyInput } from "../../../../src/customProxyInput.js";

type ProxyDraft = Omit<CustomProxyDetails, "port"> & { port: string };
type ConfigDraft = {
  name: string;
  type: string;
  server: string;
  port: number;
  yaml: string;
  showYaml?: boolean;
};

function proxyUrl(fields: ProxyDraft) {
  const server = fields.server.trim();
  const host = server.includes(":") && !server.startsWith("[") ? `[${server}]` : server;
  const auth = fields.username ? `${encodeURIComponent(fields.username)}:${encodeURIComponent(fields.password)}@` : "";
  return `${fields.protocol}://${auth}${host}:${fields.port}#${encodeURIComponent(fields.name.trim())}`;
}

export function CustomNodeDialog({
  nodeId,
  kind = "simple",
  onClose,
}: {
  nodeId?: string;
  kind?: "simple" | "yaml";
  onClose: () => void;
}) {
  const [mode, setMode] = React.useState<"simple" | "yaml">(nodeId ? kind : "simple");
  const [drafts, setDrafts] = React.useState<ProxyDraft[]>([
    { name: "", protocol: "http", server: "", port: "3000", username: "", password: "" },
  ]);
  const [input, setInput] = React.useState("");
  const [recognitionError, setRecognitionError] = React.useState("");
  const [recognitionStatus, setRecognitionStatus] = React.useState("");
  const generatedName = React.useRef<string | null>(null);

  const [configInput, setConfigInput] = React.useState("");
  const [configDrafts, setConfigDrafts] = React.useState<ConfigDraft[]>([]);
  const [configError, setConfigError] = React.useState("");
  const [configStatus, setConfigStatus] = React.useState("");
  const [recognizingConfig, setRecognizingConfig] = React.useState(false);

  const [loading, setLoading] = React.useState(!!nodeId);
  const [loadError, setLoadError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const inputId = React.useId();
  const configInputId = React.useId();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const runOperation = useKeeperStore((s) => s.runOperation);

  React.useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    if (kind === "yaml") {
      setMode("yaml");
      void agentCall("proxies.getCustomConfig", { id: nodeId }).then((node) => {
        if (!cancelled) {
          setConfigDrafts([{
            name: node.name,
            type: node.type,
            server: node.server,
            port: node.port,
            yaml: node.yaml,
            showYaml: true,
          }]);
        }
      }).catch((error) => {
        if (!cancelled) {
          setLoadError(true);
          notify.error("读取节点失败", error);
        }
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    } else {
      setMode("simple");
      void agentCall("proxies.getCustom", { id: nodeId }).then((node) => {
        if (!cancelled) setDrafts([{ ...node, port: String(node.port) }]);
      }).catch((error) => {
        if (!cancelled) {
          setLoadError(true);
          notify.error("读取节点失败", error);
        }
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }
    return () => { cancelled = true; };
  }, [nodeId, kind]);

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

  const recognizeConfigText = async (rawText: string) => {
    if (!rawText.trim()) return;
    setRecognizingConfig(true);
    setConfigDrafts([]);
    setConfigError("");
    setConfigStatus("");
    try {
      const preview = await agentCall("proxies.previewCustomConfig", { input: rawText });
      setConfigDrafts(preview.nodes.map((node) => ({ ...node, showYaml: preview.nodes.length === 1 })));
      setConfigStatus(
        `已识别 ${preview.nodes.length} 个节点${preview.skipped > 0 ? `（跳过 ${preview.skipped} 条无效项）` : ""}，可修改名称或 YAML 后保存。`
      );
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : "无法解析 Clash YAML 或分享链接，请检查内容。");
    } finally {
      setRecognizingConfig(false);
    }
  };

  const handleImportYamlFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setConfigInput("");
    setConfigDrafts([]);
    setConfigStatus("");
    setConfigError("");
    if (file.size > 262144) {
      setConfigError("文件过大（上限 256 KB），请精简后导入。");
      return;
    }
    try {
      const text = await file.text();
      setConfigInput(text);
      await recognizeConfigText(text);
    } catch {
      setConfigError("读取本地文件失败，请重试。");
    }
  };

  const submitSimple = async () => {
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
      await runOperation("proxies.saveCustom", {
        ...fields,
        ...(nodeId ? { id: nodeId } : {}),
        name: fields.name.trim(),
        server: fields.server.trim(),
        port: Number(fields.port),
      });
    } else {
      await runOperation("proxies.importCustom", { input: urls });
    }
  };

  const submitConfig = async () => {
    let itemsToSave = configDrafts;
    if (!nodeId && !itemsToSave.length && configInput.trim()) {
      const preview = await agentCall("proxies.previewCustomConfig", { input: configInput });
      itemsToSave = preview.nodes.map((node) => ({ ...node, showYaml: preview.nodes.length === 1 }));
      setConfigDrafts(itemsToSave);
    }
    if (!itemsToSave.length) {
      throw new Error("请先粘贴 Clash YAML / 分享链接并识别节点，或导入本地 YAML 文件。");
    }
    const items = itemsToSave.map((item) => ({
      name: item.name.trim(),
      yaml: item.yaml,
    }));
    for (const item of items) {
      if (!item.name || !item.yaml.trim()) {
        throw new Error("每个节点都需要填写节点名称和有效的 YAML 配置。");
      }
    }
    await runOperation("proxies.saveCustomConfig", {
      ...(nodeId ? { id: nodeId } : {}),
      items: items as [{ name: string; yaml: string }, ...{ name: string; yaml: string }[]],
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || saving || loadError || recognizingConfig) return;
    setSaving(true);
    try {
      if (mode === "yaml") await submitConfig();
      else await submitSimple();
      notify.success("节点已保存");
      onClose();
    } catch (error) {
      notify.error("保存失败", error);
    } finally {
      setSaving(false);
    }
  };

  const submitLabel = saving
    ? "保存中…"
    : mode === "yaml"
      ? configDrafts.length > 1
        ? `保存 ${configDrafts.length} 个节点`
        : "保存"
      : drafts.length > 1
        ? `保存 ${drafts.length} 条代理`
        : "保存";

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {nodeId ? (mode === "yaml" ? "编辑自定义节点（Clash YAML）" : "编辑自定义节点") : "新增自定义代理"}
          </DialogTitle>
          <DialogDescription>
            {nodeId
              ? "修改已使用节点的连接信息会重新连接代理，分组绑定保持不变。"
              : mode === "yaml"
                ? "导入自建节点（VLESS / Hysteria2 / Trojan / VMess / SS 等）：支持粘贴 Clash YAML、导入本地 .yaml 文件或协议分享链接。"
                : "粘贴代理字符串并自动识别，或直接手动填写下方连接信息。"}
          </DialogDescription>
        </DialogHeader>

        {!nodeId && (
          <div role="tablist" aria-label="自定义代理模式" className="grid grid-cols-2 gap-1 rounded-control border border-subtle bg-sunken p-1">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "simple"}
              disabled={saving}
              onClick={() => setMode("simple")}
              className={cn(
                "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                mode === "simple" ? "bg-panel text-primary shadow-sm" : "text-secondary hover:text-primary"
              )}
            >
              HTTP / SOCKS5 代理
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "yaml"}
              disabled={saving}
              onClick={() => setMode("yaml")}
              className={cn(
                "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                mode === "yaml" ? "bg-panel text-primary shadow-sm" : "text-secondary hover:text-primary"
              )}
            >
              Clash YAML / 分享链接
            </button>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          {loading && <p role="status" className="text-sm text-muted">正在读取节点…</p>}
          {loadError && <p role="alert" className="text-sm text-danger">无法读取节点，请关闭后重试。</p>}

          {mode === "simple" ? (
            <fieldset disabled={loading || saving || loadError} className="space-y-3">
              <div className="space-y-2 rounded-panel border border-line bg-sunken p-3">
                <label htmlFor={inputId} className="text-sm font-medium">代理字符串</label>
                <textarea
                  id={inputId}
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setRecognitionError(""); setRecognitionStatus(""); }}
                  rows={3}
                  maxLength={65536}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${inputId}-help`}
                  placeholder="IP:PORT:USER:PWD"
                  className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <p id={`${inputId}-help`} className="text-xs text-muted">
                  支持 IP:PORT:USER:PWD、主机:端口@用户名:密码（也支持 \@）、代理 URL 和 curl 命令。{nodeId ? "每次识别一条。" : "每行一条，最多 100 条。"}未指定协议时使用下方所选协议。
                </p>
                <Button type="button" variant="outline" onClick={recognize} disabled={!input.trim()}>自动识别</Button>
                {recognitionError && <p role="alert" className="text-xs text-danger">{recognitionError}</p>}
                {recognitionStatus && <p role="status" className="text-xs text-secondary">{recognitionStatus}</p>}
              </div>
              {drafts.map((fields, index) => (
                <fieldset key={index} className="space-y-3">
                  {drafts.length > 1 && <legend className="py-2 text-sm font-semibold">代理 {index + 1}</legend>}
                  <ProxyFields
                    fields={fields}
                    onChange={(value) => setDrafts((previous) => previous.map((draft, i) => (i === index ? value : draft)))}
                  />
                </fieldset>
              ))}
            </fieldset>
          ) : (
            <fieldset disabled={loading || saving || loadError || recognizingConfig} className="space-y-3">
              {!nodeId && (
                <div className="space-y-2 rounded-panel border border-line bg-sunken p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor={configInputId} className="text-sm font-medium">Clash YAML 或分享链接</label>
                    <div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".yaml,.yml,.txt"
                        className="sr-only"
                        aria-label="选择本地 YAML 文件"
                        onChange={(event) => void handleImportYamlFile(event)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <FileUp className="size-3.5 mr-1.5" />
                        导入本地 YAML 文件
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    id={configInputId}
                    value={configInput}
                    onChange={(event) => {
                      setConfigInput(event.target.value);
                      setConfigDrafts([]);
                      setConfigError("");
                      setConfigStatus("");
                    }}
                    rows={6}
                    maxLength={262144}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={"可直接粘贴完整 vps.yaml、proxies 节点片段，或每行一条分享链接：\nvless://...\nhy2://...\ntrojan://..."}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted">
                    自动提取 proxies 中的所有节点（支持 VLESS-Reality、Hysteria2、Trojan、VMess、SS 等），并自动剥离冲突的路由字段。
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void recognizeConfigText(configInput)}
                    disabled={!configInput.trim() || recognizingConfig}
                  >
                    {recognizingConfig ? "识别中…" : "识别节点"}
                  </Button>
                  {configError && <p role="alert" className="text-xs text-danger">{configError}</p>}
                  {configStatus && <p role="status" className="text-xs text-secondary">{configStatus}</p>}
                </div>
              )}

              {configDrafts.map((item, index) => (
                <div key={index} className="space-y-2.5 rounded-panel border border-subtle bg-panel p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs text-secondary">
                      <Badge variant="outline" className="uppercase">{item.type || "proxy"}</Badge>
                      <span className="font-mono">{item.server}:{item.port}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {!nodeId && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfigDrafts((prev) => prev.map((draft, i) => (
                            i === index ? { ...draft, showYaml: !draft.showYaml } : draft
                          )))}
                        >
                          {item.showYaml ? "收起 YAML" : "编辑 YAML"}
                        </Button>
                      )}
                      {!nodeId && configDrafts.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`移除节点 ${item.name}`}
                          onClick={() => setConfigDrafts((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <label className="block text-sm space-y-1">
                    节点名称
                    <Input
                      required
                      maxLength={200}
                      value={item.name}
                      onChange={(event) => setConfigDrafts((prev) => prev.map((draft, i) => (
                        i === index ? { ...draft, name: event.target.value } : draft
                      )))}
                    />
                  </label>
                  {(nodeId || item.showYaml) && (
                    <label className="block text-sm space-y-1">
                      节点 YAML 配置
                      <Textarea
                        required
                        rows={8}
                        maxLength={32768}
                        spellCheck={false}
                        autoComplete="off"
                        className="font-mono text-xs"
                        value={item.yaml}
                        onChange={(event) => setConfigDrafts((prev) => prev.map((draft, i) => (
                          i === index ? { ...draft, yaml: event.target.value } : draft
                        )))}
                      />
                    </label>
                  )}
                </div>
              ))}
            </fieldset>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>取消</Button>
            <Button
              type="submit"
              disabled={loading || saving || loadError || recognizingConfig || (mode === "yaml" && !nodeId && !configDrafts.length && !configInput.trim())}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProxyFields({ fields, onChange: setFields }: { fields: ProxyDraft; onChange: (fields: ProxyDraft) => void }) {
  const [showPassword, setShowPassword] = React.useState(false);
  const passwordId = React.useId();
  return (
    <>
      <label className="block text-sm space-y-1">
        节点名称
        <Input required maxLength={200} value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} />
      </label>
      <label className="block text-sm space-y-1">
        协议
        <select
          className="block w-full rounded-md border border-line bg-sunken px-3 py-2"
          value={fields.protocol}
          onChange={(e) => setFields({ ...fields, protocol: e.target.value as CustomProxyDetails["protocol"] })}
        >
          <option value="http">HTTP</option>
          <option value="socks5">SOCKS5</option>
          <option value="https">HTTPS</option>
        </select>
      </label>
      <div className="grid grid-cols-[1fr_110px] gap-3">
        <label className="block text-sm space-y-1">
          服务器
          <Input required maxLength={253} placeholder="proxy.example.com" value={fields.server} onChange={(e) => setFields({ ...fields, server: e.target.value })} />
        </label>
        <label className="block text-sm space-y-1">
          端口
          <Input required type="number" min={1} max={65535} step={1} value={fields.port} onChange={(e) => setFields({ ...fields, port: e.target.value })} />
        </label>
      </div>
      <label className="block text-sm space-y-1">
        用户名
        <Input autoComplete="off" maxLength={4096} value={fields.username} onChange={(e) => setFields({ ...fields, username: e.target.value })} />
      </label>
      <div className="text-sm space-y-1">
        <label htmlFor={passwordId}>密码</label>
        <div className="relative">
          <Input
            id={passwordId}
            type={showPassword ? "text" : "password"}
            className="pr-10"
            autoComplete="new-password"
            maxLength={4096}
            value={fields.password}
            onChange={(e) => setFields({ ...fields, password: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-1/2 -translate-y-1/2"
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
            aria-controls={passwordId}
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted">无需认证时，用户名和密码均留空。</p>
    </>
  );
}
