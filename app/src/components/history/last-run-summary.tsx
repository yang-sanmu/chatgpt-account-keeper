import type { HistoryEntryResult } from "@/ipc/generated";
import { summarizeEntry } from "@/lib/history-summary";
import { RelativeTime } from "@/components/ui/relative-time";
import { CheckCircle2, AlertCircle, HelpCircle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LastRunSummaryProps {
  entry: HistoryEntryResult;
  className?: string;
}

/// 最后一次运行摘要块。
///
/// 提取最新记录的 ok / stopReason / error / needReauth 状态并以醒目卡片呈现。
/// 失败时采用 danger 警示风格，当 needsReauth 为真时特别标明（这是唯一需要用户亲自介入的失败）。
export function LastRunSummary({ entry, className }: LastRunSummaryProps) {
  const summary = summarizeEntry(entry);
  const isOk = summary.outcome === "ok";
  const isFailed = summary.outcome === "failed";

  return (
    <div
      className={cn(
        "rounded-panel p-3.5 border transition-colors",
        isOk && "border-ok/40 bg-ok-soft",
        isFailed && "border-danger bg-danger-soft",
        !isOk && !isFailed && "bg-sunken border-subtle",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-sm">
          {isOk && <CheckCircle2 className="size-4 text-ok shrink-0" />}
          {isFailed && <AlertCircle className="size-4 text-danger shrink-0" />}
          {!isOk && !isFailed && <HelpCircle className="size-4 text-muted shrink-0" />}
          <span
            className={cn(
              isOk && "text-ok",
              isFailed && "text-danger",
              !isOk && !isFailed && "text-primary"
            )}
          >
            最后一次运行: {isOk ? "成功" : isFailed ? "失败" : "未知"}
          </span>
        </div>
        {entry.time && (
          <RelativeTime
            value={entry.time}
            className="text-xs text-muted"
          />
        )}
      </div>

      <div className="mt-1.5 text-xs text-secondary leading-relaxed">
        {summary.headline}
      </div>

      {summary.needsReauth && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-chip bg-danger-soft px-2.5 py-1.5 text-xs font-medium text-danger border border-danger/30">
          <ShieldAlert className="size-4 shrink-0" />
          <span>认证已失效，需要手动重新登录此账号</span>
        </div>
      )}
    </div>
  );
}
