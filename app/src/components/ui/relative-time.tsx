import { useTick } from "@/lib/useTick";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface RelativeTimeProps {
  /// ISO 时间戳。null / undefined 时显示占位文案。
  value: string | null | undefined;
  className?: string;
  /// 没有时间时显示什么。默认交给 formatRelative（「未安排」）。
  fallback?: string;
}

/// 会自己走动的相对时间。
///
/// 订阅心跳的是这个叶子组件，而不是它的父卡片 —— 心跳因此只唤醒一个 span。把 useTick 放到
/// 卡片层会让每 30 秒重渲染 28 张完整卡片，正好抹掉「一条事件只重渲染一张卡」这个性质。
///
/// 绝对时间戳（含秒）放在 title 里：只显示「3 分钟前」时用户无法判断这是哪一次的结果，
/// 而两个都占位置又太挤。
export function RelativeTime({ value, className, fallback }: RelativeTimeProps) {
  useTick();

  if (!value && fallback) {
    return <span className={className}>{fallback}</span>;
  }

  return (
    <time
      dateTime={value ?? undefined}
      title={formatDateTime(value, { seconds: true })}
      className={cn("tabular", className)}
    >
      {formatRelative(value)}
    </time>
  );
}
