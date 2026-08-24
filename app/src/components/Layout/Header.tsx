// 顶部全局标题与操作栏
import React from "react";
import { useApp } from "../../state/AppContext";
import { IconPlay, IconRefresh, IconStop } from "../Common/Icons";

const PAGE_TITLES: Record<string, { title: string; desc: string }> = {
  overview: { title: "系统总览", desc: "Agent 运行状态、Chrome 实例监控与数据目录" },
  accounts: { title: "账号管理", desc: "ChatGPT 多账号标签式卡片网格与批量控制" },
  operations: { title: "任务中心", desc: "后台长任务执行状态、阶段进度与异常诊断" },
  proxies: { title: "分组与代理", desc: "出口分组配置、Mihomo 代理节点与订阅管理" },
  conversations: { title: "会话策略", desc: "自动对话主题集与多轮问答轮换规则" },
  profiles: { title: "Profile 管理", desc: "Chrome 独立 Profile 扫描、缓存清理与孤儿归档" },
  history: { title: "运行历史", desc: "多轮问答记录结构化查看与已删除账号归档" },
  settings: { title: "偏好设置", desc: "Agent 业务参数、桌面客户端行为与关于" },
};

export const Header: React.FC = () => {
  const {
    activeTab,
    connection,
    startupInfo,
    scheduler,
    toggleScheduler,
    manualRefreshBootstrap,
  } = useApp();

  const info = PAGE_TITLES[activeTab] ?? { title: "ChatGPT Account Keeper", desc: "" };

  return (
    <header
      style={{
        height: "64px",
        minHeight: "64px",
        padding: "0 24px",
        backgroundColor: "var(--bg-app)",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div>
        <h1 style={{ fontSize: "18px", fontWeight: 700, color: "var(--text-primary)" }}>
          {info.title}
        </h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
          {info.desc}
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {connection.agentVersion && (
          <span className="code-badge" title="当前连接的 Agent 版本">
            Agent v{connection.agentVersion}
          </span>
        )}

        {startupInfo?.version && (
          <span className="code-badge" title="桌面客户端版本">
            App v{startupInfo.version}
          </span>
        )}

        <button
          onClick={manualRefreshBootstrap}
          className="btn-subtle"
          style={{ fontSize: "12px", padding: "4px 8px" }}
          title="刷新全量数据"
        >
          <IconRefresh size={14} />
          <span>同步状态</span>
        </button>

        <button
          onClick={toggleScheduler}
          className={scheduler.running ? "btn-icon active" : "btn-icon"}
          style={{
            padding: "5px 10px",
            fontSize: "12px",
            color: scheduler.running ? "var(--color-success)" : "var(--text-secondary)",
            backgroundColor: scheduler.running ? "var(--color-success-bg)" : "transparent",
            border: `1px solid ${
              scheduler.running ? "var(--color-success-border)" : "var(--border-subtle)"
            }`,
          }}
          title={scheduler.running ? "停止自动调度" : "启动自动调度"}
        >
          {scheduler.running ? <IconStop size={14} /> : <IconPlay size={14} />}
          <span>{scheduler.running ? "调度中" : "调度暂停"}</span>
        </button>
      </div>
    </header>
  );
};
