import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        // bg-sunken 而不是 bg-app：输入框多数时候放在 bg-panel 的卡片里，用 app 背景色
        // 会和页面底色一致、在卡片上看不出这是个可输入的凹陷区域。
        "flex h-9 w-full rounded-control border border-subtle bg-sunken px-3 py-1 text-base text-primary transition-colors placeholder:text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Input }
