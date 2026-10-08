import * as React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { agentCall, newCommandId, normalizeApiError } from "@/ipc/bridge";
import type { EnvironmentStateResult } from "@/ipc/generated";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

// Several expanded cards share one query lane. Polls never overlap, including
// slow/offline Agent calls; unmounted/hidden views are checked again before send.
let queryLane: Promise<unknown> = Promise.resolve();
function queryEnvironment(accountId: string, active: () => boolean) {
  const pending = queryLane.catch(() => {}).then(async () => {
    if (!active() || document.hidden) return null;
    // WebView visibility does not always change when the native window is hidden.
    if (!(await getCurrentWindow().isVisible()) || !active()) return null;
    return agentCall("environments.get", { accountId });
  });
  queryLane = pending;
  return pending;
}

const sources = { account: "账号固定", group_manual: "分组手动配置", group_auto: "分组自动探测", application_default: "应用默认（zh-CN）", browser_default: "Chrome 默认（不覆盖）" };

export function AccountEnvironmentPanel({ accountId }: { accountId: string }) {
  const [state, setState] = React.useState<EnvironmentStateResult | null>(null);
  const [locale, setLocale] = React.useState("");
  const [timezone, setTimezone] = React.useState("");
  const [error, setError] = React.useState("");
  const [queryError, setQueryError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const dirty = React.useRef(false);
  const version = React.useRef(0);
  const latestVersion = React.useRef(-1);
  const accept = React.useCallback((next: EnvironmentStateResult) => {
    if (next.configuration.version < latestVersion.current) return;
    latestVersion.current = next.configuration.version;
    setState(next);
    if (!dirty.current) {
      setLocale(next.configuration.locale ?? next.next.locale);
      setTimezone(next.configuration.timezone ?? next.next.timezoneId ?? "");
      version.current = next.configuration.version;
    }
  }, []);

  React.useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>; let backoff = 2000;
    async function poll() {
      try {
        const next = await queryEnvironment(accountId, () => !disposed);
        if (!disposed && next) { accept(next); setQueryError(""); }
        backoff = 2000;
      } catch (e) {
        if (!disposed) setQueryError(normalizeApiError(e).message);
        backoff = Math.min(30_000, backoff * 2);
      } finally { if (!disposed) timer = setTimeout(() => void poll(), backoff); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [accountId, accept, reload]);

  const save = async (reset: boolean) => {
    if (!state || saving) return;
    setSaving(true); setError("");
    try {
      const commandId = await newCommandId();
      const params = { accountId, expectedVersion: version.current };
      const next = reset ? await agentCall("environments.reset", params, commandId)
        : await agentCall("environments.update", { ...params, locale, timezone }, commandId);
      dirty.current = false; accept(next);
    } catch (e) { setError(normalizeApiError(e).message); }
    finally { setSaving(false); }
  };

  return <div className="space-y-2 border-t border-line pt-2 text-xs">
    <p className="font-medium">浏览器环境 · {state ? state.configuration.mode === "fixed" ? "账号固定" : "继承分组" : "读取中"}</p>
    <p className="text-muted">修改在下次打开时生效，登录数据保留。固定后换组也保留语言和时区。</p>
    {state && <p className="text-muted">版本 {state.configuration.version} · 语言：{sources[state.next.localeSource]} · 时区：{sources[state.next.timezoneSource]}</p>}
    {state?.probePending && <p className="text-muted">分组地区尚未完整探测，下次启动会先尝试探测；当前显示的是未探测时的默认值。</p>}
    {state?.pending && <p role="status">待生效：版本 {state.configuration.version}；当前窗口保持启动时的环境。</p>}
    <div className="space-y-1">
      <Label htmlFor={`environment-locale-${accountId}`} className="text-xs">语言</Label>
      <Input id={`environment-locale-${accountId}`} className="h-8 text-xs" placeholder="zh-CN" value={locale} disabled={!state || saving}
        onChange={e => { dirty.current = true; setLocale(e.target.value); }} />
    </div>
    <div className="space-y-1">
      <Label htmlFor={`environment-timezone-${accountId}`} className="text-xs">时区</Label>
      <Input id={`environment-timezone-${accountId}`} className="h-8 text-xs" placeholder="固定时填写，例如 Asia/Shanghai" value={timezone} disabled={!state || saving}
        onChange={e => { dirty.current = true; setTimezone(e.target.value); }} />
    </div>
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" disabled={!state || saving} onClick={() => void save(false)}>保存为账号固定</Button>
      <Button size="sm" variant="ghost" disabled={!state || saving || state.configuration.mode === "inherit"} onClick={() => void save(true)}>恢复继承</Button>
      <Button size="sm" variant="ghost" disabled={saving} onClick={() => { dirty.current = false; setError(""); setReload(v => v + 1); }}>重新加载</Button>
    </div>
    {(error || queryError) && <p role="alert" className="text-danger">{error || queryError}</p>}
    <p className="text-muted">严格网络保护暂不可用。当前仍为普通模式。</p>
    <p className="text-muted break-all">“打开网页”的付款直连例外：gw.alipayobjects.com、sv.creditcard.ecitic.com。</p>
  </div>;
}
