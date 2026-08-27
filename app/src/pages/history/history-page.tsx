import * as React from "react";
import { useEffect, useState } from "react";
import { Page, PageHeader } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import { agentCall } from "@/ipc/bridge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchX, MessageSquare, Copy } from "lucide-react";
import { formatDate, formatDateTime, displayEmail } from "@/lib/format";
import { notify } from "@/lib/notify";
import type { HistoryEntryResult } from "@/ipc/generated";
import { cn } from "@/lib/utils";

/// 一条问答气泡。
///
/// 取不到内容时显示「本条记录缺少内容」而不是空气泡或原始 JSON：历史记录的 rounds 里
/// question / answer 都可能缺失（对话中断、解析失败），把 undefined 渲染成空白会让用户
/// 以为记录损坏了，而把整个对象打印出来则是把内部结构泄给用户看。
function Bubble({
  side,
  text,
  onCopy,
}: {
  side: "question" | "answer";
  text: string | null | undefined;
  onCopy: (text: string) => void;
}) {
  const hasText = typeof text === "string" && text.trim().length > 0;
  const isQuestion = side === "question";

  return (
    <div className={cn("flex", isQuestion ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "group relative max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap",
          isQuestion
            ? "rounded-tr-sm bg-accent text-accent-content"
            : "rounded-tl-sm border border-subtle bg-panel text-primary",
          !hasText && "text-muted italic"
        )}
      >
        {hasText ? text : "本条记录缺少内容"}
        {hasText && (
          <button
            type="button"
            onClick={() => onCopy(text)}
            aria-label={isQuestion ? "复制提问" : "复制回复"}
            className={cn(
              "absolute top-1.5 right-1.5 rounded-chip p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
              isQuestion
                ? "bg-accent-content/15 text-accent-content hover:bg-accent-content/25"
                : "bg-hover text-secondary hover:text-primary"
            )}
          >
            <Copy className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export function HistoryPage() {
  const historyAccounts = useKeeperStore((s) => s.historyAccounts);
  const emailsRevealed = useKeeperStore((s) => s.emailsRevealed);
  const historyFocusAccountId = useKeeperStore((s) => s.historyFocusAccountId);
  
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(historyFocusAccountId);
  const [entries, setEntries] = useState<HistoryEntryResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (historyFocusAccountId && historyFocusAccountId !== selectedAccountId) {
      setSelectedAccountId(historyFocusAccountId);
    }
  }, [historyFocusAccountId, selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId) {
      setEntries([]);
      return;
    }
    
    let cancelled = false;
    setLoading(true);
    
    agentCall("history.query", { accountId: selectedAccountId, limit: 100 })
      .then((res) => {
        if (!cancelled) {
          setEntries(res);
        }
      })
      .catch((err) => {
        if (!cancelled) notify.error("加载历史记录失败", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
      
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId]);

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    notify.success("已复制内容");
  };

  // 按天分组。同一天的多次巡检记录归到一个日期标题下，否则几十条记录连成一片。
  const groups = React.useMemo(() => {
    const map = new Map<string, HistoryEntryResult[]>();
    for (const entry of entries) {
      const date = formatDate(entry.time);
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(entry);
    }
    return Array.from(map.entries());
  }, [entries]);

  return (
    <Page className="p-6">
      <PageHeader
        title="对话历史"
        description="查看各个账号与 ChatGPT 的对话记录与巡检细节"
      />
      <div className="flex gap-6 h-full min-h-0">
        {/* Left pane: Accounts */}
        <div className="w-64 shrink-0 flex flex-col border border-subtle rounded-panel bg-panel overflow-hidden">
          <div className="p-3 border-b border-subtle bg-sunken text-sm font-medium text-secondary">
            账号列表
          </div>
          <ScrollArea className="flex-1">
            {historyAccounts.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted">暂无历史记录</div>
            ) : (
              <div className="p-2 space-y-1">
                {historyAccounts.map((acc) => {
                  const isSelected = acc.accountId === selectedAccountId;
                  return (
                    <button
                      key={acc.accountId}
                      onClick={() => setSelectedAccountId(acc.accountId)}
                      className={`w-full text-left px-3 py-2 rounded-control text-sm transition-colors ${
                        isSelected ? "bg-accent-soft text-accent" : "text-primary hover:bg-hover"
                      }`}
                    >
                      <div className="truncate font-medium">
                        {acc.note || displayEmail(acc.email, emailsRevealed)}
                      </div>
                      <div className="text-xs text-muted flex justify-between mt-1 tabular">
                        <span>{acc.entryCount} 条</span>
                        {acc.lastAt && <span>{formatDate(acc.lastAt)}</span>}
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
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : entries.length === 0 ? (
                <EmptyState
                  icon={<SearchX />}
                  title="没有记录"
                  description="该账号暂无详细对话记录。"
                />
              ) : (
                <div className="space-y-8">
                  {groups.map(([date, dayEntries]) => (
                    <div key={date} className="space-y-4">
                      <div className="text-sm font-medium text-secondary sticky top-0 bg-panel/90 backdrop-blur py-2 border-b border-subtle z-10">
                        {date}
                      </div>
                      <div className="space-y-6">
                        {dayEntries.map((entry, idx) => (
                          <div key={idx} className="bg-sunken rounded-panel p-4 border border-subtle space-y-4">
                            <div className="flex justify-between items-center text-sm">
                              <div className="font-medium text-primary">
                                {entry.topic || entry.setName || "未知主题"}
                              </div>
                              <div className="text-muted tabular">{formatDateTime(entry.time)}</div>
                            </div>

                            {entry.error && (
                              <div className="text-sm text-danger bg-danger-soft p-2 rounded">
                                异常: {entry.error}
                              </div>
                            )}

                            {entry.rounds && entry.rounds.length > 0 ? (
                              <div className="space-y-4 pt-2">
                                {entry.rounds.map((round, rIdx) => (
                                  <div key={rIdx} className="space-y-2">
                                    <Bubble
                                      side="question"
                                      text={round.question}
                                      onCopy={handleCopy}
                                    />
                                    <Bubble
                                      side="answer"
                                      text={round.answer}
                                      onCopy={handleCopy}
                                    />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-muted italic">
                                本条记录缺少内容
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Page>
  );
}
