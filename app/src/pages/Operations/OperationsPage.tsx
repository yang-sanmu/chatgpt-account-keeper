// Page 3: 任务中心 (Operations)
// 严格遵循 UI_BRIEF：按状态筛选、稳定错误码可复制、遗留 interrupted 显示为「已取消」

import React, { useState } from "react";
import { useApp } from "../../state/AppContext";
import { formatDateTime } from "../../utils/format";
import { toast } from "../../state/toastStore";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import { IconAlert, IconCheck, IconCopy, IconRefresh, IconSearch } from "../../components/Common/Icons";
import type { Operation } from "../../ipc/types";

/// 任务状态的中文标签。
///
/// 用穷举 switch 而不是三元链：契约里 `state` 是七值闭集，穷举能让新增状态在编译期暴露，
/// 而三元链会把它静默落到最后那个分支（「排队中」）——一个终止的任务显示成排队中，正是
/// 「上次运行遗留的任务看起来还在跑」那类缺陷的形状。
///
/// 上一次进程遗留的未完成任务由 Agent 自己归一成 `cancelled`（见 REFACTOR_STATUS 的
/// Alpha 5 段落），前端不需要也不应该再猜一次。
function operationStateLabel(state: Operation["state"]): string {
  switch (state) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "waiting_user":
      return "等待用户输入";
    case "succeeded":
      return "执行成功";
    case "failed":
      return "执行失败";
    case "timed_out":
      return "超时终止";
    case "cancelled":
      return "已取消";
  }
}

export const OperationsPage: React.FC = () => {
  const { operations, manualRefreshBootstrap } = useApp();
  const [filterState, setFilterState] = useState<string>("all");
  const [keyword, setKeyword] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredOps = operations.filter((op) => {
    // 状态筛选
    if (filterState === "active") {
      if (op.state !== "running" && op.state !== "queued" && op.state !== "waiting_user") {
        return false;
      }
    } else if (filterState === "succeeded") {
      if (op.state !== "succeeded") return false;
    } else if (filterState === "failed") {
      if (op.state !== "failed" && op.state !== "timed_out") return false;
    } else if (filterState === "cancelled") {
      if (op.state !== "cancelled") return false;
    }

    // 关键词筛选
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      const matchKind = op.kind.toLowerCase().includes(kw);
      const matchRes = op.resourceId?.toLowerCase().includes(kw) ?? false;
      const matchMsg = op.message?.toLowerCase().includes(kw) ?? false;
      const matchErr = op.error?.message.toLowerCase().includes(kw) ?? false;
      const matchCode = op.error?.code.toLowerCase().includes(kw) ?? false;
      if (!matchKind && !matchRes && !matchMsg && !matchErr && !matchCode) {
        return false;
      }
    }

    return true;
  });

  const handleCopyCode = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      toast.success("已复制稳定错误码");
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <div className="page-container">
      {/* 顶部过滤栏 */}
      <div
        style={{
          padding: "16px 24px",
          backgroundColor: "var(--bg-app)",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* 状态 Tab */}
          {[
            { id: "all", label: "全部任务" },
            { id: "active", label: "进行中" },
            { id: "succeeded", label: "已成功" },
            { id: "failed", label: "失败/超时" },
            { id: "cancelled", label: "已取消" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilterState(tab.id)}
              className={filterState === tab.id ? "btn-primary" : "btn-subtle"}
              style={{ padding: "4px 10px", fontSize: "12px" }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ position: "relative", minWidth: "180px" }}>
            <input
              type="search"
              placeholder="搜索任务或错误码..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: "100%", paddingLeft: "28px", fontSize: "12px" }}
            />
            <span
              style={{
                position: "absolute",
                left: "8px",
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-muted)",
                pointerEvents: "none",
                display: "flex",
              }}
            >
              <IconSearch size={13} />
            </span>
          </div>

          <button onClick={manualRefreshBootstrap} className="btn-icon" title="刷新任务列表">
            <IconRefresh size={14} />
          </button>
        </div>
      </div>

      {/* 任务列表主滚动区 */}
      <div className="page-scroll-body">
        {filteredOps.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {filteredOps.map((op: Operation) => {
              const isRunning = op.state === "running" || op.state === "queued" || op.state === "waiting_user";
              const isSucceeded = op.state === "succeeded";
              const isFailed = op.state === "failed" || op.state === "timed_out";

              return (
                <div
                  key={op.id}
                  style={{
                    backgroundColor: "var(--bg-card)",
                    border: `1px solid ${
                      isFailed
                        ? "var(--color-danger-border)"
                        : isRunning
                        ? "var(--color-primary)"
                        : "var(--border-subtle)"
                    }`,
                    borderRadius: "var(--radius-md)",
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      {/* 状态徽章 */}
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "2px 8px",
                          borderRadius: "var(--radius-sm)",
                          fontSize: "11px",
                          fontWeight: 600,
                          backgroundColor: isSucceeded
                            ? "var(--color-success-bg)"
                            : isFailed
                            ? "var(--color-danger-bg)"
                            : isRunning
                            ? "var(--color-primary-bg)"
                            : "var(--bg-input)",
                          color: isSucceeded
                            ? "var(--color-success)"
                            : isFailed
                            ? "var(--color-danger)"
                            : isRunning
                            ? "var(--color-primary)"
                            : "var(--text-muted)",
                        }}
                      >
                        {isSucceeded && <IconCheck size={12} />}
                        {isFailed && <IconAlert size={12} />}
                        {operationStateLabel(op.state)}
                      </span>

                      <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                        {op.kind}
                      </span>

                      {op.resourceId && (
                        <span className="code-badge" style={{ fontSize: "11px" }}>
                          {op.resourceId}
                        </span>
                      )}

                      {op.effectiveSource && (
                        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                          ({op.effectiveSource === "manual" ? "手动触发" : op.effectiveSource === "scheduled" ? "计划调度" : "后台任务"})
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      启动: {formatDateTime(op.startedAt)}
                      {op.finishedAt && ` · 结束: ${formatDateTime(op.finishedAt)}`}
                    </div>
                  </div>

                  {/* 进度条与阶段 */}
                  {op.progress !== null && op.progress !== undefined && isRunning && (
                    <div style={{ marginTop: "2px" }}>
                      <div className="progress-bar-container">
                        <div
                          className="progress-bar-fill"
                          style={{ width: `${Math.round(op.progress * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* 消息与阶段 */}
                  {(op.message || op.stage) && (
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                      {op.stage && <strong>[{op.stage}] </strong>}
                      {op.message}
                    </div>
                  )}

                  {/* 错误码与复制按钮（UI_BRIEF：稳定错误码必须可复制） */}
                  {op.error && (
                    <div
                      style={{
                        padding: "8px 12px",
                        borderRadius: "var(--radius-sm)",
                        backgroundColor: "rgba(239, 68, 68, 0.08)",
                        border: "1px solid var(--color-danger-border)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        marginTop: "2px",
                      }}
                    >
                      <div style={{ fontSize: "12px", color: "var(--color-danger)" }}>
                        {op.error.message}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span className="code-badge" style={{ color: "var(--color-danger)", fontWeight: 600 }}>
                          {op.error.code}
                        </span>
                        <button
                          onClick={() => handleCopyCode(op.id, op.error!.code)}
                          className="btn-icon"
                          style={{ padding: "2px 6px", fontSize: "11px" }}
                          title="复制稳定错误码"
                        >
                          <IconCopy size={12} />
                          <span>{copiedId === op.id ? "已复制" : "复制"}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="暂无匹配的任务记录"
            description="当前筛选条件下没有找到长任务执行记录。系统运行自动巡检、登录或对话时将在此处显示。"
          />
        )}
      </div>
    </div>
  );
};
