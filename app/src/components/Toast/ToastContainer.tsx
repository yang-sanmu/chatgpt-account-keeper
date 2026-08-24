// 浮层 Toast 通知展示容器
import React, { useEffect, useState } from "react";
import { toast, type ToastItem } from "../../state/toastStore";
import { IconAlert, IconCheck, IconClose, IconCopy } from "../Common/Icons";

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    return toast.subscribe((next) => {
      setToasts(next);
    });
  }, []);

  const handleCopyCode = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // 剪贴板异常时静默忽略
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: "16px",
        right: "16px",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        maxWidth: "420px",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        let borderColor = "var(--border-default)";
        let icon = <IconAlert size={18} />;

        if (t.type === "success") {
          borderColor = "var(--color-success-border)";
          icon = (
            <span style={{ color: "var(--color-success)" }}>
              <IconCheck size={18} />
            </span>
          );
        } else if (t.type === "error") {
          borderColor = "var(--color-danger-border)";
          icon = (
            <span style={{ color: "var(--color-danger)" }}>
              <IconAlert size={18} />
            </span>
          );
        } else if (t.type === "warning") {
          borderColor = "var(--color-warning-border)";
          icon = (
            <span style={{ color: "var(--color-warning)" }}>
              <IconAlert size={18} />
            </span>
          );
        }

        return (
          <div
            key={t.id}
            style={{
              backgroundColor: "var(--bg-elevated)",
              border: `1px solid ${borderColor}`,
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-lg)",
              padding: "12px 14px",
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              pointerEvents: "auto",
              animation: "toastSlideIn 0.2s ease-out",
            }}
          >
            <div style={{ marginTop: "2px", flexShrink: 0 }}>{icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  marginBottom: t.message || t.code ? "4px" : "0",
                }}
              >
                {t.title}
              </div>
              {t.message && (
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                  }}
                >
                  {t.message}
                </div>
              )}
              {t.code && (
                <div
                  style={{
                    marginTop: "6px",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span className="code-badge" style={{ color: "var(--color-danger)" }}>
                    {t.code}
                  </span>
                  <button
                    onClick={() => handleCopyCode(t.id, t.code!)}
                    className="btn-icon"
                    style={{ padding: "2px 4px", fontSize: "11px" }}
                    title="复制稳定错误码"
                  >
                    <IconCopy size={12} />
                    <span>{copiedId === t.id ? "已复制" : "复制错误码"}</span>
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => toast.dismiss(t.id)}
              className="btn-icon"
              style={{ padding: "2px", marginLeft: "4px" }}
              aria-label="关闭通知"
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
