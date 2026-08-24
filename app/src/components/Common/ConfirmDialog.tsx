// 破坏性操作二次确认对话框
// 严格遵循 UI_BRIEF：确认文案必须说明具体后果与影响范围

import React from "react";
import { Modal } from "./Modal";
import { IconAlert } from "./Icons";

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
  loading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "确认执行",
  cancelText = "取消",
  isDangerous = true,
  loading = false,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: isDangerous ? "var(--color-danger)" : "var(--text-primary)" }}>
          {isDangerous && <IconAlert size={18} />}
          <span>{title}</span>
        </div>
      }
      footer={
        <>
          <button onClick={onClose} disabled={loading}>
            {cancelText}
          </button>
          <button
            className={isDangerous ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "执行中..." : confirmText}
          </button>
        </>
      }
    >
      <div style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>
        {description}
      </div>
    </Modal>
  );
};
