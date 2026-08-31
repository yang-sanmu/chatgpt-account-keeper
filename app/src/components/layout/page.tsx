import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /// 右上角的页面级动作。
  actions?: React.ReactNode;
}

/// 页面标题栏。
///
/// children 与 actions 等价看待，都渲染到右上角。原来只渲染 actions，而 Profile 页和会话
/// 策略页把按钮当 children 传进来 —— 那两个页面的主按钮在运行的程序里根本不存在。
/// 一个组件静默丢掉传给它的内容是个陷阱，接受两种写法比要求所有调用方记住区别更可靠。
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: PageHeaderProps) {
  const trailing = actions ?? children;

  return (
    <div
      className={cn(
        "mb-5 flex shrink-0 items-start justify-between gap-4 border-b border-subtle pb-4",
        className
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-primary">{title}</h1>
        {description && <p className="text-xs leading-relaxed text-secondary">{description}</p>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}

export type PageBodyProps = React.HTMLAttributes<HTMLDivElement>;

/// 页面的唯一纵向滚动容器。
export function PageBody({ className, children, ...props }: PageBodyProps) {
  return (
    <div className={cn("scroll-slim min-h-0 flex-1 overflow-y-auto", className)} {...props}>
      {children}
    </div>
  );
}

/// 页面外壳。统一内边距，页面自己不要再加 p-*。
export function Page({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex h-full min-h-0 flex-1 flex-col overflow-hidden p-6", className)}
      {...props}
    >
      {children}
    </div>
  );
}
