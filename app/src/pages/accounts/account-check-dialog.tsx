import { useEffect, useRef, useState } from "react";
import { AccountCheckResults } from "@/components/account-check-results";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { Operation } from "@/ipc/types";
import { ACCOUNT_CHECK_KINDS, accountCheckResult, isAccountCheckPending } from "@/lib/account-checks";
import { describeError } from "@/lib/notify";
import { proxyNodeOptions } from "@/lib/proxy-node-labels";
import { useKeeperStore } from "@/store/keeperStore";
import { useAccountLabeler } from "@/store/selectors";

export interface AccountCheckTarget {
  title: string;
  kind: "inspection" | "relogin" | "promo" | "singlePlan";
  ids: string[];
  scope: "filtered" | "selected" | "single" | "failed";
}

function latestOperation(operations: Operation[]) {
  return operations.reduce<Operation | undefined>((latest, operation) =>
    !latest || operation.startedAt > latest.startedAt ? operation : latest, undefined);
}

export function AccountCheckDialog({ title, kind, ids, scope, onClose }: AccountCheckTarget & { onClose: () => void }) {
  const proxies = useKeeperStore((s) => s.proxies);
  const operations = useKeeperStore((s) => s.operations);
  const allIds = useKeeperStore((s) => s.accountIds);
  const accounts = useKeeperStore((s) => s.accounts);
  const mailSettings = useKeeperStore((s) => s.mailSettings);
  const loadMailSettings = useKeeperStore((s) => s.loadMailSettings);
  const runOperation = useKeeperStore((s) => s.runOperation);
  const accountLabeler = useAccountLabeler();
  const inspection = kind === "inspection";
  const relogin = kind === "relogin";
  const queueBacked = inspection || relogin;
  const single = kind === "singlePlan";
  const subject = single ? "套餐" : "Plus 优惠资格";
  const verb = inspection ? "巡检" : relogin ? "自动重登" : "查询";
  const [selection, setSelection] = useState("initial");
  const [useSpecifiedNode, setUseSpecifiedNode] = useState(!queueBacked);
  const [autoRelogin, setAutoRelogin] = useState(Boolean(mailSettings?.autoReloginDefault));
  const syncedMailDefaultRef = useRef(Boolean(mailSettings));
  const [forceRelogin, setForceRelogin] = useState(false);
  const [reloginWindow, setReloginWindow] = useState<"default" | "headless" | "headed">("default");
  const [proxyId, setProxyId] = useState("");

  useEffect(() => {
    if (!queueBacked) return;
    if (!mailSettings) {
      void loadMailSettings().catch(() => {});
    } else if (!syncedMailDefaultRef.current) {
      syncedMailDefaultRef.current = true;
      setAutoRelogin(mailSettings.autoReloginDefault);
    }
  }, [queueBacked, mailSettings, loadMailSettings]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<Operation>();
  const options = proxyNodeOptions(proxies);

  const relevant = operations.filter((operation) =>
    operation.kind === ACCOUNT_CHECK_KINDS[kind] && (!single || operation.resourceId === ids[0]));
  if (response && !relevant.some(({ id }) => id === response.id)) relevant.unshift(response);
  const active = relevant.find(isAccountCheckPending);
  const running = submitting || !!active;
  const busy = operations.some((operation) => isAccountCheckPending(operation) &&
    (queueBacked ? operation.kind === ACCOUNT_CHECK_KINDS.inspection || operation.kind === ACCOUNT_CHECK_KINDS.relogin
      : operation.kind === ACCOUNT_CHECK_KINDS.promo || operation.kind === ACCOUNT_CHECK_KINDS.plan ||
        operation.kind === ACCOUNT_CHECK_KINDS.singlePlan));
  const latest = latestOperation(relevant);
  const interrupted = latest?.state === "cancelled";
  const completed = latestOperation(relevant.filter((operation) => operation.state === "succeeded"));
  const result = accountCheckResult(completed);
  const existingIds = new Set(allIds);
  const failedIds = (result?.failures ?? [])
    .map(({ id }) => id).filter((id) => existingIds.has(id));
  const selected = selection === "failed" ? failedIds
    : selection === "all" ? allIds : ids.filter((id) => existingIds.has(id));
  const canSubmit = !submitting && !busy && selected.length > 0 &&
    (!useSpecifiedNode || options.some(({ value }) => value === proxyId));

  const submit = async () => {
    const [first, ...rest] = selected;
    if (!canSubmit || !first) return;
    const ids: [string, ...string[]] = [first, ...rest];
    setSubmitting(true);
    setError(null);
    setResponse(undefined);
    try {
      const operation = inspection
        ? await runOperation("accounts.inspect", {
            ids,
            ...(useSpecifiedNode ? { proxyId } : {}),
            ...(autoRelogin ? { autoRelogin: true } : {}),
          })
        : relogin
          ? await runOperation("accounts.relogin", {
              ids,
              ...(useSpecifiedNode ? { proxyId } : {}),
              ...(forceRelogin ? { force: true } : {}),
              ...(reloginWindow !== "default" ? { headless: reloginWindow === "headless" } : {}),
            })
          : single
            ? await runOperation("accounts.checkPlans", { ids, proxyId, single: true })
            : await runOperation("accounts.checkPromos", { ids, proxyId });
      setResponse(operation);
    } catch (cause) {
      setError(describeError(cause).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{inspection
            ? "检查登录状态并更新 accessToken，可选在 401/失效时自动重新登录。"
            : relogin
              ? "通过接码邮箱（IMAP）或已存凭据自动重新登录并刷新 accessToken。若遇人机验证将停下提示人工处理。"
              : `使用已有 accessToken 通过所选节点查询${subject}。缺少凭据的账号可先巡检。`}</DialogDescription>
        </DialogHeader>
        <fieldset hidden={running} disabled={submitting || busy} className="mt-4 space-y-3">
          {!single && scope !== "single" && (
            <div className="space-y-1.5">
              <Label htmlFor="account-check-scope">执行范围</Label>
              <select id="account-check-scope" className="block w-full rounded-md border border-line bg-sunken px-3 py-2 text-sm"
                value={selection} onChange={(event) => setSelection(event.target.value)}>
                <option value="initial">{scope === "filtered" ? "当前筛选结果" : scope === "failed" ? "当前筛选的失效 / 401 账号" : "已勾选账号"}</option>
                {!inspection && scope === "filtered" && <option value="all">全部账号（{allIds.length} 个）</option>}
                <option value="failed" disabled={!failedIds.length}>上次失败所有项（{failedIds.length} 个）</option>
              </select>
            </div>
          )}
          <p className="text-sm text-secondary">本次{verb} {selected.length} 个账号</p>
          {queueBacked && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{inspection ? "巡检节点" : "重登节点"}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="inspection-node" checked={!useSpecifiedNode} onChange={() => setUseSpecifiedNode(false)} />
                账号分组节点
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="inspection-node" checked={useSpecifiedNode} onChange={() => setUseSpecifiedNode(true)} />
                指定节点
              </label>
            </fieldset>
          )}
          {useSpecifiedNode && (
            <div className="space-y-1.5">
              <Label htmlFor="account-check-node">{inspection ? "本次巡检使用的节点" : relogin ? "本次重登使用的节点" : "查询节点"}</Label>
              <SearchableSelect id="account-check-node" label="选择节点" options={options} value={proxyId} onValueChange={setProxyId} />
              {options.length === 0 && <p className="text-sm text-muted">请先在代理管理中启用可用节点。</p>}
            </div>
          )}
          {inspection && (
            <div className="flex items-center justify-between rounded-md border border-line/70 px-3 py-2">
              <div className="space-y-0.5 pr-4">
                <Label htmlFor="inspect-auto-relogin" className="text-sm font-medium">遇到 401 / 登录失效时自动重登</Label>
                <p className="text-xs text-muted">在同一浏览会话中通过 IMAP 验证码或账号凭据完成重登</p>
              </div>
                <Switch
                  id="inspect-auto-relogin"
                  checked={autoRelogin}
                  onCheckedChange={(checked) => {
                    syncedMailDefaultRef.current = true;
                    setAutoRelogin(checked);
                  }}
                />
            </div>
          )}
          {relogin && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between rounded-md border border-line/70 px-3 py-2">
                <div className="space-y-0.5 pr-4">
                  <Label htmlFor="relogin-force" className="text-sm font-medium">强制清空会话后重登</Label>
                  <p className="text-xs text-muted">关闭时，若探测到页面仍在线将直接刷新 Token，不重复接码</p>
                </div>
                <Switch
                  id="relogin-force"
                  checked={forceRelogin}
                  onCheckedChange={setForceRelogin}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="relogin-window-mode">执行窗口模式</Label>
                <select
                  id="relogin-window-mode"
                  className="w-full rounded-md border border-line bg-raised px-3 py-2 text-sm"
                  value={reloginWindow}
                  onChange={(event) => setReloginWindow(event.target.value as "default" | "headless" | "headed")}
                >
                  <option value="default">跟随设置页默认模式</option>
                  <option value="headless">后台静默（无头）</option>
                  <option value="headed">弹出可见窗口（降风控）</option>
                </select>
              </div>
            </div>
          )}
          {(relogin || (inspection && autoRelogin)) && (() => {
            const imapReady = Boolean(
              mailSettings?.imapHost && mailSettings?.imapUser && mailSettings?.imapPasswordConfigured
            );
            const missingEmailCount = selected.filter((id) => !accounts[id]?.effective.email?.trim()).length;
            if (imapReady && missingEmailCount === 0) return null;
            return (
              <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn space-y-1">
                {!imapReady && (
                  <p>尚未在「设置 → 接码邮箱（IMAP）」完成配置：需要邮箱验证码的账号将会提示缺失接码配置。</p>
                )}
                {missingEmailCount > 0 && (
                  <p>待处理账号中有 {missingEmailCount} 个缺少邮箱，这些账号需先在卡片凭据中补充邮箱或手动登录。</p>
                )}
              </div>
            );
          })()}
        </fieldset>
        {running ? (
          <div role="status" className="mt-4 space-y-2 text-sm text-secondary">
            <p>{active?.message ?? `正在提交${verb}任务…`}</p>
            <Progress aria-label={`${verb}进度`} value={100 * (active?.progress ?? 0)} />
            <p className="text-muted">关闭窗口后任务继续运行，可在任务中心查看。</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {busy && <p role="status" className="text-sm text-muted">已有账号查询在执行，可在任务中心查看。</p>}
            {!error && interrupted && (
              <p role="status" className="text-sm text-muted">上次任务已中断，可重新开始。</p>
            )}
            {(error || (!interrupted && latest && latest.state !== "succeeded")) && (
              <p role="alert" className="text-sm text-danger">{error ?? latest?.error?.message ?? latest?.message ?? "任务未完成"}</p>
            )}
            {result && (
              <section aria-label="上次完成的任务结果" className="rounded-control border border-line p-3">
                <p className="mb-2 text-sm font-medium">上次完成的任务结果</p>
                <AccountCheckResults result={result} accountLabel={(id) => accountLabeler(id).label} />
              </section>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭窗口</Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>开始{verb}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
