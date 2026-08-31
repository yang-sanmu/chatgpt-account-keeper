import { Toaster as Sonner } from "sonner"
import * as React from "react"
import { resolveTheme } from "@/lib/theme"
import { useKeeperStore } from "@/store/keeperStore"

type ToasterProps = React.ComponentProps<typeof Sonner>

/// 全局通知容器。
///
/// 浮在窗口顶部而不是底部：账号页有吸底的批量操作栏，底部通知会被它压住或互相遮挡。
///
/// theme 必须显式传给 sonner。它自己的默认值是 light，不会跟随我们加在 <html> 上的 dark
/// class —— 不传的话深色界面上会弹出一个白底提示。
function Toaster(props: ToasterProps) {
  const theme = useKeeperStore((state) => state.desktopSettings.theme)

  return (
    <Sonner
      theme={resolveTheme(theme)}
      position="top-center"
      // 关掉 richColors：它会用 sonner 内置的颜色，绕过我们的令牌。
      richColors={false}
      toastOptions={{
        classNames: {
          toast:
            "!bg-overlay !border-subtle !text-primary !shadow-overlay !rounded-panel !font-sans !text-base !gap-3",
          title: "!text-primary !font-medium",
          description: "!text-secondary !text-xs",
          icon: "!size-4",
          success: "[&_[data-icon]]:!text-ok",
          error: "[&_[data-icon]]:!text-danger",
          warning: "[&_[data-icon]]:!text-warn",
          info: "[&_[data-icon]]:!text-info",
          actionButton: "!bg-accent !text-accent-content !border-0",
          cancelButton: "!bg-panel !text-secondary !border !border-subtle",
          closeButton: "!bg-panel !border-subtle !text-secondary hover:!text-primary",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
