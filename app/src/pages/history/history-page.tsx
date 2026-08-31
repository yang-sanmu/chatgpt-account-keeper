import * as React from "react";
import { Page, PageHeader } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import { useAccountLabeler } from "@/store/selectors";
import { useAccountHistory } from "@/store/useAccountHistory";
import { describeLastRun } from "@/lib/history-summary";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";
import { LastRunSummary, HistoryEntryList } from "@/components/history";
import { SearchX, MessageSquare, AlertCircle, RefreshCw, Search } from "lucide-react";
import { RelativeTime } from "@/components/ui/relative-time";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

export function HistoryPage() {
  const historyAccounts = useKeeperStore((s) => s.historyAccounts);
  const historyFocusAccountId = useKeeperStore((s) => s.historyFocusAccountId);
  const refreshHistoryAccounts = useKeeperStore((s) => s.refreshHistoryAccounts);
  const accountLabeler = useAccountLabeler();

  const [search, setSearch] = React.useState("");
  const [failedOnly, setFailedOnly] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const [selectedAccountId, setSelectedAccountId] = React.useState<string | null>(
    historyFocusAccountId ?? (historyAccounts[0]?.accountId ?? null)
  );

  React.useEffect(() => {
    if (historyFocusAccountId && historyFocusAccountId !== selectedAccountId) {
      setSelectedAccountId(historyFocusAccountId);
    }
  }, [historyFocusAccountId, selectedAccountId]);

  // 当账号列表初始加载且没有默认选中时，自动选中第一项
  React.useEffect(() => {
    if (!selectedAccountId && historyAccounts.length > 0 && historyAccounts[0]) {
      setSelectedAccountId(historyAccounts[0].accountId);
    }
  }, [selectedAccountId, historyAccounts]);

  const filteredAccounts = React.useMemo(() => {
    return historyAccounts.filter((acc) => {
      const { outcome } = describeLastRun(acc.lastOk);
      if (failedOnly && outcome !== "failed") return false;
      if (!search.trim()) return true;
      const query = search.trim().toLowerCase();
      const { label } = accountLabeler(acc.accountId);
      const note = acc.note?.toLowerCase() ?? "";
      const accountId = acc.accountId.toLowerCase();
      return (
        label.toLowerCase().includes(query) ||
        note.includes(query) ||
        accountId.includes(query)
      );
    });
  }, [historyAccounts, failedOnly, search, accountLabeler]);

  const { entries, loading, failed, reload } = useAccountHistory(selectedAccountId);

  // 进入页面时拉一次账号摘要。
  //
  // 只拉摘要，不调 reload()：useAccountHistory 自己已经在 accountId 变化时取过条目了，
  // 这里再调一次就是对同一份数据发两个并发请求。
  React.useEffect(() => {
    void refreshHistoryAccounts();
  }, [refreshHistoryAccounts]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshHistoryAccounts();
      reload();
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    notify.success("已复制内容");
  };

  const newestEntry = entries.length > 0 ? entries[0] : null;

  return (
    <Page>
      <PageHeader
        title="对话历史"
        description="查看各个账号与 ChatGPT 的对话记录与巡检细节"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
          >
            <RefreshCw className={cn("mr-1.5 size-3.5", (refreshing || loading) && "animate-spin")} />
            刷新
          </Button>
        }
      />
      <div className="flex gap-6 h-full min-h-0">
        {/* Left pane: Accounts */}
        <div className="w-80 shrink-0 flex flex-col border border-subtle rounded-panel bg-panel overflow-hidden">
          {/* Header & Filter Controls */}
          <div className="p-3 border-b border-subtle bg-sunken space-y-2.5">
            <div className="flex items-center justify-between text-xs font-medium text-secondary">
              <span>账号列表 ({filteredAccounts.length})</span>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="history-failed-only"
                  checked={failedOnly}
                  onCheckedChange={setFailedOnly}
                />
                <Label htmlFor="history-failed-only" className="text-2xs text-secondary cursor-pointer">
                  仅看失败
                </Label>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2 size-3.5 text-muted" />
              <Input
                placeholder="搜索邮箱或备注..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-7.5 pl-8 text-xs"
              />
            </div>
          </div>

          <ScrollArea className="flex-1">
            {historyAccounts.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted">暂无历史记录</div>
            ) : filteredAccounts.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted">无匹配账号</div>
            ) : (
              <div className="p-2 space-y-1.5">
                {filteredAccounts.map((acc) => {
                  const isSelected = acc.accountId === selectedAccountId;
                  const { label, known } = accountLabeler(acc.accountId);
                  const { outcome, label: lastRunLabel } = describeLastRun(acc.lastOk);
                  const isFailed = outcome === "failed";
                  const isDeleted = acc.deleted || !known;

                  return (
                    <button
                      key={acc.accountId}
                      type="button"
                      onClick={() => setSelectedAccountId(acc.accountId)}
                      className={cn(
                        "w-full text-left px-3 py-2.5 rounded-control text-xs transition-colors border",
                        isSelected
                          ? "bg-accent-soft border-accent/40 text-accent"
                          : isFailed
                          ? "border-danger bg-danger-soft text-primary hover:bg-hover"
                          : "border-transparent text-primary hover:bg-hover",
                        isFailed && !isSelected && "border-l-2 border-l-danger"
                      )}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <StatusDot
                            status={
                              outcome === "ok" ? "ok" : outcome === "failed" ? "failed" : "unknown"
                            }
                          />
                          <span
                            className={cn("truncate font-medium", isDeleted && "text-muted")}
                            title={`${label} · ${lastRunLabel}`}
                          >
                            {label}
                          </span>
                        </div>
                        {isDeleted && (
                          <Badge variant="neutral" className="h-4 shrink-0 px-1 py-0 text-2xs">
                            已删除
                          </Badge>
                        )}
                        {isFailed && (
                          <Badge variant="danger" className="h-4 shrink-0 px-1 py-0 text-2xs">
                            失败
                          </Badge>
                        )}
                      </div>

                      {acc.note && acc.note.trim().length > 0 && (
                        <div className="text-2xs text-muted truncate mt-1" title={acc.note}>
                          {acc.note}
                        </div>
                      )}

                      <div className="text-2xs text-muted flex justify-between mt-1 tabular">
                        <span>{acc.entryCount} 条记录</span>
                        {acc.lastAt && <RelativeTime value={acc.lastAt} />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right pane: Entries */}
        <div className="flex-1 border border-subtle rounded-panel bg-panel overflow-hidden flex flex-col">
          <ScrollArea className="flex-1">
            <div className="p-6">
              {!selectedAccountId ? (
                <EmptyState
                  icon={<MessageSquare />}
                  title="未选择账号"
                  description="请从左侧列表中选择一个账号以查看其对话历史。"
                />
              ) : loading ? (
                <div className="space-y-6">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : failed ? (
                <div className="py-12 flex flex-col items-center justify-center text-center space-y-3">
                  <AlertCircle className="size-8 text-danger" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-primary">加载历史记录失败</p>
                    <p className="text-xs text-muted">无法获取该账号的历史数据，请重试</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={reload} className="mt-2">
                    <RefreshCw className="mr-1.5 size-3.5" />
                    重新加载
                  </Button>
                </div>
              ) : entries.length === 0 ? (
                <EmptyState
                  icon={<SearchX />}
                  title="没有记录"
                  description="该账号暂无详细对话记录。"
                />
              ) : (
                <div className="space-y-6">
                  {newestEntry && <LastRunSummary entry={newestEntry} />}
                  <HistoryEntryList entries={entries} onCopy={handleCopy} />
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Page>
  );
}
