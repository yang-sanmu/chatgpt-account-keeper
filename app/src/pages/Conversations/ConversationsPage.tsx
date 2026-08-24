// Page 5: 会话策略管理 (Conversations)
// 严格遵循 UI_BRIEF：区分新建/编辑两种明确状态，重命名时明确提示非原子风险与失败后果

import React, { useState } from "react";
import { useApp } from "../../state/AppContext";
import { agentCall, newCommandId } from "../../ipc/bridge";
import type { ConversationSet } from "../../ipc/types";
import { toast } from "../../state/toastStore";
import { Modal } from "../../components/Common/Modal";
import { ConfirmDialog } from "../../components/Common/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import { IconAlert, IconEdit, IconPlus, IconTrash } from "../../components/Common/Icons";

export const ConversationsPage: React.FC = () => {
  const { conversations } = useApp();

  // 区分新建和编辑两个明确状态
  const [modalState, setModalState] = useState<{
    mode: "create" | "edit";
    isOpen: boolean;
    originalName: string | null;
  }>({
    mode: "create",
    isOpen: false,
    originalName: null,
  });

  const [nameInput, setNameInput] = useState("");
  const [topicInput, setTopicInput] = useState("");
  const [minRoundsInput, setMinRoundsInput] = useState(1);
  const [maxRoundsInput, setMaxRoundsInput] = useState(3);
  const [submitting, setSubmitting] = useState(false);

  // 删除会话集确认
  const [deleteTargetName, setDeleteTargetName] = useState<string | null>(null);

  // 打开新建会话集
  const handleOpenCreate = () => {
    setNameInput("");
    setTopicInput("");
    setMinRoundsInput(1);
    setMaxRoundsInput(3);
    setModalState({
      mode: "create",
      isOpen: true,
      originalName: null,
    });
  };

  // 打开编辑会话集
  const handleOpenEdit = (name: string, set: ConversationSet) => {
    setNameInput(name);
    setTopicInput(set.topic);
    setMinRoundsInput(set.minRounds);
    setMaxRoundsInput(set.maxRounds);
    setModalState({
      mode: "edit",
      isOpen: true,
      originalName: name,
    });
  };

  const handleSave = async () => {
    const trimmedName = nameInput.trim();
    const trimmedTopic = topicInput.trim();
    if (!trimmedName || !trimmedTopic) {
      toast.warning("请输入会话集名称与对话主题");
      return;
    }

    setSubmitting(true);
    try {
      const isRenaming =
        modalState.mode === "edit" &&
        modalState.originalName &&
        modalState.originalName !== trimmedName;

      const newSet: ConversationSet = {
        topic: trimmedTopic,
        minRounds: Math.max(0, minRoundsInput),
        maxRounds: Math.max(minRoundsInput, maxRoundsInput),
      };

      // 规范硬性要求：重命名是非原子的（先 upsert 后 remove）
      const cid1 = await newCommandId();
      await agentCall("conversations.upsert", { name: trimmedName, set: newSet }, cid1);

      if (isRenaming) {
        const cid2 = await newCommandId();
        await agentCall("conversations.remove", { name: modalState.originalName }, cid2);
        toast.success(`会话集已重命名为「${trimmedName}」`);
      } else {
        toast.success(modalState.mode === "create" ? "会话集已创建" : "会话集已更新");
      }

      setModalState((prev) => ({ ...prev, isOpen: false }));
    } catch (err) {
      toast.error("保存会话集失败", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTargetName) return;
    try {
      const cid = await newCommandId();
      await agentCall("conversations.remove", { name: deleteTargetName }, cid);
      toast.success("会话集已删除");
      setDeleteTargetName(null);
    } catch (err) {
      toast.error("删除会话集失败", err);
    }
  };

  const conversationEntries = Object.entries(conversations || {});

  return (
    <div className="page-container">
      <div className="page-scroll-body">
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>自动对话策略集</h3>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                配置后台自动轮换巡检时向 ChatGPT 发起的多轮对话主题与问答轮次范围。
              </p>
            </div>

            <button className="btn-primary" onClick={handleOpenCreate} style={{ fontSize: "12px" }}>
              <IconPlus size={13} />
              <span>新建策略集</span>
            </button>
          </div>

          {conversationEntries.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "14px" }}>
              {conversationEntries.map(([name, set]) => (
                <div
                  key={name}
                  style={{
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-md)",
                    padding: "14px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "10px",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--text-primary)" }}>
                        {name}
                      </span>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          onClick={() => handleOpenEdit(name, set)}
                          className="btn-icon"
                          title="编辑会话策略"
                        >
                          <IconEdit size={13} />
                        </button>
                        <button
                          onClick={() => setDeleteTargetName(name)}
                          className="btn-icon"
                          style={{ color: "var(--color-danger)" }}
                          title="删除会话策略"
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: "8px", fontSize: "13px", color: "var(--text-secondary)" }}>
                      <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "2px" }}>对话主题:</div>
                      <div
                        style={{
                          backgroundColor: "var(--bg-input)",
                          padding: "6px 8px",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border-subtle)",
                          fontSize: "12px",
                          lineHeight: 1.4,
                        }}
                      >
                        {set.topic}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--text-muted)" }}>
                    <span>轮次范围: <strong>{set.minRounds} ~ {set.maxRounds} 轮</strong></span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无会话策略集"
              description="您可以创建第一个对话策略集，指定多轮问答主题，让 Agent 定期保持账号活跃度。"
              actionText="新建策略集"
              onAction={handleOpenCreate}
            />
          )}
        </div>
      </div>

      {/* 新建/编辑会话集模态框 */}
      <Modal
        isOpen={modalState.isOpen}
        onClose={() => setModalState((prev) => ({ ...prev, isOpen: false }))}
        title={modalState.mode === "create" ? "新建对话策略集" : "编辑对话策略集"}
        footer={
          <>
            <button onClick={() => setModalState((prev) => ({ ...prev, isOpen: false }))} disabled={submitting}>
              取消
            </button>
            <button className="btn-primary" onClick={handleSave} disabled={submitting}>
              {submitting ? "保存中..." : "保存策略"}
            </button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              策略集名称
            </label>
            <input
              type="text"
              placeholder="例如: daily-coding, philosophy-chat..."
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              style={{ width: "100%", marginTop: "6px" }}
              autoFocus
            />
          </div>

          {/* 规范硬性要求：修改名称时提示非原子重命名后果 */}
          {modalState.mode === "edit" &&
            modalState.originalName &&
            modalState.originalName !== nameInput.trim() && (
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--color-warning-bg)",
                  border: "1px solid var(--color-warning-border)",
                  fontSize: "12px",
                  color: "var(--color-warning)",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "6px",
                  lineHeight: 1.4,
                }}
              >
                <IconAlert size={16} />
                <div>
                  <strong>重命名风险提示:</strong>
                  {" "}重命名是非原子的（将先以新名称创建并复制配置，再删除旧配置）。若在过程中连接中断，可能需要手动清理旧会话集。
                </div>
              </div>
            )}

          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              对话提示词主题 (Topic)
            </label>
            <textarea
              rows={3}
              placeholder="例如: 探讨 Rust 异步编程中的 Send / Sync 约束与所有权设计..."
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              style={{ width: "100%", marginTop: "6px", resize: "vertical" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                最小对话轮次
              </label>
              <input
                type="number"
                min={0}
                max={50}
                value={minRoundsInput}
                onChange={(e) => setMinRoundsInput(parseInt(e.target.value, 10) || 0)}
                style={{ width: "100%", marginTop: "6px" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                最大对话轮次
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={maxRoundsInput}
                onChange={(e) => setMaxRoundsInput(parseInt(e.target.value, 10) || 1)}
                style={{ width: "100%", marginTop: "6px" }}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={deleteTargetName !== null}
        onClose={() => setDeleteTargetName(null)}
        onConfirm={handleDelete}
        title={`确认删除策略集「${deleteTargetName}」？`}
        description="删除后，使用该策略集的账号在下一次自动对话时将回退至默认提示词主题。"
      />
    </div>
  );
};
