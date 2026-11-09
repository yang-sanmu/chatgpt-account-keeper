import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { AccountPlanCheckResult } from "@/ipc/types";
import { displayEmail, shortId } from "@/lib/format";
import { describeError } from "@/lib/notify";
import { proxyNodeOptions } from "@/lib/proxy-node-labels";
import { useKeeperStore } from "@/store/keeperStore";

interface Props {
  title: string;
  ids: string[];
  allIds?: string[];
  onClose: () => void;
}

export function AccountPlanDialog({ title, ids, allIds, onClose }: Props) {
  const proxies = useKeeperStore((s) => s.proxies);
  const active = useKeeperStore((s) => s.operations.find((op) => op.kind === "account-plan-check" &&
    (op.state === "queued" || op.state === "running")));
  const runOperation = useKeeperStore((s) => s.runOperation);
  const accounts = useKeeperStore((s) => s.accounts);
  const revealed = useKeeperStore((s) => s.emailsRevealed);
  const [proxyId, setProxyId] = useState("");
  const [all, setAll] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AccountPlanCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = all && allIds ? allIds : ids;
  const options = proxyNodeOptions(proxies);

  const run = async () => {
    const [first, ...rest] = selected;
    if (!first) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const operation = await runOperation("accounts.checkPlans", { ids: [first, ...rest], proxyId });
      setResult(operation.result as AccountPlanCheckResult);
    } catch (cause) {
      setError(describeError(cause).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>本次查询的所有账号使用同一个节点。缺少 accessToken 的账号可先巡检。</DialogDescription>
        </DialogHeader>
        <fieldset disabled={running || !!active} className="mt-4 space-y-3">
          {allIds && allIds.length !== ids.length && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
              查询全部账号（{allIds.length} 个）
            </label>
          )}
          <div className="text-sm text-secondary">本次查询 {selected.length} 个账号</div>
          <div className="space-y-1.5">
            <Label htmlFor="account-plan-node">查询节点</Label>
            <SearchableSelect id="account-plan-node" label="选择节点" options={options} value={proxyId} onValueChange={setProxyId} />
            {options.length === 0 && <p className="text-sm text-muted">请先在代理管理中启用可用节点。</p>}
          </div>
        </fieldset>
        {(running || active) && (
          <div role="status" className="mt-4 space-y-2 text-sm text-secondary">
            <p>{active?.message ?? "正在提交查询任务…"}</p>
            <Progress value={100 * (active?.progress ?? 0)} />
            <p className="text-muted">关闭窗口后，可在任务中心的「全部」查看查询结果。</p>
          </div>
        )}
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        {result && (
          <div role="status" className="mt-4 space-y-2 text-sm">
            <p>查询完成，共 {result.total} 个账号，成功 {result.succeeded} 个，失败 {result.failures.length} 个。</p>
            {result.failures.length > 0 && (
              <ul className="max-h-48 space-y-1 overflow-auto text-secondary">
                {result.failures.map(({ id, detail }) => {
                  const account = accounts[id]?.effective;
                  const name = account?.email ? displayEmail(account.email, revealed) : account?.note || shortId(id);
                  return <li key={id} className="break-words">{name} · {detail}</li>;
                })}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭窗口</Button>
          <Button disabled={running || !!active || selected.length === 0 || !options.some(({ value }) => value === proxyId)}
            onClick={() => void run()}>开始查询</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
