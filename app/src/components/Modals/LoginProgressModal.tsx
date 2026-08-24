// 登录进度跟踪模态框
// 严格遵循 UI_BRIEF：必须开前台进度窗跟随 operation，消费 waiting_user 阶段引导用户在 Chrome 里操作

import React from "react";
import { Modal } from "../Common/Modal";
import type { Operation } from "../../ipc/types";
import { IconAlert, IconCheck } from "../Common/Icons";

export interface LoginProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId: string | null;
  accountEmail?: string | null;
  accountNote?: string;
  operation: Operation | null;
}

export const LoginProgressModal: React.FC<LoginProgressModalProps> = ({
  isOpen,
  onClose,
  accountId,
  accountEmail,
  accountNote,
  operation,
}) => {
  if (!isOpen || !accountId) return null;

  const state = operation?.state ?? "queued";
  const stage = operation?.stage;
  const message = operation?.message;
  const error = operation?.error;

  const isTerminal =
    state === "succeeded" ||
    state === "failed" ||
    state === "timed_out" ||
    state === "cancelled";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span>账号登录</span>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            ({accountEmail || accountNote || accountId})
          </span>
        </div>
      }
      footer={
        <button
          className={state === "succeeded" ? "btn-primary" : undefined}
          onClick={onClose}
        >
          {isTerminal ? "完成" : "转入后台运行"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* 状态总览 */}
        <div
          style={{
            padding: "16px",
            borderRadius: "var(--radius-md)",
            backgroundColor:
              state === "succeeded"
                ? "var(--color-success-bg)"
                : state === "failed" || state === "timed_out"
                ? "var(--color-danger-bg)"
                : state === "waiting_user"
                ? "var(--color-warning-bg)"
                : "var(--bg-input)",
            border: `1px solid ${
              state === "succeeded"
                ? "var(--color-success-border)"
                : state === "failed" || state === "timed_out"
                ? "var(--color-danger-border)"
                : state === "waiting_user"
                ? "var(--color-warning-border)"
                : "var(--border-subtle)"
            }`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            {state === "succeeded" ? (
              <span style={{ color: "var(--color-success)" }}>
                <IconCheck size={20} />
              </span>
            ) : state === "failed" || state === "timed_out" ? (
              <span style={{ color: "var(--color-danger)" }}>
                <IconAlert size={20} />
              </span>
            ) : (
              <div
                style={{
                  width: "16px",
                  height: "16px",
                  border: "2px solid var(--color-primary)",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                }}
              />
            )}
            <span style={{ fontWeight: 600, fontSize: "15px" }}>
              {state === "queued" && "正在排队分配浏览器资源..."}
              {state === "running" && "正在启动 Chrome 浏览器并初始化环境..."}
              {state === "waiting_user" && "等待用户在 Chrome 浏览器中操作"}
              {state === "succeeded" && "登录成功！"}
              {state === "failed" && "登录失败"}
              {state === "timed_out" && "登录超时"}
              {state === "cancelled" && "已取消登录"}
            </span>
          </div>

          {/* waiting_user 重点高亮提示 */}
          {state === "waiting_user" && (
            <div
              style={{
                fontSize: "13px",
                color: "var(--color-warning)",
                lineHeight: 1.6,
                marginTop: "6px",
              }}
            >
              👉 请切换到已弹出的 Google Chrome 窗口，完成 ChatGPT
              的账号密码输入、验证码或双重验证。完成后系统将自动检测登录态并保存。
            </div>
          )}

          {message && (
            <div
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                marginTop: "6px",
              }}
            >
              {message}
            </div>
          )}

          {stage && (
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-muted)",
                marginTop: "4px",
              }}
            >
              阶段: {stage}
            </div>
          )}

          {error && (
            <div style={{ marginTop: "12px" }}>
              <div style={{ color: "var(--color-danger)", fontSize: "13px", fontWeight: 600 }}>
                {error.message}
              </div>
              <span className="code-badge" style={{ marginTop: "4px", color: "var(--color-danger)" }}>
                {error.code}
              </span>
            </div>
          )}
        </div>

        {/* 进度提示 */}
        {operation?.progress !== null && operation?.progress !== undefined && (
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
              <span>进度</span>
              <span>{Math.round(operation.progress * 100)}%</span>
            </div>
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.round(operation.progress * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
