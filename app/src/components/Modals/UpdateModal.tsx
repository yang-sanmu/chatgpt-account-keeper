// 自更新检查与安装进度模态框
import React from "react";
import { Modal } from "../Common/Modal";
import type { UpdateStatus } from "../../ipc/types";
import { IconAlert, IconCheck } from "../Common/Icons";

export interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: UpdateStatus | null;
  onInstall: () => void;
  installing: boolean;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  isOpen,
  onClose,
  status,
  onInstall,
  installing,
}) => {
  if (!isOpen || !status) return null;

  const isAvailable = status.state === "available";
  const isInstalling = status.state === "installing" || installing;
  const isCurrent = status.state === "current";
  const isError = status.state === "error";
  const isUnsupported = status.state === "unsupported";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="应用更新"
      maxWidth={480}
      footer={
        <>
          <button onClick={onClose} disabled={isInstalling && !status.canCancel}>
            {isCurrent || isUnsupported || isError ? "关闭" : "稍后"}
          </button>
          {isAvailable && (
            <button
              className="btn-primary"
              onClick={onInstall}
              disabled={isInstalling}
            >
              {isInstalling ? "正在安装..." : "立即更新并重启"}
            </button>
          )}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
          {isAvailable ? (
            <span style={{ color: "var(--color-primary)", marginTop: "2px" }}>
              <IconCheck size={20} />
            </span>
          ) : isCurrent ? (
            <span style={{ color: "var(--color-success)", marginTop: "2px" }}>
              <IconCheck size={20} />
            </span>
          ) : isError ? (
            <span style={{ color: "var(--color-danger)", marginTop: "2px" }}>
              <IconAlert size={20} />
            </span>
          ) : null}

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
              {status.message}
            </div>
            {status.version && (
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
                新版本号: <span className="code-badge">{status.version}</span>
              </div>
            )}
          </div>
        </div>

        {status.notes && (
          <div
            style={{
              padding: "12px",
              backgroundColor: "var(--bg-input)",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              fontSize: "13px",
              color: "var(--text-secondary)",
              maxHeight: "160px",
              overflowY: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {status.notes}
          </div>
        )}

        {isInstalling && (
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                color: "var(--text-muted)",
                marginBottom: "4px",
              }}
            >
              <span>{status.stage ?? "安装更新中..."}</span>
              {status.percent !== null && status.percent !== undefined && (
                <span>{status.percent}%</span>
              )}
            </div>
            {status.percent !== null && status.percent !== undefined && (
              <div className="progress-bar-container">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${status.percent}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
