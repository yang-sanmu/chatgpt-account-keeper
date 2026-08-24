// 关闭窗口二次确认弹窗（对应 closeBehavior = "ask" 模式）
import React, { useState } from "react";
import { Modal } from "../Common/Modal";

export interface CloseConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMinimizeToTray: (remember: boolean) => void;
  onExitAll: (remember: boolean) => void;
}

export const CloseConfirmModal: React.FC<CloseConfirmModalProps> = ({
  isOpen,
  onClose,
  onMinimizeToTray,
  onExitAll,
}) => {
  const [remember, setRemember] = useState(false);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="关闭窗口偏好"
      maxWidth={460}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button
            className="btn-primary"
            onClick={() => onMinimizeToTray(remember)}
          >
            最小化到托盘
          </button>
          <button
            className="btn-danger"
            onClick={() => onExitAll(remember)}
          >
            退出全部程序
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: 1.6 }}>
          您点击了窗口关闭按钮。请选择当前操作方式：
        </p>
        <ul
          style={{
            color: "var(--text-secondary)",
            fontSize: "13px",
            lineHeight: 1.6,
            paddingLeft: "20px",
          }}
        >
          <li>
            <strong style={{ color: "var(--text-primary)" }}>最小化到托盘</strong>
            ：后台 Agent、自动调度与已打开网页将继续运行。
          </li>
          <li>
            <strong style={{ color: "var(--text-primary)" }}>退出全部程序</strong>
            ：将安全停止后台 Agent 并关闭所有进程。
          </li>
        </ul>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "13px",
            color: "var(--text-primary)",
            marginTop: "6px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>记住我的选择，下次不再提示（可在「设置」中随时更改）</span>
        </label>
      </div>
    </Modal>
  );
};
