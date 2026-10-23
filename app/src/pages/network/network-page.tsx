import { Fragment, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Globe,
  Laptop,
  Loader2,
  Lock,
  Monitor,
  Network,
  RefreshCw,
  RotateCcw,
  Router,
  Server,
  ShieldAlert,
  Waypoints,
  Zap,
} from "lucide-react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { StatusDot } from "@/components/ui/status-dot";
import { agentCall, newCommandId } from "@/ipc/bridge";
import type { NetworkConfigParams, NetworkConfigResult } from "@/ipc/generated";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useKeeperStore } from "@/store/keeperStore";

const DEFAULT_CONFIG: NetworkConfigParams = {
  mode: "system",
  relayProxyId: null,
  systemProxyUrl: null,
  outboundInterface: null,
};

const MODES = [
  {
    id: "direct",
    title: "直连模式",
    badge: "低延迟直出",
    icon: Zap,
    description: "直接连接分组专用节点，省去前置代理。",
    steps: ["浏览器", "分组专用节点", "网站"],
    footnote: "分组未绑定专用节点时，浏览器直接访问网站。",
  },
  {
    id: "system",
    title: "系统代理",
    badge: "推荐默认",
    icon: Laptop,
    description: "通过系统当前使用的代理连接分组专用节点。",
    steps: ["浏览器", "系统代理", "分组专用节点", "网站"],
    footnote: "分组也使用系统代理时，只经过一次系统代理。",
  },
  {
    id: "relay",
    title: "指定中转",
    badge: "固定前置",
    icon: Waypoints,
    description: "固定一个中转节点，独立于系统代理的节点选择。",
    steps: ["浏览器", "指定中转", "分组专用节点", "网站"],
    footnote: "分组节点与中转相同时，只连接一次该节点。",
  },
] as const;

const SYSTEM_PROXY_SOURCE_META: Record<
  NetworkConfigResult["systemProxy"]["source"],
  { label: string; variant: "ok" | "accent" | "warn" | "neutral" }
> = {
  manual: { label: "手动指定", variant: "accent" },
  windows: { label: "Windows 系统代理", variant: "ok" },
  environment: { label: "环境变量", variant: "ok" },
  pac: { label: "PAC 自动脚本", variant: "warn" },
  unavailable: { label: "未就绪", variant: "warn" },
  none: { label: "未检测到固定入口", variant: "neutral" },
};

const SYSTEM_PROXY_PRESETS = [
  { label: "Clash / Mihomo (7890)", value: "http://127.0.0.1:7890" },
  { label: "SOCKS5 (7890)", value: "socks5://127.0.0.1:7890" },
  { label: "v2rayN (10808)", value: "http://127.0.0.1:10808" },
] as const;

const INTERFACE_PRESETS = ["以太网", "Wi-Fi"] as const;

function RouteDiagram({
  steps,
  active = false,
}: {
  steps: readonly string[];
  active?: boolean;
}) {
  return (
    <div
      role="img"
      aria-label={steps.join(" → ")}
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-control border px-2.5 py-2 transition-colors",
        active ? "border-accent bg-panel" : "border-subtle bg-sunken"
      )}
    >
      {steps.map((step, index) => {
        const isFirst = index === 0;
        const isLast = index === steps.length - 1;
        const isMiddle = !isFirst && !isLast;
        return (
          <Fragment key={`${step}-${index}`}>
            {index > 0 && (
              <ArrowRight
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 transition-colors",
                  active ? "text-accent" : "text-muted"
                )}
              />
            )}
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-chip border px-2 py-1 text-2xs font-medium transition-colors",
                active && isMiddle
                  ? "border-accent bg-accent-soft text-accent"
                  : active
                    ? "border-subtle bg-sunken text-primary"
                    : "border-subtle bg-panel text-secondary"
              )}
            >
              {isFirst ? (
                <Monitor className="size-3 shrink-0" />
              ) : isLast ? (
                <Globe className="size-3 shrink-0" />
              ) : (
                <Router className="size-3 shrink-0" />
              )}
              {step}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

function formatNodeLatency(ms: number | null, ok: boolean | null) {
  if (ok === null) return { text: "未测速", variant: "neutral" as const };
  if (ok === false) return { text: "不可达", variant: "danger" as const };
  if (ms === null) return { text: "—", variant: "neutral" as const };
  if (ms < 200) return { text: `${ms} ms`, variant: "ok" as const };
  if (ms < 500) return { text: `${ms} ms`, variant: "warn" as const };
  return { text: `${ms} ms`, variant: "danger" as const };
}

export function NetworkPage() {
  const proxies = useKeeperStore((state) => state.proxies);
  const [current, setCurrent] = useState<NetworkConfigResult | null>(
    proxies.network ?? null
  );
  const [draft, setDraft] = useState<NetworkConfigParams>(
    proxies.network?.config ?? DEFAULT_CONFIG
  );
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    agentCall("network.getConfig", {})
      .then((result) => {
        if (alive) {
          useKeeperStore.setState((state) => ({
            proxies: { ...state.proxies, network: result },
          }));
          setCurrent(result);
          setDraft(result.config);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (alive) {
          setLoading(false);
          setLoadError(true);
          notify.error("读取网络配置失败", error);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (proxies.network) {
      setCurrent(proxies.network);
      if (!dirty) setDraft(proxies.network.config);
    }
  }, [proxies.network, dirty]);

  const change = (patch: Partial<NetworkConfigParams>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setDirty(true);
  };

  const discard = () => {
    if (current) {
      setDraft(current.config);
      setDirty(false);
    }
  };

  const usableNodes = proxies.nodes.filter(
    (node) => node.enabled && !node.missing
  );
  const relay = usableNodes.find((node) => node.id === draft.relayProxyId);
  const savedRelay = proxies.nodes.find(
    (node) => node.id === current?.config.relayProxyId
  );
  const unavailableRelay = draft.mode === "relay" && !relay;

  const busy = useKeeperStore((state) =>
    state.accountIds.some(
      (id) =>
        state.accounts[id]?.baseline.pageOpen ||
        state.accounts[id]?.baseline.running
    )
  );
  const temporaryBusy = useKeeperStore((state) =>
    state.temporaryWindows.some((window) => window.state !== "closed")
  );
  const icloudBusy = useKeeperStore(
    (state) => Boolean(state.icloud?.busy || state.icloud?.browserOpen)
  );
  const runtimeLocked = busy || temporaryBusy || icloudBusy;

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await agentCall("network.getConfig", {});
      useKeeperStore.setState((state) => ({
        proxies: { ...state.proxies, network: result },
      }));
      setCurrent(result);
      if (!dirty) setDraft(result.config);
      setLoadError(false);
    } catch (error) {
      setLoadError(true);
      notify.error("读取网络配置失败", error);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: NetworkConfigParams = {
        ...draft,
        outboundInterface: draft.outboundInterface?.trim() || null,
      };
      const result = await agentCall(
        "network.updateConfig",
        payload,
        await newCommandId()
      );
      useKeeperStore.setState((state) => ({
        proxies: { ...state.proxies, network: result },
      }));
      setCurrent(result);
      setDraft(result.config);
      setDirty(false);
      notify.success("网络配置已保存", "下次启动账号浏览器时使用此链路");
    } catch (error) {
      notify.error("保存网络配置失败", error);
    } finally {
      setSaving(false);
    }
  };

  const savedModeMeta = MODES.find((mode) => mode.id === current?.config.mode);
  const savedModeTitle =
    savedModeMeta?.title ?? (loadError ? "读取失败" : "读取中…");
  const systemSourceMeta = current
    ? SYSTEM_PROXY_SOURCE_META[current.systemProxy.source]
    : null;
  const relayLatency = relay
    ? formatNodeLatency(relay.latencyMs, relay.latencyOk)
    : null;

  return (
    <Page>
      <PageHeader
        title="网络配置"
        description="选择连接分组专用节点的前置链路方式与出站网卡，组内账号共用分组出口。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || saving}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
        }
      />

      <PageBody className="space-y-5 pb-12">
        {/* 顶部运行态与已生效配置概览栏 */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-panel border border-subtle bg-panel px-4 py-3 shadow-panel">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2">
              <Network className="size-4 text-accent" />
              <span className="text-secondary">已生效模式:</span>
              <Badge variant={loadError && !current ? "danger" : "accent"}>
                {savedModeTitle}
              </Badge>
              {dirty && (
                <Badge variant="warn" className="font-normal">
                  草稿未保存
                </Badge>
              )}
            </div>

            {current && (
              <div className="flex flex-wrap items-center gap-2 border-l border-subtle pl-3 text-secondary">
                {current.config.mode === "system" && (
                  <>
                    <span>入口来源:</span>
                    {systemSourceMeta && (
                      <Badge variant={systemSourceMeta.variant} className="font-normal">
                        {systemSourceMeta.label}
                      </Badge>
                    )}
                    {draft.mode !== "system" && current.systemProxy.server && (
                      <span className="font-mono text-primary">
                        {current.systemProxy.server}
                      </span>
                    )}
                  </>
                )}
                {current.config.mode === "relay" && (
                  <>
                    <span>前置中转:</span>
                    <span
                      className={cn(
                        "font-medium",
                        !savedRelay || !savedRelay.enabled || savedRelay.missing
                          ? "text-danger"
                          : "text-primary"
                      )}
                    >
                      {savedRelay
                        ? `${savedRelay.name}${!savedRelay.enabled || savedRelay.missing ? "（不可用）" : ""}`
                        : "未找到节点"}
                    </span>
                  </>
                )}
                {current.config.mode === "direct" && (
                  <>
                    <span>直出路由:</span>
                    <span className="font-medium text-primary">
                      {current.config.outboundInterface
                        ? `绑定网卡 ${current.config.outboundInterface}`
                        : "遵循系统默认路由"}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5 text-muted tabular">
              <Server className="size-3.5" />
              <span>可用节点</span>
              <span className="font-medium text-primary">
                {usableNodes.length}
              </span>
              <span>/ {proxies.nodes.length}</span>
            </div>
            <div className="flex items-center gap-1.5 border-l border-subtle pl-3">
              <StatusDot
                status={
                  loadError ? "failed" : runtimeLocked ? "busy" : "ok"
                }
                label={
                  loadError
                    ? "读取异常"
                    : runtimeLocked
                      ? "运行期锁定"
                      : "可随时切换"
                }
              />
            </div>
          </div>
        </div>

        {/* 异常与运行锁定提示 */}
        {loadError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-danger bg-danger-soft px-4 py-3 text-xs text-danger"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 shrink-0" />
              <span>网络配置读取失败，请刷新后重试。</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={() => void refresh()}
              disabled={loading}
            >
              重试读取
            </Button>
          </div>
        )}

        {runtimeLocked && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-warn bg-warn-soft px-4 py-3 text-xs text-warn"
          >
            <div className="flex items-center gap-2">
              <Lock className="size-4 shrink-0" />
              <span>
                请先关闭账号浏览器、临时窗口和 iCloud 浏览器，并等待运行任务结束，再保存网络配置。
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {busy && <Badge variant="warn">账号浏览器/任务运行中</Badge>}
              {temporaryBusy && <Badge variant="warn">临时窗口已打开</Badge>}
              {icloudBusy && <Badge variant="warn">iCloud 浏览器活动</Badge>}
            </div>
          </div>
        )}

        <fieldset
          disabled={loading || saving || loadError}
          className="space-y-5"
        >
          <legend className="sr-only">网络模式</legend>

          {/* 模式选择矩阵 */}
          <div className="space-y-2.5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-primary">
                前置连接模式
              </h2>
              <span className="text-xs text-muted">
                选择浏览器到达分组专用节点前的跳点策略
              </span>
            </div>

            <div
              role="radiogroup"
              aria-label="网络模式"
              className="grid gap-4 lg:grid-cols-3"
            >
              {MODES.map((mode) => {
                const selected = draft.mode === mode.id;
                const Icon = mode.icon;
                return (
                  <label
                    key={mode.id}
                    className={cn(
                      "group relative flex cursor-pointer flex-col justify-between gap-3.5 rounded-panel border p-4 transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-ring)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                      selected
                        ? "border-accent bg-accent-soft shadow-panel"
                        : "border-subtle bg-panel hover:border-line hover:bg-hover"
                    )}
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-control border transition-colors",
                              selected
                                ? "border-accent bg-accent text-accent-content"
                                : "border-subtle bg-sunken text-secondary group-hover:text-primary"
                            )}
                          >
                            <Icon className="size-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="network-mode"
                                value={mode.id}
                                checked={selected}
                                onChange={() => change({ mode: mode.id })}
                                className="sr-only"
                              />
                              <span className="text-base font-semibold text-primary">
                                {mode.title}
                              </span>
                              <Badge
                                variant={selected ? "accent" : "neutral"}
                                className="text-2xs font-normal"
                              >
                                {mode.badge}
                              </Badge>
                            </div>
                          </div>
                        </div>

                        <span
                          aria-hidden="true"
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                            selected
                              ? "border-accent bg-accent text-accent-content"
                              : "border-line bg-sunken text-transparent"
                          )}
                        >
                          <Check className="size-3 stroke-[2.5]" />
                        </span>
                      </div>

                      <p className="text-xs leading-relaxed text-secondary">
                        {mode.description}
                      </p>

                      <RouteDiagram steps={mode.steps} active={selected} />
                    </div>

                    <div className="border-t border-subtle pt-2.5 text-2xs leading-relaxed text-muted">
                      {mode.footnote}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* 系统代理模式配置面板 */}
          {draft.mode === "system" && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-base">系统代理入口</CardTitle>
                    <CardDescription>
                      自动读取系统代理设置，或手动指定固定的本地代理监听端口。
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="font-mono text-2xs">
                    HTTP / HTTPS / SOCKS5
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="system-proxy-url">
                      入口地址（留空自动检测）
                    </Label>
                    <Input
                      id="system-proxy-url"
                      value={draft.systemProxyUrl ?? ""}
                      onChange={(event) =>
                        change({
                          systemProxyUrl: event.target.value.trim() || null,
                        })
                      }
                      placeholder="例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"
                      className="font-mono text-xs"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-2xs text-muted">常用端口快填：</span>
                    {SYSTEM_PROXY_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => change({ systemProxyUrl: preset.value })}
                        className={cn(
                          "rounded-chip border px-2 py-0.5 text-2xs transition-colors disabled:pointer-events-none disabled:opacity-50",
                          draft.systemProxyUrl === preset.value
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-subtle bg-sunken text-secondary hover:bg-hover hover:text-primary"
                        )}
                      >
                        {preset.label}
                      </button>
                    ))}
                    {draft.systemProxyUrl && (
                      <button
                        type="button"
                        onClick={() => change({ systemProxyUrl: null })}
                        className="rounded-chip border border-subtle bg-sunken px-2 py-0.5 text-2xs text-muted hover:bg-hover hover:text-primary disabled:pointer-events-none disabled:opacity-50"
                      >
                        恢复自动检测
                      </button>
                    )}
                  </div>

                  <p className="text-xs leading-relaxed text-muted">
                    支持无认证的 HTTP、HTTPS 和 SOCKS5 入口。自动检测不到固定入口时跟随系统网络；PAC 需要为专用节点填写固定入口。
                  </p>
                </div>

                {current && (
                  <div className="flex flex-col justify-between gap-3 rounded-control border border-subtle bg-sunken p-3.5 text-xs text-secondary">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted">
                          当前已保存配置的入口
                        </p>
                        {systemSourceMeta && (
                          <Badge
                            variant={systemSourceMeta.variant}
                            className="text-2xs font-normal"
                          >
                            {systemSourceMeta.label}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs font-medium text-primary">
                        <span>{current.systemProxy.detail}</span>
                      </p>
                      {current.systemProxy.server && (
                        <div className="rounded-chip border border-subtle bg-panel px-2.5 py-1.5">
                          <p className="font-mono text-xs text-accent">
                            {current.systemProxy.server}
                          </p>
                        </div>
                      )}
                    </div>

                    <p className="border-t border-subtle pt-2 text-2xs text-muted">
                      点击右上角“刷新”可重新探测当前操作系统代理状态。
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* 指定中转与直出设置面板 */}
          {draft.mode !== "system" && (
            <div
              className={cn(
                "grid gap-4",
                draft.mode === "relay" ? "lg:grid-cols-2" : "grid-cols-1"
              )}
            >
              {draft.mode === "relay" && (
                <Card className="flex flex-col justify-between">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="space-y-1">
                        <CardTitle className="text-base">
                          选择中转节点
                        </CardTitle>
                        <CardDescription>
                          固定一个前置代理节点，所有分组专用节点均通过该节点中转连接。
                        </CardDescription>
                      </div>
                      <Badge variant="outline" className="tabular text-2xs">
                        {usableNodes.length} 个可选
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3.5">
                    <div className="space-y-1.5">
                      <Label htmlFor="relay-proxy">订阅与自定义节点</Label>
                      <SearchableSelect
                        id="relay-proxy"
                        label="中转节点"
                        value={draft.relayProxyId ?? ""}
                        onValueChange={(value) =>
                          change({ relayProxyId: value })
                        }
                        options={usableNodes.map((node) => ({
                          value: node.id,
                          label: `${node.id.startsWith("custom_") ? "自定义" : "订阅"} · ${node.name} · ${node.type ?? ""} · ${node.server ?? ""}:${node.port ?? ""}`,
                        }))}
                      />
                    </div>

                    <p className="text-xs leading-relaxed text-muted">
                      可按名称、协议、服务器地址输入关键词搜索，只能选择已启用且有效的节点。
                    </p>

                    {unavailableRelay ? (
                      <div
                        role="alert"
                        className="flex items-center gap-2 rounded-control border border-warn bg-warn-soft px-3 py-2 text-xs text-warn"
                      >
                        <AlertTriangle className="size-4 shrink-0" />
                        <span>
                          {draft.relayProxyId
                            ? "原中转节点已停用或失效，请重新选择。"
                            : "请选择一个中转节点。"}
                        </span>
                      </div>
                    ) : (
                      relay && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-subtle bg-sunken px-3 py-2.5 text-xs">
                          <div className="flex min-w-0 items-center gap-2">
                            <Badge
                              variant={
                                relay.id.startsWith("custom_")
                                  ? "accent"
                                  : "neutral"
                              }
                              className="shrink-0 text-2xs font-normal"
                            >
                              {relay.id.startsWith("custom_")
                                ? "自定义"
                                : "订阅"}
                            </Badge>
                            <span
                              className="truncate font-medium text-primary"
                              title={relay.name}
                            >
                              {relay.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-2xs">
                            {relay.type && (
                              <Badge variant="outline" className="uppercase">
                                {relay.type}
                              </Badge>
                            )}
                            {relay.server && (
                              <span className="font-mono text-secondary tabular">
                                {relay.server}:{relay.port}
                              </span>
                            )}
                            {relayLatency && (
                              <Badge
                                variant={relayLatency.variant}
                                className="tabular"
                              >
                                {relayLatency.text}
                              </Badge>
                            )}
                          </div>
                        </div>
                      )
                    )}
                  </CardContent>
                </Card>
              )}

              <Card className="flex flex-col justify-between">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="space-y-1">
                      <CardTitle className="text-base">直出设置</CardTitle>
                      <CardDescription>
                        指定底层连接专用节点或中转节点时绑定的物理网络接口。
                      </CardDescription>
                    </div>
                    <Badge variant="neutral" className="text-2xs font-normal">
                      可选高级项
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3.5">
                  <div className="space-y-1.5">
                    <Label htmlFor="outbound-interface">直出网卡（可选）</Label>
                    <Input
                      id="outbound-interface"
                      value={draft.outboundInterface ?? ""}
                      onChange={(event) =>
                        change({
                          outboundInterface: event.target.value || null,
                        })
                      }
                      placeholder="留空遵循系统路由，例如：以太网 或 Wi-Fi"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-2xs text-muted">常见网卡名：</span>
                    {INTERFACE_PRESETS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => change({ outboundInterface: item })}
                        className={cn(
                          "rounded-chip border px-2 py-0.5 text-2xs transition-colors disabled:pointer-events-none disabled:opacity-50",
                          draft.outboundInterface === item
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-subtle bg-sunken text-secondary hover:bg-hover hover:text-primary"
                        )}
                      >
                        {item}
                      </button>
                    ))}
                    {draft.outboundInterface && (
                      <button
                        type="button"
                        onClick={() => change({ outboundInterface: null })}
                        className="rounded-chip border border-subtle bg-sunken px-2 py-0.5 text-2xs text-muted hover:bg-hover hover:text-primary disabled:pointer-events-none disabled:opacity-50"
                      >
                        恢复系统默认路由
                      </button>
                    )}
                  </div>

                  <p className="text-xs leading-relaxed text-muted">
                    用于连接专用节点或中转节点。开启 TUN／VPN 时，留空仍可能受到系统路由影响；可填写实际物理网卡名称并验证直出。未绑定节点的浏览器直连仍遵循系统路由。
                  </p>
                </CardContent>
              </Card>
            </div>
          )}
        </fieldset>

        {/* 底部保存操作栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-subtle bg-panel px-4 py-3 shadow-panel">
          <div className="flex items-center gap-2.5 text-xs">
            <StatusDot
              status={
                loadError && !current
                  ? "failed"
                  : dirty
                    ? "needs_login"
                    : current
                      ? "ok"
                      : "unknown"
              }
              label={
                dirty ? "有未保存的更改" : `当前模式：${savedModeTitle}`
              }
            />
            <span className="hidden text-muted sm:inline">
              · 保存后将在下次启动账号浏览器时生效
            </span>
          </div>

          <div className="flex items-center gap-2">
            {dirty && (
              <Button
                type="button"
                variant="outline"
                onClick={discard}
                disabled={loading || saving}
              >
                <RotateCcw className="size-3.5" />
                放弃修改
              </Button>
            )}
            <Button
              onClick={() => void save()}
              disabled={
                loading ||
                saving ||
                loadError ||
                runtimeLocked ||
                unavailableRelay ||
                !dirty
              }
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              保存网络配置
            </Button>
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
