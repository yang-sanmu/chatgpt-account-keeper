import { useKeeperStore } from "@/store/keeperStore";
import { useAccountLabeler } from "@/store/selectors";
import { useAccountHistory } from "@/store/useAccountHistory";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { LastRunSummary, HistoryEntryList } from "@/components/history";
import { MessageSquare, AlertCircle, RefreshCw } from "lucide-react";
import { notify } from "@/lib/notify";

/// 账号历史记录抽屉。
///
/// 从卡片「历史」按钮打开，无需跳出账号管理页面即可查看该账号的近期 Q&A 详情与巡检结果。
export function AccountHistoryDrawer() {
  const accountId = useKeeperStore((s) => s.historyDrawerAccountId);
  const closeHistoryDrawer = useKeeperStore((s) => s.closeHistoryDrawer);
  const accountLabeler = useAccountLabeler();

  const open = accountId !== null;
  const { label, known } = accountLabeler(accountId);
  const { entries, loading, failed, reload } = useAccountHistory(accountId);

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    notify.success("已复制内容");
  };

  const newestEntry = entries.length > 0 ? entries[0] : null;

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && closeHistoryDrawer()}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col p-0 gap-0 overflow-hidden">
        {/* 头部用 bg-sunken 而不是 bg-panel：抽屉本体是 bg-overlay，panel 与它明度接近，
            分区看不出来。 */}
        <SheetHeader className="shrink-0 space-y-3 border-b border-subtle bg-sunken p-6 pb-4">
          <div className="pr-6">
            <SheetTitle className="truncate text-base font-semibold" title={label}>
              {known ? label : accountId ? `已删除账号（${label}）` : "对话历史"}
            </SheetTitle>
            {/* Radix 要求 Dialog 有 Description，缺了会在控制台告警且屏幕阅读器读不到上下文。 */}
            <SheetDescription className="mt-1 text-xs">
              这个账号最近的对话与巡检记录
            </SheetDescription>
          </div>

          {/* 最新一次运行摘要 */}
          {newestEntry && <LastRunSummary entry={newestEntry} />}
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-6">
            {loading ? (
              <div className="space-y-6">
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
                icon={<MessageSquare />}
                title="暂无历史记录"
                description="该账号尚未产生任何问答或巡检记录。"
              />
            ) : (
              <HistoryEntryList
                entries={entries}
                onCopy={handleCopy}
                stickyBackgroundClass="bg-overlay"
              />
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
