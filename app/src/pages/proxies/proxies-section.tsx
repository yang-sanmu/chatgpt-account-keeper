import * as React from "react";
import { useKeeperStore } from "@/store/keeperStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { DownloadCloud, RefreshCw, Activity, Link2, Loader2, Play } from "lucide-react";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui/relative-time";
import { formatDateTime } from "@/lib/format";
import { agentCall, newCommandId } from "@/ipc/bridge";

export function ProxiesSection() {
  const proxies = useKeeperStore((s) => s.proxies);
  const runOperation = useKeeperStore((s) => s.runOperation);
  const [subUrl, setSubUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [testingAll, setTestingAll] = React.useState(false);

  const handleImport = async () => {
    if (!subUrl.trim()) return notify.warning("URL 不能为空", "请输入订阅链接");
    setImporting(true);
    try {
      await runOperation("proxies.importSubscription", { url: subUrl.trim() });
      notify.success("导入成功", "已成功拉取代理订阅");
      setSubUrl("");
    } catch (error) {
      notify.error("导入失败", error);
    } finally {
      setImporting(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await runOperation("proxies.refreshSubscription", {});
      notify.success("刷新成功", "已更新代理订阅");
    } catch (error) {
      notify.error("刷新失败", error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      await runOperation("proxies.testAll", {});
      notify.success("测速完成", "所有启用节点的连通性测试已完成");
    } catch (error) {
      notify.error("测速失败", error);
    } finally {
      setTestingAll(false);
    }
  };

  const handleToggleNode = async (id: string, enabled: boolean) => {
    try {
      const cid = await newCommandId();
      await agentCall("proxies.setNodeEnabled", { id, enabled }, cid);
    } catch (error) {
      notify.error("切换状态失败", error);
    }
  };

  const handleTestNode = async (id: string) => {
    try {
      await runOperation("proxies.testNode", { id });
    } catch {
      // 这里刻意不弹错误提示。
      //
      // 节点测不通是测速的**正常结果**，而不是操作失败：结果会通过 proxyNode.tested 事件
      // 回填成那一行的 latencyOk=false + 失败原因，用户在行里就能看到。再弹一个红色提示
      // 等于同一件事说两遍，而批量测速时会一次弹出十几个。
    }
  };

  const formatLatency = (ms: number | null, ok: boolean | null) => {
    if (ok === null) return <span className="text-muted">未测速</span>;
    if (ok === false) return <span className="text-danger">失败</span>;
    if (ms === null) return <span className="text-muted">—</span>;
    
    let colorClass = "text-danger";
    if (ms < 200) colorClass = "text-ok";
    else if (ms < 500) colorClass = "text-warn";
    else colorClass = "text-danger";
    
    return <span className={cn("tabular", colorClass)}>{ms} ms</span>;
  };

  const mihomoState = proxies.status.running ? "ok" : "unknown";
  const mihomoLabel = proxies.status.running ? "Mihomo 运行中" : "Mihomo 未运行";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-primary">代理节点与订阅</h2>
        <Badge variant="outline" className="font-normal border-subtle bg-sunken flex gap-1.5 items-center">
          <StatusDot status={mihomoState} label={mihomoLabel} />
          {proxies.status.running && (
            <span className="text-muted ml-2 border-l border-subtle pl-2">
              基础端口: {proxies.status.basePort}
              {proxies.status.basePortShifted && <span className="text-warn ml-1">(已偏移)</span>}
            </span>
          )}
        </Badge>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[300px] flex gap-2">
              <div className="relative flex-1">
                <Link2 className="absolute left-2.5 top-2 size-4 text-muted" />
                <Input
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                  placeholder="粘贴订阅链接导入..."
                  className="pl-8"
                  onKeyDown={(e) => {
                    if (e.code === "Enter" && subUrl) void handleImport();
                  }}
                />
              </div>
              <Button onClick={handleImport} disabled={importing || !subUrl.trim()}>
                {importing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <DownloadCloud className="mr-2 size-4" />}
                导入
              </Button>
            </div>

            <div className="h-8 w-px bg-subtle hidden sm:block" />

            <div className="flex items-center gap-2">
              {proxies.subscription?.configured ? (
                <div className="flex flex-col mr-4">
                  <span className="text-xs text-secondary truncate max-w-[200px]" title={proxies.subscription.host}>
                    {proxies.subscription.host}
                  </span>
                  <span className="text-xs text-muted">
                    最后更新: <RelativeTime value={proxies.subscription.updatedAt} fallback="—" />
                  </span>
                </div>
              ) : (
                <span className="text-xs text-muted mr-4">无当前订阅</span>
              )}

              <Button
                variant="outline"
                onClick={handleRefresh}
                disabled={refreshing || !proxies.subscription?.configured}
              >
                <RefreshCw className={cn("mr-2 size-4", refreshing && "animate-spin")} />
                刷新
              </Button>
              <Button
                variant="outline"
                onClick={handleTestAll}
                disabled={testingAll || proxies.nodes.length === 0}
              >
                <Activity className={cn("mr-2 size-4", testingAll && "animate-pulse")} />
                全部测速
              </Button>
            </div>
          </div>

          <div className="border border-line rounded-panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-sunken border-b border-subtle">
                <tr>
                  <th className="text-left font-normal text-muted px-4 py-2 w-12">状态</th>
                  <th className="text-left font-normal text-muted px-4 py-2">节点名称</th>
                  <th className="text-left font-normal text-muted px-4 py-2 w-48">服务器</th>
                  <th className="text-left font-normal text-muted px-4 py-2 w-24">协议</th>
                  <th className="text-left font-normal text-muted px-4 py-2 w-24">本地端口</th>
                  <th className="text-left font-normal text-muted px-4 py-2 w-24">延迟</th>
                  <th className="text-right font-normal text-muted px-4 py-2 w-16">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle bg-panel">
                {proxies.nodes.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-muted py-8">暂无节点，请先导入订阅</td>
                  </tr>
                ) : (
                  proxies.nodes.map((node) => (
                    <tr key={node.id} className={cn(!node.enabled && "opacity-60")}>
                      <td className="px-4 py-2">
                        <Switch
                          checked={node.enabled}
                          onCheckedChange={(c) => handleToggleNode(node.id, c)}
                          aria-label="启用/停用节点"
                        />
                      </td>
                      <td className="px-4 py-2 truncate max-w-[200px]" title={node.name}>
                        {node.name}
                      </td>
                      <td className="px-4 py-2 truncate text-secondary" title={node.server ? `${node.server}:${node.port}` : ""}>
                        {node.server ? `${node.server}:${node.port}` : "—"}
                      </td>
                      <td className="px-4 py-2 text-secondary">
                        {node.type || "—"}
                      </td>
                      <td className="px-4 py-2 text-secondary tabular">
                        {node.localPort || "—"}
                      </td>
                      <td className="px-4 py-2" title={node.latencyTestedAt ? `测于: ${formatDateTime(node.latencyTestedAt, { seconds: true })}\n${node.latencyMessage || ""}` : ""}>
                        {formatLatency(node.latencyMs, node.latencyOk)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleTestNode(node.id)}
                          aria-label="测速"
                        >
                          <Play className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
