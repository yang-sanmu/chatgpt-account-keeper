// 新增账号对话框
import React, { useState } from "react";
import { Modal } from "../../components/Common/Modal";
import type { Group, SwitchRule } from "../../ipc/types";

export interface AccountCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  onSubmit: (data: {
    note: string;
    groupId: string | null;
    switchRule: SwitchRule;
    minWindows: number;
    maxWindows: number;
  }) => Promise<void>;
}

export const AccountCreateModal: React.FC<AccountCreateModalProps> = ({
  isOpen,
  onClose,
  groups,
  onSubmit,
}) => {
  const [note, setNote] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [switchRule, setSwitchRule] = useState<SwitchRule>("random");
  const [minWindows, setMinWindows] = useState(1);
  const [maxWindows, setMaxWindows] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit({
        note: note.trim(),
        groupId: groupId || null,
        switchRule,
        minWindows: Math.max(1, minWindows),
        maxWindows: Math.max(1, maxWindows),
      });
      // 提交成功后重置表单并关闭
      setNote("");
      setGroupId(null);
      setMinWindows(1);
      setMaxWindows(2);
      onClose();
    } catch {
      // 错误由上层处理
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="新建 ChatGPT 账号"
      footer={
        <>
          <button onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={() => handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "正在创建并拉起登录..." : "创建并立即登录"}
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div>
          <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            账号备注 / 标识
          </label>
          <input
            type="text"
            placeholder="例如: 工作备用号、主力账号..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
            autoFocus
          />
        </div>

        <div>
          <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            出口代理分组
          </label>
          <select
            value={groupId || ""}
            onChange={(e) => setGroupId(e.target.value === "" ? null : e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
          >
            <option value="">(不指定分组 / 使用直连)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            轮换规则
          </label>
          <select
            value={switchRule}
            onChange={(e) => setSwitchRule(e.target.value as SwitchRule)}
            style={{ width: "100%", marginTop: "6px" }}
          >
            <option value="random">随机 (Random)</option>
            <option value="sequential">顺序 (Sequential)</option>
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              最小窗口数
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={minWindows}
              onChange={(e) => setMinWindows(parseInt(e.target.value, 10) || 1)}
              style={{ width: "100%", marginTop: "6px" }}
            />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              最大窗口数
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxWindows}
              onChange={(e) => setMaxWindows(parseInt(e.target.value, 10) || 1)}
              style={{ width: "100%", marginTop: "6px" }}
            />
          </div>
        </div>

        <div
          style={{
            fontSize: "12px",
            color: "var(--color-primary)",
            backgroundColor: "var(--color-primary-bg)",
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            border: "1px solid rgba(59, 130, 246, 0.2)",
            marginTop: "6px",
          }}
        >
          💡 提示：创建成功后，将自动为您分配专属 Profile 并立即拉起 Chrome 登录窗口完成身份验证。
        </div>
      </form>
    </Modal>
  );
};
