import * as React from "react";
import { Copy, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { excerptText } from "@/lib/history-summary";

export interface BubbleProps {
  side: "question" | "answer";
  text: string | null | undefined;
  onCopy: (text: string) => void;
}

/// 一条问答气泡。
///
/// 取不到内容时显示「本条记录缺少内容」。
/// 长文本默认折叠为摘要，点击「展开全文」显示完整内容；复制按钮始终复制完整全文。
export function Bubble({ side, text, onCopy }: BubbleProps) {
  const hasText = typeof text === "string" && text.trim().length > 0;
  const isQuestion = side === "question";
  const [expanded, setExpanded] = React.useState(false);

  // 提问通常较短，回答较长；长于阈值时自动折叠
  const limit = isQuestion ? 200 : 140;
  const excerptResult = React.useMemo(() => excerptText(text, limit), [text, limit]);

  const displayText = hasText
    ? excerptResult.truncated && !expanded
      ? excerptResult.excerpt
      : excerptResult.full
    : "本条记录缺少内容";

  return (
    <div className={cn("flex", isQuestion ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "group relative max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words",
          isQuestion
            ? "rounded-tr-sm bg-accent text-accent-content"
            : "rounded-tl-sm border border-subtle bg-panel text-primary",
          !hasText && "text-muted italic"
        )}
      >
        <div>{displayText}</div>

        {hasText && excerptResult.truncated && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className={cn(
                "inline-flex items-center gap-1 text-xs cursor-pointer select-none transition-colors",
                isQuestion
                  ? "text-accent-content/85 hover:text-accent-content underline"
                  : "text-accent hover:text-accent-hover font-medium"
              )}
            >
              {expanded ? (
                <>
                  收起 <ChevronUp className="size-3" />
                </>
              ) : (
                <>
                  展开全文 <ChevronDown className="size-3" />
                </>
              )}
            </button>
          </div>
        )}

        {hasText && (
          <button
            type="button"
            onClick={() => onCopy(excerptResult.full)}
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
