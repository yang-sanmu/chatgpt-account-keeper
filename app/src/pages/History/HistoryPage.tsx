// Page 7: 运行历史 (History)
// 严格遵循 UI_BRIEF：结构化问答气泡、支持复制、字段缺失时不铺原始 JSON 而是显示「本条记录缺少内容」

import React, { useEffect, useState } from "react";
import { agentCall } from "../../ipc/bridge";
import type { HistoryAccount, HistoryEntry, HistoryRound } from "../../ipc/types";
import { toast } from "../../state/toastStore";
import { formatDateTime, maskEmail } from "../../utils/format";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import { IconAlert, IconCheck, IconCopy, IconRefresh, IconSearch } from "../../components/Common/Icons";

export const HistoryPage: React.FC = () => {
  const [accounts, setAccounts] = useState<HistoryAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [accountKeyword, setAccountKeyword] = useState("");
  const [copiedTextId, setCopiedTextId] = useState<string | null>(null);

  // 加载拥有历史记录的账号列表
  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const res = await agentCall<HistoryAccount[] | { accounts: HistoryAccount[] }>(
        "history.listAccounts"
      );
      const list = Array.isArray(res)
        ? res
        : Array.isArray((res as { accounts: unknown }).accounts)
        ? (res as { accounts: HistoryAccount[] }).accounts
        : [];
      setAccounts(list);
      if (list.length > 0 && !selectedAccountId) {
        setSelectedAccountId(list[0]?.accountId ?? null);
      }
    } catch (err) {
      toast.error("加载历史账号列表失败", err);
    } finally {
      setLoadingAccounts(false);
    }
  };

  // 查询选中账号的具体问答历史
  const fetchAccountHistory = async (accountId: string) => {
    setLoadingHistory(true);
    try {
      const res = await agentCall<HistoryEntry[] | { entries: HistoryEntry[] }>(
        "history.query",
        { accountId, limit: 100 }
      );
      const list = Array.isArray(res)
        ? res
        : Array.isArray((res as { entries: unknown }).entries)
        ? (res as { entries: HistoryEntry[] }).entries
        : [];
      setHistoryEntries(list);
    } catch (err) {
      toast.error("查询账号对话历史失败", err);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      fetchAccountHistory(selectedAccountId);
    } else {
      setHistoryEntries([]);
    }
  }, [selectedAccountId]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTextId(id);
      toast.success("已复制内容到剪贴板");
      setTimeout(() => setCopiedTextId(null), 2000);
    } catch {
      toast.error("复制失败");
    }
  };

  const filteredAccounts = accounts.filter((acc) => {
    if (!accountKeyword.trim()) return true;
    const kw = accountKeyword.trim().toLowerCase();
    return (
      acc.accountId.toLowerCase().includes(kw) ||
      (acc.email?.toLowerCase().includes(kw) ?? false) ||
      (acc.note?.toLowerCase().includes(kw) ?? false) ||
      (acc.gptName?.toLowerCase().includes(kw) ?? false)
    );
  });

  const selectedAccount = accounts.find((a) => a.accountId === selectedAccountId);

  return (
    <div className="page-container" style={{ flexDirection: "row", overflow: "hidden" }}>
      {/* 左侧账号列表面板 */}
      <div
        style={{
          width: "280px",
          minWidth: "280px",
          height: "100%",
          backgroundColor: "var(--bg-card)",
          borderRight: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
              账号历史归档
            </span>
            <button onClick={fetchAccounts} disabled={loadingAccounts} className="btn-icon" style={{ padding: "3px" }}>
              <IconRefresh size={13} />
            </button>
          </div>

          <div style={{ position: "relative" }}>
            <input
              type="search"
              placeholder="搜索账号..."
              value={accountKeyword}
              onChange={(e) => setAccountKeyword(e.target.value)}
              style={{ width: "100%", paddingLeft: "24px", fontSize: "12px" }}
            />
            <span
              style={{
                position: "absolute",
                left: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-muted)",
                pointerEvents: "none",
                display: "flex",
              }}
            >
              <IconSearch size={12} />
            </span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
          {filteredAccounts.map((acc) => {
            const isSelected = selectedAccountId === acc.accountId;
            return (
              <button
                key={acc.accountId}
                onClick={() => setSelectedAccountId(acc.accountId)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: isSelected ? "var(--color-primary-bg)" : "transparent",
                  border: `1px solid ${isSelected ? "rgba(59, 130, 246, 0.3)" : "transparent"}`,
                  textAlign: "left",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  marginBottom: "4px",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                  <span style={{ fontWeight: 600, fontSize: "13px", color: isSelected ? "var(--color-primary)" : "var(--text-primary)" }}>
                    {acc.email ? maskEmail(acc.email) : acc.note || acc.accountId}
                  </span>
                  {acc.deleted && (
                    <span style={{ fontSize: "10px", color: "var(--color-danger)", backgroundColor: "var(--color-danger-bg)", padding: "1px 4px", borderRadius: "var(--radius-sm)" }}>
                      已删除
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-muted)" }}>
                  <span>记录: {acc.entryCount} 条</span>
                  <span>{formatDateTime(acc.lastAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧结构化问答详情主滚动区 */}
      <div className="page-scroll-body" style={{ flex: 1 }}>
        {selectedAccountId ? (
          <div>
            <div style={{ marginBottom: "16px", paddingBottom: "12px", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>
                  {selectedAccount?.email ? maskEmail(selectedAccount.email) : selectedAccount?.note || selectedAccountId}
                </h3>
                <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                  账号 ID: <code>{selectedAccountId}</code> · 共 {historyEntries.length} 次对话执行
                </p>
              </div>

              <button
                onClick={() => fetchAccountHistory(selectedAccountId)}
                disabled={loadingHistory}
                style={{ fontSize: "12px" }}
              >
                <IconRefresh size={12} />
                <span>刷新记录</span>
              </button>
            </div>

            {historyEntries.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                {historyEntries.map((entry, entryIndex) => (
                  <div
                    key={entryIndex}
                    style={{
                      backgroundColor: "var(--bg-card)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-lg)",
                      padding: "16px",
                    }}
                  >
                    {/* 对话批次元信息头 */}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        paddingBottom: "10px",
                        marginBottom: "12px",
                        borderBottom: "1px solid var(--border-subtle)",
                        fontSize: "12px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span
                          style={{
                            color: entry.ok ? "var(--color-success)" : "var(--color-danger)",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          {entry.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
                          <span>{entry.ok ? "执行成功" : "执行异常"}</span>
                        </span>

                        {entry.topic && (
                          <span className="code-badge">主题: {entry.topic}</span>
                        )}

                        {entry.setName && (
                          <span style={{ color: "var(--text-muted)" }}>({entry.setName})</span>
                        )}
                      </div>

                      <div style={{ color: "var(--text-muted)" }}>
                        {formatDateTime(entry.time)} · {entry.totalRounds} 轮问答
                      </div>
                    </div>

                    {/* 错误与重登提示 */}
                    {entry.error && (
                      <div
                        style={{
                          padding: "8px 12px",
                          borderRadius: "var(--radius-md)",
                          backgroundColor: "var(--color-danger-bg)",
                          color: "var(--color-danger)",
                          fontSize: "12px",
                          marginBottom: "12px",
                        }}
                      >
                        异常原因: {entry.error}
                      </div>
                    )}

                    {/* 结构化问答气泡列表 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {entry.rounds && entry.rounds.length > 0 ? (
                        entry.rounds.map((round: HistoryRound, rIdx: number) => {
                          const qId = `q-${entryIndex}-${rIdx}`;
                          const aId = `a-${entryIndex}-${rIdx}`;

                          const hasQuestion = round.question && round.question.trim().length > 0;
                          const hasAnswer = round.answer && round.answer.trim().length > 0;

                          return (
                            <div key={rIdx} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                              {/* 用户提问气泡 */}
                              <div
                                style={{
                                  alignSelf: "flex-end",
                                  maxWidth: "85%",
                                  backgroundColor: "var(--color-primary-bg)",
                                  border: "1px solid rgba(59, 130, 246, 0.2)",
                                  borderRadius: "var(--radius-lg) var(--radius-lg) 2px var(--radius-lg)",
                                  padding: "10px 14px",
                                }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px", gap: "8px" }}>
                                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-primary)" }}>
                                    用户提问 (第 {rIdx + 1} 轮)
                                  </span>
                                  {hasQuestion && (
                                    <button
                                      onClick={() => handleCopy(qId, round.question!)}
                                      className="btn-icon"
                                      style={{ padding: "2px" }}
                                      title="复制提问内容"
                                    >
                                      <IconCopy size={11} />
                                      <span style={{ fontSize: "10px" }}>{copiedTextId === qId ? "已复制" : ""}</span>
                                    </button>
                                  )}
                                </div>
                                <div style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                                  {/* 规范硬性要求：字段缺失时不许铺原始 JSON，显示「本条记录缺少内容」 */}
                                  {hasQuestion ? (
                                    round.question
                                  ) : (
                                    <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                                      本条记录缺少内容
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* ChatGPT 回答气泡 */}
                              <div
                                style={{
                                  alignSelf: "flex-start",
                                  maxWidth: "85%",
                                  backgroundColor: "var(--bg-elevated)",
                                  border: "1px solid var(--border-subtle)",
                                  borderRadius: "var(--radius-lg) var(--radius-lg) var(--radius-lg) 2px",
                                  padding: "10px 14px",
                                }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px", gap: "8px" }}>
                                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-success)" }}>
                                    ChatGPT 回答
                                  </span>
                                  {hasAnswer && (
                                    <button
                                      onClick={() => handleCopy(aId, round.answer!)}
                                      className="btn-icon"
                                      style={{ padding: "2px" }}
                                      title="复制回答内容"
                                    >
                                      <IconCopy size={11} />
                                      <span style={{ fontSize: "10px" }}>{copiedTextId === aId ? "已复制" : ""}</span>
                                    </button>
                                  )}
                                </div>
                                <div style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                                  {hasAnswer ? (
                                    round.answer
                                  ) : (
                                    <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                                      本条记录缺少内容
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div style={{ color: "var(--text-muted)", fontSize: "12px", fontStyle: "italic", padding: "8px 0" }}>
                          本条记录缺少内容
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="该账号暂无对话历史"
                description="当 Agent 自动或手动为该账号执行对话任务后，问答记录将保存并展示在此处。"
              />
            )}
          </div>
        ) : (
          <EmptyState
            title="请从左侧选择一个账号"
            description="选择账号以查看其历史执行问答记录。"
          />
        )}
      </div>
    </div>
  );
};
