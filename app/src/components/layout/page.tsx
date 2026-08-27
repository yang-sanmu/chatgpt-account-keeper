import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 shrink-0 pb-4 mb-4 border-b border-subtle",
        className
      )}
      {...props}
    >
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium tracking-tight text-primary">
          {title}
        </h1>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p className="text-sm text-secondary leading-snug">{description}</p>
      )}
    </div>
  );
}

export interface PageBodyProps extends React.HTMLAttributes<HTMLDivElement> {}

export function PageBody({ className, children, ...props }: PageBodyProps) {
  return (
    <div
      className={cn("flex-1 overflow-y-auto scroll-slim min-h-0", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function Page({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-col h-full flex-1 overflow-hidden min-h-0", className)} {...props}>
      {children}
    </div>
  );
}
