// 退出进度。
//
// Agent 的关闭是一个 16 步、整体上限 20 秒的流程。第 8 步要等 handler 与维护 Worker
// 收敛——Profile 扫描正在跑时那一步会耗掉数秒。没有这个窗口时「退出全部」看起来像没
// 反应，用户会反复点击（而重复点击本身又会让日志更难读）。
//
// 这个框刻意**不可关闭**：退出已经在进行，关掉它只会让用户回到一个看不见进度的等待。
// 想不再等待的出口是「强制结束」，而不是关闭这个提示。

import React from "react";
import type { ExitProgress } from "../../ipc/types";

export interface ExitProgressModalProps {
  progress: ExitProgress | null;
  onForceExit: () => void;
}

export const ExitProgressModal: React.FC<ExitProgressModalProps> = ({
  progress,
  onForceExit,
}) => {
  if (!progress) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="正在退出"
    >
      <div
        style={{
          width: "min(460px, 92vw)",
          backgroundColor: "var(--bg-card)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {progress.stage !== "done" && (
            <div
              style={{
                width: "18px",
                height: "18px",
                border: "2px solid var(--color-primary)",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "spin 1s linear infinite",
                flexShrink: 0,
              }}
            />
          )}
          <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>
            正在安全退出
          </h3>
        </div>

        <div style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          {progress.message}
        </div>

        {/* 显示已等待秒数而不是百分比：关闭流程的耗时取决于当时有多少任务在收尾，
            假的百分比比一个诚实的秒数更让人困惑。 */}
        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          已等待 {progress.elapsedSeconds} 秒
          {progress.elapsedSeconds >= 5 && "（正在收尾的任务较多时会久一些）"}
        </div>

        {progress.canForce && (
          <div
            style={{
              borderTop: "1px solid var(--border-subtle)",
              paddingTop: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ fontSize: "12px", color: "var(--color-warning)", lineHeight: 1.6 }}>
              强制结束会立刻回收整棵进程树，不会留下孤儿 Chrome，但数据库可能来不及做
              检查点。正常收尾通常只需要几秒，建议再等一下。
            </div>
            <button
              className="btn-danger"
              onClick={onForceExit}
              style={{ alignSelf: "flex-start" }}
            >
              强制结束
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
