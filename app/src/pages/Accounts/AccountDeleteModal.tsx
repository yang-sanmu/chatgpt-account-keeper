// 删除账号二次确认对话框
// 明确告知用户影响范围与 Profile 处置方案（保留、归档、彻底删除）

import React, { useState } from "react";
import { Modal } from "../../components/Common/Modal";
import { IconAlert } from "../../components/Common/Icons";

export interface AccountDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId: string | null;
  accountLabel?: string;
  isBulk?: boolean;
  bulkCount?: number;
  onConfirm: (profileAction: "detach" | "archive" | "purge") => Promise<void>;
}

export const AccountDeleteModal: React.FC<AccountDeleteModalProps> = ({
  isOpen,
  onClose,
  accountId,
  accountLabel,
  isBulk = false,
  bulkCount = 1,
  onConfirm,
}) => {
  const [profileAction, setProfileAction] = useState<"detach" | "archive" | "purge">("detach");
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm(profileAction);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-danger)" }}>
          <IconAlert size={18} />
          <span>{isBulk ? `确认批量删除 ${bulkCount} 个账号？` : "确认删除该账号？"}</span>
        </div>
      }
      footer={
        <>
          <button onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="btn-danger" onClick={handleConfirm} disabled={submitting}>
            {submitting ? "正在删除..." : "确认删除"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <p style={{ fontSize: "14px", color: "var(--text-primary)", lineHeight: 1.5 }}>
          {isBulk
            ? `您已选中 ${bulkCount} 个账号，删除后数据库记录将被移除。`
            : `即将从管理库中移除账号「${accountLabel || accountId}」。`}
        </p>

        <div>
          <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            关联的 Chrome Profile 存储处置方式：
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                backgroundColor: profileAction === "detach" ? "var(--color-primary-bg)" : "var(--bg-input)",
                border: `1px solid ${profileAction === "detach" ? "var(--color-primary)" : "var(--border-subtle)"}`,
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="profileAction"
                checked={profileAction === "detach"}
                onChange={() => setProfileAction("detach")}
                style={{ marginTop: "3px" }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  保留 Profile 目录 (Detach)
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                  仅解绑并保留磁盘上的 Chrome 用户数据目录为孤儿状态，未来可在 Profile 管理中重新认领或清理。
                </div>
              </div>
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                backgroundColor: profileAction === "archive" ? "var(--color-primary-bg)" : "var(--bg-input)",
                border: `1px solid ${profileAction === "archive" ? "var(--color-primary)" : "var(--border-subtle)"}`,
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="profileAction"
                checked={profileAction === "archive"}
                onChange={() => setProfileAction("archive")}
                style={{ marginTop: "3px" }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  归档 Profile (Archive)
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                  将整个 Profile 目录移动至归档存储区，不再占用活跃工作目录。
                </div>
              </div>
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                backgroundColor: profileAction === "purge" ? "var(--color-danger-bg)" : "var(--bg-input)",
                border: `1px solid ${profileAction === "purge" ? "var(--color-danger)" : "var(--border-subtle)"}`,
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="profileAction"
                checked={profileAction === "purge"}
                onChange={() => setProfileAction("purge")}
                style={{ marginTop: "3px" }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--color-danger)" }}>
                  永久彻底删除 (Purge)
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                  彻底删除磁盘上的 Profile 文件夹及其包含的全部 Cookie 与登录会话。⚠️ 此操作不可撤销！
                </div>
              </div>
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
};
