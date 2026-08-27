import { cn } from "@/lib/utils"
import * as React from "react"

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-control bg-sunken", className)}
      {...props}
    />
  )
}

export { Skeleton }
