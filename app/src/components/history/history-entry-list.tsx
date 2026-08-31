import * as React from "react";
import type { HistoryEntryResult } from "@/ipc/generated";
import { formatDate, formatDateTime } from "@/lib/format";
import { describeEntryPreview, summarizeEntry } from "@/lib/history-summary";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { Bubble } from "./bubble";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

export interface HistoryEntryListProps {
  entries: HistoryEntryResult[];
  onCopy: (text: string) => void;
  /// 吸顶日期条的背景。必须与容器背景一致，否则滚动时会露出一条颜色不同的带子 ——
  /// 历史页在 bg-panel 上，抽屉在 bg-overlay 上。
  stickyBackgroundClass?: string;
}

function HistoryEntryRow({
  entry,
  onCopy,
}: {
  entry: HistoryEntryResult;
  onCopy: (text: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const summary = summarizeEntry(entry);
  const preview = describeEntryPreview(entry);
  const isOk = summary.outcome === "ok";
  const isFailed = summary.outcome === "failed";

  return (
    <div className="bg-sunken rounded-panel border border-subtle overflow-hidden transition-colors">
      {/* 默认折叠为单行概览 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-hover",
          expanded && "border-b border-subtle bg-panel/60"
        )}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted transition-transform duration-150",
              expanded && "rotate-90 text-primary"
            )}
          />
          <StatusDot status={isOk ? "ok" : isFailed ? "failed" : "unknown"} />
          <span className="font-medium text-xs text-primary truncate" title={preview}>
            {preview}
          </span>
          {isFailed && (
            <Badge variant="danger" className="shrink-0 h-4 px-1 py-0 text-2xs">
              失败
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2.5 shrink-0 text-muted text-xs tabular">
          <span
            className="text-secondary truncate max-w-[140px] hidden sm:inline"
            title={summary.headline}
          >
            {summary.headline}
          </span>
          <span>{formatDateTime(entry.time, { seconds: true })}</span>
        </div>
      </button>

      {/* 展开后显示完整问答与轮次 */}
      {expanded && (
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between text-xs pb-2 border-b border-subtle">
            <span className="font-medium text-primary">
              主题: {entry.topic || entry.setName || "未知主题"}
            </span>
            <span className="text-secondary tabular">{summary.headline}</span>
          </div>

          {entry.error && (
            <div className="text-xs text-danger bg-danger-soft p-2 rounded-control">
              异常: {entry.error}
            </div>
          )}

          {entry.rounds && entry.rounds.length > 0 ? (
            <div className="space-y-4 pt-1">
              {entry.rounds.map((round, rIdx) => (
                <div key={rIdx} className="space-y-2">
                  <Bubble side="question" text={round.question} onCopy={onCopy} />
                  <Bubble side="answer" text={round.answer} onCopy={onCopy} />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted italic">本条记录缺少内容</div>
          )}
        </div>
      )}
    </div>
  );
}

/// 历史问答记录列表（按天分组）。
///
/// 提取自原有 history-page，供全量历史页与账号卡片抽屉共用，避免两处渲染逻辑漂移。
export function HistoryEntryList({
  entries,
  onCopy,
  stickyBackgroundClass = "bg-panel",
}: HistoryEntryListProps) {
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
    <div className="space-y-6">
      {groups.map(([date, dayEntries]) => (
        <div key={date} className="space-y-3">
          <div
            className={cn(
              "sticky top-0 z-10 border-b border-subtle py-1.5 text-xs font-medium text-secondary",
              stickyBackgroundClass
            )}
          >
            {date}
          </div>
          <div className="space-y-2">
            {dayEntries.map((entry, idx) => (
              <HistoryEntryRow key={idx} entry={entry} onCopy={onCopy} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
