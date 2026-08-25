// Page 1: 总览页面
// 聚合连接状态、调度监控、队列快照、Chrome 运行明细与数据目录信息

import React, { useEffect, useState } from "react";
import { useApp } from "../../state/AppContext";
import { agentCall } from "../../ipc/bridge";
import type { BrowserRun, BrowserRunListResult, QueueSnapshot } from "../../ipc/types";
import { toast } from "../../state/toastStore";
import { formatDateTime } from "../../utils/format";
import { IconCopy, IconPlay, IconRefresh, IconStop } from "../../components/Common/Icons";

export const OverviewPage: React.FC = () => {
  const {
    connection,
    startupInfo,
    scheduler,
    startScheduler,
    stopScheduler,
    activeOperations,
  } = useApp();

  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot | null>(null);
  const [browserRuns, setBrowserRuns] = useState<BrowserRunListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [closingRunId, setClosingRunId] = useState<string | null>(null);

  const fetchOverviewData = async () => {
    setLoading(true);
    try {
      const [queueRes, runsRes] = await Promise.all([
        agentCall("queue.getSnapshot", {}).catch(() => null),
        agentCall("browserRuns.list", {}).catch(() => null),
      ]);
      if (queueRes) setQueueSnapshot(queueRes);
      if (runsRes) setBrowserRuns(runsRes);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverviewData();
    const timer = setInterval(fetchOverviewData, 8000);
    return () => clearInterval(timer);
  }, []);

  // 重试回收处于 close_failed 的 Chrome 实例
  const handleCloseBrowserRun = async (browserRunId: string) => {
    setClosingRunId(browserRunId);
    try {
      await agentCall("browserRuns.close", { browserRunId });
      toast.success("已请求回收 Chrome 运行实例");
      await fetchOverviewData();
    } catch (err) {
      toast.error("回收 Chrome 实例失败", err);
    } finally {
      setClosingRunId(null);
    }
  };

  const handleCopyPath = async (path: string, label: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(`已复制${label}`);
    } catch {
      toast.error("复制路径失败");
    }
  };

  return (
    <div className="page-container">
      <div className="page-scroll-body">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px", marginBottom: "24px" }}>
          {/* 连接与实例状态 */}
          <div
            style={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
              padding: "18px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>Agent 核心服务</h3>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: connection.connected ? "var(--color-success)" : "var(--color-danger)",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: connection.connected ? "var(--color-success)" : "var(--color-danger)",
                  }}
                />
                {connection.connected ? "运行正常" : "未连接"}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>状态描述:</span>
                <span style={{ color: "var(--text-secondary)" }}>{connection.detail || connection.status}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>Agent 版本:</span>
                <span className="code-badge">{connection.agentVersion ? `v${connection.agentVersion}` : "未连接"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>实例 ID:</span>
                <span className="code-badge" style={{ fontSize: "10px" }}>
                  {connection.instanceId ? connection.instanceId.slice(0, 13) + "..." : "-"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>IPC 端点:</span>
                <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>{startupInfo?.endpoint || "-"}</span>
              </div>
            </div>
          </div>

          {/* 自动调度状态 */}
          <div
            style={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
              padding: "18px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>自动调度控制</h3>
              <button
                onClick={scheduler.running ? stopScheduler : startScheduler}
                className={scheduler.running ? "btn-danger" : "btn-primary"}
                style={{ padding: "4px 10px", fontSize: "12px" }}
              >
                {scheduler.running ? <IconStop size={12} /> : <IconPlay size={12} />}
                <span>{scheduler.running ? "停止调度" : "启动调度"}</span>
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>调度状态:</span>
                <span style={{ color: scheduler.running ? "var(--color-success)" : "var(--color-warning)", fontWeight: 600 }}>
                  {scheduler.running ? "正在自动轮询账号队列" : "已暂停调度"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>受控账号数:</span>
                <span>{Object.keys(scheduler.accounts || {}).length} 个</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>当前活跃长任务:</span>
                <span>{activeOperations.length} 个进行中</span>
              </div>
            </div>
          </div>

          {/* 任务队列容量快照 */}
          <div
            style={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
              padding: "18px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>并发插槽与队列</h3>
              <button onClick={fetchOverviewData} className="btn-icon" style={{ padding: "4px" }} title="刷新队列">
                <IconRefresh size={14} />
              </button>
            </div>

            {queueSnapshot ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>工作槽位 (Work Slots):</span>
                  <span style={{ fontWeight: 600 }}>
                    {queueSnapshot.workSlots.used} / {queueSnapshot.workSlots.limit}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>Chrome 浏览器槽位:</span>
                  <span style={{ fontWeight: 600 }}>
                    {queueSnapshot.chromeSlots.used} / {queueSnapshot.chromeSlots.limit}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>等待中 / 运行中:</span>
                  <span>{queueSnapshot.queuedTotal} 队头 / {queueSnapshot.running} 运行</span>
                </div>
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>正在获取队列快照...</div>
            )}
          </div>
        </div>

        {/* Chrome 运行实例明细 */}
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
            marginBottom: "24px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>
                Chrome 浏览器运行明细
              </h3>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                活跃与最近关闭的 Chrome 实例。若实例出现回收失败，可在此处重试强制清理。
              </p>
            </div>
            <button onClick={fetchOverviewData} disabled={loading} style={{ fontSize: "12px" }}>
              <IconRefresh size={12} />
              <span>刷新实例列表</span>
            </button>
          </div>

          {browserRuns && browserRuns.active.length + browserRuns.recent.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}>
                    <th style={{ padding: "8px" }}>运行 ID</th>
                    <th style={{ padding: "8px" }}>关联账号</th>
                    <th style={{ padding: "8px" }}>目的</th>
                    <th style={{ padding: "8px" }}>PID</th>
                    <th style={{ padding: "8px" }}>状态</th>
                    <th style={{ padding: "8px" }}>启动时间</th>
                    <th style={{ padding: "8px", textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {[...browserRuns.active, ...browserRuns.recent].map((run: BrowserRun) => {
                    const isFailed = run.state === "close_failed";
                    return (
                      <tr key={run.browserRunId} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                        <td style={{ padding: "8px" }} className="code-badge">
                          {run.browserRunId.slice(0, 8)}...
                        </td>
                        <td style={{ padding: "8px", color: "var(--text-primary)" }}>{run.accountId}</td>
                        <td style={{ padding: "8px", color: "var(--text-secondary)" }}>{run.purpose}</td>
                        <td style={{ padding: "8px", color: "var(--text-muted)" }}>{run.rootPid ?? "-"}</td>
                        <td style={{ padding: "8px" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "2px 6px",
                              borderRadius: "var(--radius-sm)",
                              fontSize: "11px",
                              backgroundColor: isFailed
                                ? "var(--color-danger-bg)"
                                : run.state === "running"
                                ? "var(--color-success-bg)"
                                : "var(--border-subtle)",
                              color: isFailed
                                ? "var(--color-danger)"
                                : run.state === "running"
                                ? "var(--color-success)"
                                : "var(--text-secondary)",
                              fontWeight: 600,
                            }}
                          >
                            {run.state === "close_failed" && "❌ 回收失败"}
                            {run.state === "running" && "🟢 运行中"}
                            {run.state === "launching" && "🟡 启动中"}
                            {run.state === "closing" && "⚪ 关闭中"}
                            {run.state === "closed" && "⚪ 已关闭"}
                          </span>
                        </td>
                        <td style={{ padding: "8px", color: "var(--text-muted)" }}>
                          {formatDateTime(run.startedAt)}
                        </td>
                        <td style={{ padding: "8px", textAlign: "right" }}>
                          {run.state !== "closed" && (
                            <button
                              onClick={() => handleCloseBrowserRun(run.browserRunId)}
                              disabled={closingRunId === run.browserRunId}
                              className={isFailed ? "btn-danger" : undefined}
                              style={{ padding: "3px 8px", fontSize: "11px" }}
                            >
                              {closingRunId === run.browserRunId ? "正在回收..." : isFailed ? "重试回收" : "关闭"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
              当前暂无正在运行或最近的 Chrome 进程
            </div>
          )}
        </div>

        {/* 数据与日志目录 */}
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
          }}
        >
          <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
            数据目录与诊断日志
          </h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                backgroundColor: "var(--bg-input)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>数据存储根目录 (Data Root)</div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                  {startupInfo?.dataDirectory || "-"}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => handleCopyPath(startupInfo?.dataDirectory || "", "数据根目录路径")}
                  className="btn-icon"
                  title="复制路径"
                >
                  <IconCopy size={14} />
                  <span>复制</span>
                </button>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                backgroundColor: "var(--bg-input)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>Agent 诊断日志文件</div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                  {startupInfo?.agentLogFile || "-"}
                </div>
              </div>
              <button
                onClick={() => handleCopyPath(startupInfo?.agentLogFile || "", "诊断日志路径")}
                className="btn-icon"
                title="复制日志路径"
              >
                <IconCopy size={14} />
                <span>复制</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
