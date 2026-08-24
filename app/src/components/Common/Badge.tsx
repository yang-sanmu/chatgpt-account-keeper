// 徽章组件：用于状态点、轮换指示、错误标记
import React from "react";

export interface StatusBadgeProps {
  status: string;
  stale?: boolean;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, stale, className }) => {
  let label = status;
  let bg = "var(--border-subtle)";
  let dotColor = "var(--text-muted)";
  let textColor = "var(--text-secondary)";

  switch (status) {
    case "ok":
      label = "正常";
      bg = "var(--color-success-bg)";
      dotColor = "var(--color-success)";
      textColor = "var(--color-success)";
      break;
    case "needs_login":
      label = "需登录";
      bg = "var(--color-warning-bg)";
      dotColor = "var(--color-warning)";
      textColor = "var(--color-warning)";
      break;
    case "waf":
      label = "WAF 拦截";
      bg = "var(--color-danger-bg)";
      dotColor = "var(--color-danger)";
      textColor = "var(--color-danger)";
      break;
    case "unknown":
      label = "未知状态";
      bg = "rgba(100, 112, 135, 0.15)";
      dotColor = "var(--text-muted)";
      textColor = "var(--text-secondary)";
      break;
    default:
      label = status;
      break;
  }

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "var(--radius-sm)",
        fontSize: "11px",
        fontWeight: 600,
        backgroundColor: bg,
        color: textColor,
        border: "1px solid rgba(255, 255, 255, 0.05)",
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          backgroundColor: dotColor,
          display: "inline-block",
        }}
      />
      <span>{label}</span>
      {stale && (
        <span style={{ opacity: 0.85, fontWeight: "normal" }}>· 待复核</span>
      )}
    </span>
  );
};

export interface RotationBadgeProps {
  topic?: string | null;
  done: number;
  target: number;
}

export const RotationBadge: React.FC<RotationBadgeProps> = ({ topic, done, target }) => {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 6px",
        borderRadius: "var(--radius-sm)",
        fontSize: "11px",
        backgroundColor: "var(--color-primary-bg)",
        color: "var(--color-primary)",
        border: "1px solid rgba(59, 130, 246, 0.2)",
      }}
    >
      <span>↻</span>
      {topic ? <span>{topic}</span> : null}
      <span style={{ fontWeight: 600 }}>
        {done}/{target}
      </span>
    </span>
  );
};
