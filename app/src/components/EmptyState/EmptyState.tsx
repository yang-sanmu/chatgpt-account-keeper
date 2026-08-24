// 列表空状态组件
// 严格遵循 UI_BRIEF：清晰说明为什么是空的，以及下一步应该做什么

import React from "react";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: React.ReactNode;
  actionText?: string;
  onAction?: () => void;
  actionIcon?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actionText,
  onAction,
  actionIcon,
}) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center",
        backgroundColor: "rgba(255, 255, 255, 0.01)",
        border: "1px dashed var(--border-subtle)",
        borderRadius: "var(--radius-lg)",
        margin: "24px 0",
      }}
    >
      {icon && (
        <div
          style={{
            fontSize: "36px",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          {icon}
        </div>
      )}
      <h4
        style={{
          fontSize: "15px",
          fontWeight: 600,
          color: "var(--text-primary)",
          marginBottom: "8px",
        }}
      >
        {title}
      </h4>
      <div
        style={{
          fontSize: "13px",
          color: "var(--text-secondary)",
          maxWidth: "420px",
          lineHeight: 1.6,
          marginBottom: actionText && onAction ? "20px" : "0",
        }}
      >
        {description}
      </div>
      {actionText && onAction && (
        <button className="btn-primary" onClick={onAction}>
          {actionIcon}
          <span>{actionText}</span>
        </button>
      )}
    </div>
  );
};
