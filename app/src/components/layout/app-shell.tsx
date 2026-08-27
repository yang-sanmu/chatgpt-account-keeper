import * as React from "react";
import { useKeeperStore, type NavKey } from "@/store/keeperStore";
import {
  useNav,
  useConnectionStatus,
  useSchedulerControls,
  useActiveOperations,
} from "@/store/selectors";
import { cn } from "@/lib/utils";
import {
  Activity,
  Users,
  ListTodo,
  History,
  Network,
  MessageSquare,
  Box,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Play,
  Square,
  AlertCircle,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface NavItem {
  id: NavKey;
  label: string;
  icon: React.ElementType;
  showAccountCount?: boolean;
  showOpCount?: boolean;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "运行",
    items: [
      { id: "overview", label: "总览", icon: Activity },
      { id: "accounts", label: "账号", icon: Users, showAccountCount: true },
      { id: "operations", label: "任务", icon: ListTodo, showOpCount: true },
      { id: "history", label: "历史", icon: History },
    ],
  },
  {
    label: "配置",
    items: [
      { id: "proxies", label: "分组与代理", icon: Network },
      { id: "conversations", label: "会话策略", icon: MessageSquare },
      { id: "profiles", label: "Profile", icon: Box },
      { id: "settings", label: "设置", icon: Settings },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { nav, setNav, collapsed, toggleSidebar } = useNav();
  const { connection, draining } = useConnectionStatus();
  const { running, start, stop } = useSchedulerControls();
  const activeOps = useActiveOperations();
  
  const accountCount = useKeeperStore((s) => s.accountIds.length);
  const syncBootstrap = useKeeperStore((s) => s.syncBootstrap);

  // Ctrl+1..8 切换页面。
  //
  // 用 e.code 而不是 e.key：中文输入法激活时 e.key 可能不是数字字符，而 code 始终是
  // 物理键位（Digit1 / Numpad1）。
  React.useEffect(() => {
    const NAV_ORDER = NAV_GROUPS.flatMap((group) => group.items).map((item) => item.id);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;

      const match = /^(?:Digit|Numpad)([1-8])$/.exec(event.code);
      if (!match?.[1]) return;

      const target = NAV_ORDER[Number(match[1]) - 1];
      if (!target) return;

      event.preventDefault();
      setNav(target);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setNav]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-app">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col border-r border-subtle bg-panel transition-all duration-200 shrink-0",
          collapsed ? "w-[64px]" : "w-[240px]"
        )}
      >
        {/* Header/Brand */}
        <div className="flex h-14 items-center justify-between px-4 border-b border-subtle shrink-0">
          {!collapsed && (
            <span className="font-semibold text-primary truncate tracking-tight">
              ChatGPT Account Keeper
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleSidebar}
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            className={cn("text-muted shrink-0", collapsed && "mx-auto")}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </div>

        {/* Draining Notice */}
        {draining && (
          <div className="m-3 p-3 bg-warn-soft border border-warn rounded-panel flex flex-col items-center justify-center gap-2 text-warn text-sm shrink-0">
            <AlertCircle className="size-4" />
            {!collapsed && <span className="font-medium">正在排空，准备更新</span>}
          </div>
        )}

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto scroll-slim py-4 flex flex-col gap-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1 px-3">
              {!collapsed && (
                <div className="px-3 mb-1 text-xs font-medium text-muted tracking-wider">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const isActive = nav === item.id;
                const Icon = item.icon;
                let badgeContent: React.ReactNode = null;

                if (item.showAccountCount && accountCount > 0) {
                  badgeContent = accountCount;
                } else if (item.showOpCount && activeOps.length > 0) {
                  badgeContent = activeOps.length;
                }

                const button = (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    onClick={() => setNav(item.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors w-full",
                      // 选中态用 text-accent 而不是 text-accent-content：后者是给**实心**
                      // accent 背景准备的前景色（深色模式下接近黑），配在半透明的
                      // accent-soft 上几乎看不见。
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-secondary hover:bg-hover hover:text-primary",
                      collapsed && "justify-center px-0"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && (
                      <span className="flex-1 text-left truncate">{item.label}</span>
                    )}
                    {!collapsed && badgeContent !== null && (
                      <Badge variant={isActive ? "accent" : "neutral"} className="ml-auto tabular-nums leading-none">
                        {badgeContent}
                      </Badge>
                    )}
                  </button>
                );

                if (collapsed) {
                  return (
                    <Tooltip key={item.id}>
                      <TooltipTrigger asChild>{button}</TooltipTrigger>
                      <TooltipContent side="right">
                        {item.label}
                        {badgeContent !== null && ` (${badgeContent})`}
                      </TooltipContent>
                    </Tooltip>
                  );
                }
                return button;
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-subtle flex flex-col gap-2 shrink-0 bg-sunken">
          {!collapsed ? (
            <div className="flex items-center justify-between text-xs text-muted mb-1 px-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {connection.connected ? (
                  <Wifi className="size-3 text-ok shrink-0" />
                ) : (
                  <WifiOff className="size-3 text-danger shrink-0" />
                )}
                <span className="truncate">{connection.status}</span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 text-muted hover:text-primary"
                onClick={() => void syncBootstrap()}
                aria-label="手动同步"
                title="手动同步状态"
              >
                <RefreshCw className="size-3" />
              </Button>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex justify-center py-2 text-muted">
                  {connection.connected ? (
                    <Wifi className="size-4 text-ok" />
                  ) : (
                    <WifiOff className="size-4 text-danger" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div className="text-xs">
                  <div>{connection.status}</div>
                  <div className="text-muted mt-1">{connection.detail}</div>
                </div>
              </TooltipContent>
            </Tooltip>
          )}

          <Button
            variant={running ? "danger" : "default"}
            size={collapsed ? "icon" : "md"}
            className={cn("w-full shadow-none", collapsed && "mx-auto")}
            onClick={() => (running ? stop() : start())}
            aria-label={running ? "停止调度" : "启动调度"}
          >
            {running ? <Square className="size-4" /> : <Play className="size-4" />}
            {!collapsed && <span>{running ? "停止调度" : "启动调度"}</span>}
          </Button>

          {collapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mx-auto mt-1"
                  onClick={() => void syncBootstrap()}
                  aria-label="手动同步"
                >
                  <RefreshCw className="size-4 text-muted" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">手动同步状态</TooltipContent>
            </Tooltip>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-app overflow-hidden">
        {children}
      </main>
    </div>
  );
}
