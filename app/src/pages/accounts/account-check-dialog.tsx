import { useState } from "react";
import { AccountCheckResults } from "@/components/account-check-results";
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
  kind: "inspection" | "promo" | "singlePlan";
  ids: string[];
  scope: "filtered" | "selected" | "single";
}

function latestOperation(operations: Operation[]) {
  return operations.reduce<Operation | undefined>((latest, operation) =>
    !latest || operation.startedAt > latest.startedAt ? operation : latest, undefined);
}

export function AccountCheckDialog({ title, kind, ids, scope, onClose }: AccountCheckTarget & { onClose: () => void }) {
  const proxies = useKeeperStore((s) => s.proxies);
  const operations = useKeeperStore((s) => s.operations);
  const allIds = useKeeperStore((s) => s.accountIds);
  const runOperation = useKeeperStore((s) => s.runOperation);
  const accountLabeler = useAccountLabeler();
  const inspection = kind === "inspection";
  const single = kind === "singlePlan";
  const subject = single ? "套餐" : "Plus 优惠资格";
  const verb = inspection ? "巡检" : "查询";
  const [selection, setSelection] = useState("initial");
  const [useSpecifiedNode, setUseSpecifiedNode] = useState(!inspection);
  const [proxyId, setProxyId] = useState("");
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
    (inspection ? operation.kind === ACCOUNT_CHECK_KINDS.inspection
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
        ? await runOperation("accounts.inspect", { ids, ...(useSpecifiedNode ? { proxyId } : {}) })
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
            ? "检查登录状态并更新 accessToken。"
            : `使用已有 accessToken 通过所选节点查询${subject}。缺少凭据的账号可先巡检。`}</DialogDescription>
        </DialogHeader>
        <fieldset hidden={running} disabled={submitting || busy} className="mt-4 space-y-3">
          {!single && (
            <div className="space-y-1.5">
              <Label htmlFor="account-check-scope">执行范围</Label>
              <select id="account-check-scope" className="block w-full rounded-md border border-line bg-sunken px-3 py-2 text-sm"
                value={selection} onChange={(event) => setSelection(event.target.value)}>
                <option value="initial">{scope === "filtered" ? "当前筛选结果" : "已勾选账号"}</option>
                {!inspection && scope === "filtered" && <option value="all">全部账号（{allIds.length} 个）</option>}
                <option value="failed" disabled={!failedIds.length}>上次失败所有项（{failedIds.length} 个）</option>
              </select>
            </div>
          )}
          <p className="text-sm text-secondary">本次{verb} {selected.length} 个账号</p>
          {inspection && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">巡检节点</legend>
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
              <Label htmlFor="account-check-node">{inspection ? "本次巡检使用的节点" : "查询节点"}</Label>
              <SearchableSelect id="account-check-node" label="选择节点" options={options} value={proxyId} onValueChange={setProxyId} />
              {options.length === 0 && <p className="text-sm text-muted">请先在代理管理中启用可用节点。</p>}
            </div>
          )}
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
