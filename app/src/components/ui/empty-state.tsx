import * as React from "react"
import { cn } from "@/lib/utils"

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}

/// title 与 description 都是必填。
///
/// 强制填写是为了挡住「暂无数据」这类空状态：它没告诉用户为什么空、也没说下一步做什么。
/// 一个空列表可能是真的没有、也可能是筛选过头了或者请求失败了，三种情况的下一步完全不同。
export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-[200px] flex-col items-center justify-center rounded-panel border border-dashed border-line bg-app p-8 text-center",
        className
      )}
      {...props}
    >
      {icon && <div className="mb-4 text-muted [&_svg]:size-8">{icon}</div>}
      <h3 className="mb-1 text-sm font-semibold text-primary">{title}</h3>
      <p className="mb-4 text-xs text-muted max-w-sm">{description}</p>
      {action && <div>{action}</div>}
    </div>
  )
}
