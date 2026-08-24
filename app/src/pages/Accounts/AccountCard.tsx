// 账号标签式卡片组件（严格遵循 UI_BRIEF 第三节与 ASCII 规格）
// 卡片高度自然撑开，禁止写死高度；包含草稿高亮、即时保存与完整快捷动作条

import React, { useState } from "react";
import type { AccountItemState } from "../../state/accountsStore";
import type { Group, SwitchRule } from "../../ipc/types";
import { useApp } from "../../state/AppContext";
import { formatDateTime, formatRelativeTime, maskEmail } from "../../utils/format";
import { StatusBadge, RotationBadge } from "../../components/Common/Badge";
import {
  IconAlert,
  IconBrowser,
  IconCheck,
  IconCheckSelector,
  IconChevronDown,
  IconForceLogin,
  IconHistory,
  IconLogin,
  IconPlay,
  IconRefresh,
  IconTrash,
} from "../../components/Common/Icons";

export interface AccountCardProps {
  item: AccountItemState;
  groups: Group[];
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onDeleteClick: (id: string) => void;
  onOpenHistory: (id: string) => void;
}

export const AccountCard: React.FC<AccountCardProps> = ({
  item,
  groups,
  isSelected,
  onToggleSelect,
  onDeleteClick,
  onOpenHistory,
}) => {
  const {
    updateDraft,
    saveAccount,
    startLogin,
    toggleOpenPage,
    runAccountNow,
    refreshAccountStatus,
    checkAccountSelectors,
  } = useApp();

  const acc = item.effective;
  const isDirty = Object.keys(item.draft).length > 0;
  const isSubmitting = item.submitting !== null;

  // 展开次要设置（备注与窗口数输入区）
  const [expanded, setExpanded] = useState(false);

  // 轮换进度百分比
  const rotationPct =
    acc.rotationTarget > 0
      ? Math.min(100, Math.round((acc.rotationDone / acc.rotationTarget) * 100))
      : 0;

  // 分组切换：选择后即时保存
  const handleGroupChange = async (newGroupId: string) => {
    const gid = newGroupId === "" ? null : newGroupId;
    updateDraft(acc.id, { groupId: gid });
    await saveAccount(acc.id, { groupId: gid });
  };

  // 轮换规则切换：选择后即时保存（模型值是枚举，中文做显示）
  const handleSwitchRuleChange = async (rule: SwitchRule) => {
    updateDraft(acc.id, { switchRule: rule });
    await saveAccount(acc.id, { switchRule: rule });
  };

  // 提交备注与窗口数
  const handleSaveDetails = async () => {
    await saveAccount(acc.id, {
      note: acc.note,
      minWindows: acc.minWindows,
      maxWindows: acc.maxWindows,
    });
    setExpanded(false);
  };

  // 是否需要显示强制重登图标（needs_login / waf / 上次登录异常）
  const showForceLogin =
    acc.status === "needs_login" ||
    acc.status === "waf" ||
    acc.lastRunOk === false;

  return (
    <div
      style={{
        backgroundColor: isSelected ? "var(--bg-card-selected)" : "var(--bg-card)",
        border: `1px solid ${
          isSelected
            ? "var(--color-primary)"
            : isDirty
            ? "var(--color-warning-border)"
            : "var(--border-subtle)"
        }`,
        borderRadius: "var(--radius-lg)",
        boxShadow: isSelected ? "var(--shadow-md)" : "var(--shadow-sm)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        transition: "border-color 0.15s ease, background-color 0.15s ease",
        position: "relative",
      }}
    >
      {/* 卡片主内容区 */}
      <div style={{ padding: "16px" }}>
        {/* 卡头：复选框 + 脱敏邮箱 + 状态徽章 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            marginBottom: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleSelect(acc.id)}
              aria-label={`选择账号 ${acc.email || acc.note || acc.id}`}
            />
            <span
              style={{
                fontWeight: 600,
                fontSize: "14px",
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={acc.email ?? "未登录"}
            >
              {maskEmail(acc.email)}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            {acc.gptName && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  padding: "2px 6px",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: "rgba(16, 185, 129, 0.15)",
                  color: "var(--color-success)",
                }}
              >
                {acc.gptName}
              </span>
            )}
            <StatusBadge status={acc.status} stale={acc.stale} />
            {/* 巡检时间。相对时间用于快速判断新鲜度，完整时间戳放 title：
                只显示「3 分钟前」时用户无法判断这是哪一次巡检的结果。 */}
            {acc.statusCheckedAt && (
              <span
                style={{ fontSize: "10px", color: "var(--text-muted)" }}
                title={`上次巡检：${formatDateTime(acc.statusCheckedAt)}`}
              >
                {formatRelativeTime(acc.statusCheckedAt)}
              </span>
            )}
          </div>
        </div>

        {/* 分组与出口节点行 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "12px",
            color: "var(--text-secondary)",
            marginBottom: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ color: "var(--text-muted)" }}>分组:</span>
            <select
              value={acc.groupId || ""}
              onChange={(e) => handleGroupChange(e.target.value)}
              style={{
                padding: "2px 6px",
                fontSize: "12px",
                backgroundColor: "var(--bg-input)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
              }}
              aria-label="切换出口分组"
            >
              <option value="">(未分配分组)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          {/* 出口节点/失效警告 */}
          <div>
            {acc.exitNodeMissing ? (
              <span
                style={{
                  color: "var(--color-danger)",
                  fontSize: "11px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "3px",
                  fontWeight: 600,
                }}
              >
                <IconAlert size={12} />
                <span>节点已失效</span>
              </span>
            ) : acc.exitNode ? (
              <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                节点: {acc.exitNode}
              </span>
            ) : null}
          </div>
        </div>

        {/* 轮换指标与进度条 */}
        <div style={{ marginBottom: "12px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
              marginBottom: "6px",
            }}
          >
            <span style={{ color: "var(--text-muted)" }}>轮换策略进度</span>
            <RotationBadge
              topic={acc.rotationTopic}
              done={acc.rotationDone}
              target={acc.rotationTarget}
            />
          </div>

          <div className="progress-bar-container">
            <div
              className="progress-bar-fill"
              style={{
                width: `${rotationPct}%`,
                backgroundColor:
                  rotationPct >= 100 ? "var(--color-success)" : "var(--color-primary)",
              }}
            />
          </div>
        </div>

        {/* 次要信息与 ID */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "11px",
            color: "var(--text-muted)",
            marginBottom: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span>ID:</span>
            <span className="code-badge" style={{ fontSize: "10px" }}>
              {acc.id.length > 8 ? `${acc.id.slice(0, 4)}***${acc.id.slice(-3)}` : acc.id}
            </span>
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="btn-subtle"
            style={{ padding: "2px 6px", fontSize: "11px" }}
          >
            <span>{acc.note ? `备注: ${acc.note.slice(0, 8)}...` : "备注与窗口"}</span>
            <IconChevronDown size={10} />
          </button>
        </div>

        {/* 展开的备注与窗口数输入区 */}
        {expanded && (
          <div
            style={{
              padding: "10px",
              backgroundColor: "var(--bg-input)",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              marginBottom: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div>
              <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>账号备注:</label>
              <input
                type="text"
                value={acc.note}
                onChange={(e) => updateDraft(acc.id, { note: e.target.value })}
                placeholder="添加备注信息..."
                style={{ width: "100%", marginTop: "2px", fontSize: "12px", padding: "4px 8px" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveDetails();
                }}
              />
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>最小窗口数:</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={acc.minWindows}
                  onChange={(e) => updateDraft(acc.id, { minWindows: parseInt(e.target.value, 10) || 1 })}
                  style={{ width: "100%", marginTop: "2px", fontSize: "12px", padding: "4px 8px" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveDetails();
                  }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "11px", color: "var(--text-muted)" }}>最大窗口数:</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={acc.maxWindows}
                  onChange={(e) => updateDraft(acc.id, { maxWindows: parseInt(e.target.value, 10) || 1 })}
                  style={{ width: "100%", marginTop: "2px", fontSize: "12px", padding: "4px 8px" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveDetails();
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px", marginTop: "4px" }}>
              <button
                className="btn-primary"
                style={{ padding: "3px 8px", fontSize: "11px" }}
                onClick={handleSaveDetails}
                disabled={isSubmitting}
              >
                <IconCheck size={12} />
                <span>保存</span>
              </button>
            </div>
          </div>
        )}

        {/* 高亮运行信息块 */}
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            backgroundColor:
              acc.lastRunOk === false
                ? "var(--color-danger-bg)"
                : "var(--bg-card-highlight)",
            border: `1px solid ${
              acc.lastRunOk === false
                ? "var(--color-danger-border)"
                : "rgba(59, 130, 246, 0.15)"
            }`,
            marginBottom: "12px",
            fontSize: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
              📅 下次运行: {formatRelativeTime(acc.nextRunAt)}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>
              {formatDateTime(acc.nextRunAt)}
            </span>
          </div>

          {acc.lastRunOk === false && (
            <div
              style={{
                marginTop: "6px",
                color: "var(--color-danger)",
                fontSize: "11px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontWeight: 600,
              }}
            >
              <IconAlert size={12} />
              <span>上次运行失败: {acc.lastRunReason || "执行异常"}</span>
            </div>
          )}
        </div>

        {/* 底部下拉行：轮换规则选择器 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "12px",
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            上次: {formatDateTime(acc.lastRunAt)}
          </span>

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>规则:</span>
            <select
              value={acc.switchRule}
              onChange={(e) => handleSwitchRuleChange(e.target.value as SwitchRule)}
              style={{
                padding: "2px 6px",
                fontSize: "11px",
                backgroundColor: "var(--bg-input)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
              }}
              aria-label="选择轮换规则"
            >
              <option value="random">随机</option>
              <option value="sequential">顺序</option>
            </select>
          </div>
        </div>
      </div>

      {/* 底部图标操作条（严格遵循 UI_BRIEF 快捷操作清单） */}
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          backgroundColor: "rgba(0, 0, 0, 0.15)",
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "4px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {/* 登录 */}
          <button
            onClick={() => startLogin(acc.id, false)}
            className="btn-icon"
            title="登录账号 (拉起 Chrome 登录窗口)"
          >
            <IconLogin size={15} />
          </button>

          {/* 强制重登（仅状态异常或需要时出现） */}
          {showForceLogin && (
            <button
              onClick={() => startLogin(acc.id, true)}
              className="btn-icon"
              style={{ color: "var(--color-warning)" }}
              title="强制重新登录 (清除现有态并重新验证)"
            >
              <IconForceLogin size={15} />
            </button>
          )}

          {/* 打开/关闭网页 */}
          <button
            onClick={() => toggleOpenPage(acc.id, acc.pageOpen)}
            className={acc.pageOpen ? "btn-icon active" : "btn-icon"}
            style={{ color: acc.pageOpen ? "var(--color-success)" : undefined }}
            title={acc.pageOpen ? "关闭当前已打开的网页" : "使用此 Profile 打开网页"}
          >
            <IconBrowser size={15} />
          </button>

          {/* 立即运行 */}
          <button
            onClick={() => runAccountNow(acc.id)}
            className="btn-icon"
            title="立即运行自动对话"
          >
            <IconPlay size={15} />
          </button>

          {/* 刷新状态 */}
          <button
            onClick={() => refreshAccountStatus(acc.id)}
            className="btn-icon"
            title="刷新此账号状态"
          >
            <IconRefresh size={15} />
          </button>

          {/* 检查选择器 */}
          <button
            onClick={() => checkAccountSelectors(acc.id)}
            className="btn-icon"
            title="检查 ChatGPT 页面选择器适配"
          >
            <IconCheckSelector size={15} />
          </button>

          {/* 历史 */}
          <button
            onClick={() => onOpenHistory(acc.id)}
            className="btn-icon"
            title="查看此账号的历史运行记录"
          >
            <IconHistory size={15} />
          </button>
        </div>

        {/* 删除 */}
        <button
          onClick={() => onDeleteClick(acc.id)}
          className="btn-icon"
          style={{ color: "var(--color-danger)" }}
          title="删除账号"
        >
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
};
