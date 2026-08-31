import { cn } from "@/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"

const statusDotVariants = cva("size-2 shrink-0 rounded-full", {
  variants: {
    status: {
      ok: "bg-ok",
      needs_login: "bg-warn",
      waf: "bg-danger",
      unknown: "bg-idle",
      disabled: "bg-idle opacity-50",
      busy: "bg-info animate-pulse",
      /// 运行失败。与 waf 同色但语义不同：waf 说的是账号被风控，failed 说的是某次运行
      /// 没跑成。历史页需要后者，借用 waf 会让「上次失败」显示成一个账号状态。
      failed: "bg-danger",
    },
  },
  defaultVariants: {
    status: "unknown",
  },
})

export interface StatusDotProps extends VariantProps<typeof statusDotVariants> {
  className?: string
  label?: string
}

export function StatusDot({ status, className, label }: StatusDotProps) {
  if (label) {
    return (
      <div className={cn("inline-flex items-center gap-2", className)}>
        <div className={cn(statusDotVariants({ status }))} />
        <span className="text-secondary text-xs">{label}</span>
      </div>
    )
  }
  return <div className={cn(statusDotVariants({ status }), className)} />
}
