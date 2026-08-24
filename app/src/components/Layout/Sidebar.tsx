// 侧边导航栏组件
// 聚合八个功能页切换、连接状态指示与后台调度快捷开关

import React from "react";
import { useApp } from "../../state/AppContext";
import {
  IconPlay,
  IconRefresh,
  IconStop,
} from "../Common/Icons";

interface NavItem {
  id: string;
  name: string;
  badge?: number | string;
}

export const Sidebar: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    connection,
    accountsState,
    activeOperations,
    scheduler,
    toggleScheduler,
    manualRefreshBootstrap,
    draining,
  } = useApp();

  const accountsCount = accountsState.accountIds.length;
  const runningOpsCount = activeOperations.length;

  const navItems: NavItem[] = [
    { id: "overview", name: "总览" },
    { id: "accounts", name: "账号", badge: accountsCount > 0 ? accountsCount : undefined },
    { id: "operations", name: "任务", badge: runningOpsCount > 0 ? `${runningOpsCount} 运行` : undefined },
    { id: "proxies", name: "分组与代理" },
    { id: "conversations", name: "会话" },
    { id: "profiles", name: "Profile" },
    { id: "history", name: "历史" },
    { id: "settings", name: "设置" },
  ];

  return (
    <aside
      style={{
        width: "220px",
        minWidth: "220px",
        height: "100%",
        backgroundColor: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* 顶部 Brand 区域 */}
      <div>
        <div
          style={{
            padding: "20px 16px 16px 16px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--color-primary)",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "bold",
                fontSize: "14px",
              }}
            >
              K
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--text-primary)" }}>
                Account Keeper
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                ChatGPT 多账号管理
              </div>
            </div>
          </div>

          {draining && (
            <div
              style={{
                marginTop: "12px",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--color-warning-bg)",
                border: "1px solid var(--color-warning-border)",
                fontSize: "11px",
                color: "var(--color-warning)",
                lineHeight: 1.4,
              }}
            >
              ⚠️ 服务排空中（准备更新）
            </div>
          )}
        </div>

        {/* 八个导航菜单项 */}
        <nav style={{ padding: "12px 8px" }}>
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: "var(--radius-md)",
                  fontSize: "13px",
                  fontWeight: isActive ? 600 : 500,
                  backgroundColor: isActive ? "var(--color-primary-bg)" : "transparent",
                  color: isActive ? "var(--color-primary)" : "var(--text-secondary)",
                  border: "1px solid transparent",
                  borderColor: isActive ? "rgba(59, 130, 246, 0.2)" : "transparent",
                  marginBottom: "4px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span>{item.name}</span>
                {item.badge !== undefined && (
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "var(--radius-full)",
                      backgroundColor: isActive
                        ? "var(--color-primary)"
                        : "var(--border-default)",
                      color: isActive ? "#ffffff" : "var(--text-primary)",
                      fontWeight: 600,
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* 底部状态区域 */}
      <div
        style={{
          padding: "16px",
          borderTop: "1px solid var(--border-subtle)",
          backgroundColor: "rgba(0, 0, 0, 0.1)",
        }}
      >
        {/* 调度快捷启停 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "12px",
          }}
        >
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            自动调度
          </div>
          <button
            onClick={toggleScheduler}
            className={scheduler.running ? "btn-icon active" : "btn-icon"}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              color: scheduler.running ? "var(--color-success)" : "var(--text-muted)",
              backgroundColor: scheduler.running
                ? "var(--color-success-bg)"
                : "transparent",
              border: `1px solid ${
                scheduler.running ? "var(--color-success-border)" : "var(--border-subtle)"
              }`,
            }}
            title={scheduler.running ? "点击停止调度" : "点击启动调度"}
          >
            {scheduler.running ? <IconStop size={12} /> : <IconPlay size={12} />}
            <span>{scheduler.running ? "运行中" : "已暂停"}</span>
          </button>
        </div>

        {/* 连接状态与手动刷新 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "11px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: connection.connected
                  ? "var(--color-success)"
                  : "var(--color-danger)",
              }}
            />
            <span
              style={{
                color: connection.connected
                  ? "var(--text-primary)"
                  : "var(--color-danger)",
                fontWeight: 500,
              }}
            >
              {connection.connected ? "Agent 已连接" : "未连接"}
            </span>
          </div>

          <button
            onClick={manualRefreshBootstrap}
            className="btn-icon"
            style={{ padding: "4px" }}
            title="手动刷新全量状态快照"
          >
            <IconRefresh size={12} />
          </button>
        </div>
      </div>
    </aside>
  );
};
