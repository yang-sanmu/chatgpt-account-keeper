import { Fragment, useEffect, useState } from "react";
import { ArrowDown, ArrowRight, Check, Globe, Loader2, Monitor, Network, RefreshCw, Router } from "lucide-react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { agentCall, newCommandId } from "@/ipc/bridge";
import type { NetworkConfigParams, NetworkConfigResult } from "@/ipc/generated";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useKeeperStore } from "@/store/keeperStore";

const DEFAULT_CONFIG: NetworkConfigParams = { mode: "system", relayProxyId: null, systemProxyUrl: null, outboundInterface: null };
const MODES = [
  { id: "direct", title: "直连模式", description: "直接连接分组专用节点，省去前置代理。", steps: ["浏览器", "分组专用节点", "网站"] },
  { id: "system", title: "系统代理", description: "通过系统当前使用的代理连接分组专用节点。", steps: ["浏览器", "系统代理", "分组专用节点", "网站"] },
  { id: "relay", title: "指定中转", description: "固定一个中转节点，独立于系统代理的节点选择。", steps: ["浏览器", "指定中转", "分组专用节点", "网站"] },
] as const;

function RouteDiagram({ steps, stacked = false }: { steps: readonly string[]; stacked?: boolean }) {
  return <div role="img" aria-label={steps.join(" → ")} className={cn("flex items-center gap-1.5 py-3", stacked ? "flex-col" : "overflow-x-auto")}>
    {steps.map((step, index) => <Fragment key={`${step}-${index}`}>
      {index > 0 && (stacked ? <ArrowDown aria-hidden="true" className="size-3 shrink-0 text-muted" /> : <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted" />)}
      <span className={cn("inline-flex shrink-0 items-center justify-center gap-1 rounded-control border border-subtle bg-sunken px-2 py-2 text-xs text-secondary", stacked && "w-full")}>
        {index === 0 ? <Monitor className="size-3" /> : index === steps.length - 1 ? <Globe className="size-3" /> : <Router className="size-3" />}
        {step}
      </span>
    </Fragment>)}
  </div>;
}

export function NetworkPage() {
  const proxies = useKeeperStore((state) => state.proxies);
  const groups = useKeeperStore((state) => state.groups);
  const [current, setCurrent] = useState<NetworkConfigResult | null>(proxies.network ?? null);
  const [draft, setDraft] = useState<NetworkConfigParams>(proxies.network?.config ?? DEFAULT_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    agentCall("network.getConfig", {}).then((result) => {
      if (alive) {
        useKeeperStore.setState((state) => ({ proxies: { ...state.proxies, network: result } }));
        setCurrent(result); setDraft(result.config); setLoading(false);
      }
    }).catch((error) => {
      if (alive) { setLoading(false); setLoadError(true); notify.error("读取网络配置失败", error); }
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (proxies.network) {
      setCurrent(proxies.network);
      if (!dirty) setDraft(proxies.network.config);
    }
  }, [proxies.network, dirty]);

  const change = (patch: Partial<NetworkConfigParams>) => { setDraft((value) => ({ ...value, ...patch })); setDirty(true); };
  const usableNodes = proxies.nodes.filter((node) => node.enabled && !node.missing);
  const relay = usableNodes.find((node) => node.id === draft.relayProxyId);
  const unavailableRelay = draft.mode === "relay" && !relay;
  const busy = useKeeperStore((state) => state.accountIds.some((id) => state.accounts[id]?.baseline.pageOpen || state.accounts[id]?.baseline.running));
  const temporaryBusy = useKeeperStore((state) => state.temporaryWindows.some(window => window.state !== "closed"));
  const icloudBusy = useKeeperStore((state) => state.icloud?.busy || state.icloud?.browserOpen);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await agentCall("network.getConfig", {});
      useKeeperStore.setState((state) => ({ proxies: { ...state.proxies, network: result } }));
      setCurrent(result); if (!dirty) setDraft(result.config); setLoadError(false);
    } catch (error) { setLoadError(true); notify.error("读取网络配置失败", error); }
    finally { setLoading(false); }
  };
  const save = async () => {
    setSaving(true);
    try {
      const result = await agentCall("network.updateConfig", draft, await newCommandId());
      useKeeperStore.setState((state) => ({ proxies: { ...state.proxies, network: result } }));
      setCurrent(result); setDraft(result.config); setDirty(false);
      notify.success("网络配置已保存", "下次启动账号浏览器时使用此链路");
    } catch (error) { notify.error("保存网络配置失败", error); }
    finally { setSaving(false); }
  };

  return <Page>
    <PageHeader title="网络配置" description="选择连接专用节点的方式，组内账号共用分组出口。"
      actions={<Button variant="outline" onClick={() => void refresh()} disabled={loading || saving}><RefreshCw className={cn("size-4", loading && "animate-spin")} />刷新</Button>} />
    <PageBody className="space-y-6 pb-12">
      <fieldset disabled={loading || saving || loadError} className="space-y-6">
        <legend className="sr-only">网络模式</legend>
        <div role="radiogroup" aria-label="网络模式" className="grid gap-4 lg:grid-cols-3">
          {MODES.map((mode) => <label key={mode.id} className={cn("cursor-pointer rounded-panel border p-4 transition-colors", draft.mode === mode.id ? "border-accent bg-accent-soft" : "border-subtle bg-panel hover:bg-hover")}>
            <div className="flex items-center gap-2">
              <input type="radio" name="network-mode" value={mode.id} checked={draft.mode === mode.id} onChange={() => change({ mode: mode.id })} className="accent-[var(--color-accent)]" />
              <span className="font-medium text-primary">{mode.title}</span>
              {draft.mode === mode.id && <Check className="ml-auto size-4 text-accent" />}
            </div>
            <p className="mt-2 text-xs leading-5 text-secondary">{mode.description}</p>
            <RouteDiagram steps={mode.steps} stacked />
            <p className="text-xs leading-5 text-muted">{mode.id === "system" ? "分组也使用系统代理时，只经过一次系统代理。" : mode.id === "relay" ? "分组节点与中转相同时，只连接一次该节点。" : "分组未绑定专用节点时，浏览器直接访问网站。"}</p>
          </label>)}
        </div>

        {draft.mode === "system" && <Card>
          <CardHeader><CardTitle>系统代理入口</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="system-proxy-url">入口地址（留空自动检测）</Label>
            <Input id="system-proxy-url" value={draft.systemProxyUrl ?? ""} onChange={(event) => change({ systemProxyUrl: event.target.value.trim() || null })} placeholder="例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:7890" />
            <p className="text-xs text-muted">支持无认证的 HTTP、HTTPS 和 SOCKS5 入口。自动检测不到固定入口时跟随系统网络；PAC 需要为专用节点填写固定入口。</p>
            {current && <div className="rounded-control bg-sunken p-3 text-sm text-secondary">
              <p className="mb-1 text-xs text-muted">当前已保存配置的入口</p>
              <span>{current.systemProxy.detail}</span>
              {current.systemProxy.server && <p className="mt-1 font-mono text-xs">{current.systemProxy.server}</p>}
            </div>}
          </CardContent>
        </Card>}

        {draft.mode === "relay" && <Card>
          <CardHeader><CardTitle>选择中转节点</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="relay-proxy">订阅与自定义节点</Label>
            <SearchableSelect id="relay-proxy" label="中转节点" value={draft.relayProxyId ?? ""} onValueChange={(value) => change({ relayProxyId: value })}
              options={usableNodes.map((node) => ({ value: node.id, label: `${node.id.startsWith("custom_") ? "自定义" : "订阅"} · ${node.name} · ${node.type ?? ""} · ${node.server ?? ""}:${node.port ?? ""}` }))} />
            <p className="text-xs text-muted">可按名称、协议、服务器地址输入关键词搜索，只能选择已启用且有效的节点。</p>
            {unavailableRelay && <p role="alert" className="text-sm text-warn">{draft.relayProxyId ? "原中转节点已停用或失效，请重新选择。" : "请选择一个中转节点。"}</p>}
          </CardContent>
        </Card>}

        {draft.mode !== "system" && <Card>
          <CardHeader><CardTitle>直出设置</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="outbound-interface">直出网卡（可选）</Label>
            <Input id="outbound-interface" value={draft.outboundInterface ?? ""} onChange={(event) => change({ outboundInterface: event.target.value || null })} placeholder="留空遵循系统路由，例如：以太网 或 Wi-Fi" />
            <p className="text-xs leading-5 text-muted">用于连接专用节点或中转节点。开启 TUN／VPN 时，留空仍可能受到系统路由影响；可填写实际物理网卡名称并验证直出。未绑定节点的浏览器直连仍遵循系统路由。</p>
          </CardContent>
        </Card>}
      </fieldset>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Network className="size-4" />分组链路预览{dirty && <span className="text-xs font-normal text-muted">（未保存）</span>}</CardTitle></CardHeader>
        <CardContent className="divide-y divide-subtle">
          {groups.map((group) => {
            const node = proxies.nodes.find((item) => item.id === group.proxyId);
            const finalName = group.proxyId ? node?.enabled && !node.missing ? node.name : "专用节点不可用" : null;
            const steps = ["浏览器"];
            if (draft.mode === "system") steps.push("系统代理");
            if (draft.mode === "relay") steps.push(relay?.name ?? "待选择中转");
            if (finalName && !(draft.mode === "relay" && group.proxyId === draft.relayProxyId)) steps.push(finalName);
            steps.push("网站");
            return <div key={group.id} className="py-2"><p className="text-sm font-medium text-primary">{group.name}</p><RouteDiagram steps={steps} /></div>;
          })}
          {!groups.length && <p className="text-sm text-muted">在“分组与代理”中创建分组后，可查看每组的实际链路。</p>}
        </CardContent>
      </Card>
      {(busy || temporaryBusy || icloudBusy) && <p role="status" className="text-sm text-warn">请先关闭账号浏览器、临时窗口和 iCloud 浏览器，并等待运行任务结束，再保存网络配置。</p>}
      {loadError && <p role="alert" className="text-sm text-warn">网络配置读取失败，请刷新后重试。</p>}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={loading || saving || loadError || busy || temporaryBusy || icloudBusy || unavailableRelay || !dirty}>{saving && <Loader2 className="size-4 animate-spin" />}保存网络配置</Button>
        <span className="text-xs text-muted">{dirty ? "有未保存的更改" : `当前模式：${MODES.find((mode) => mode.id === current?.config.mode)?.title ?? "读取中…"}`}</span>
      </div>
    </PageBody>
  </Page>;
}
