import { cn } from "@/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"

const statusDotVariants = cva("size-2 rounded-full", {
  variants: {
    status: {
      ok: "bg-ok",
      needs_login: "bg-warn",
      waf: "bg-danger",
      unknown: "bg-idle",
      disabled: "bg-idle opacity-50",
      busy: "bg-info animate-pulse",
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
