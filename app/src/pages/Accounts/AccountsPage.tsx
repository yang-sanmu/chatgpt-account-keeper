// Page 2: 账号管理页面
// 严格遵循 UI_BRIEF：标签式卡片网格布局（禁止列表/表格行）、动态撑开卡片高度、固定底部批量操作栏

import React, { useCallback, useState } from "react";
import { useApp } from "../../state/AppContext";
import { getFilteredAccounts } from "../../state/accountsStore";
import { AccountCard } from "./AccountCard";
import { AccountCreateModal } from "./AccountCreateModal";
import { AccountDeleteModal } from "./AccountDeleteModal";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import {
  IconCheck,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "../../components/Common/Icons";
import type { SwitchRule } from "../../ipc/types";

export const AccountsPage: React.FC = () => {
  const {
    accountsState,
    setFilter,
    toggleSelect,
    selectAll,
    deselectAll,
    groups,
    createAccount,
    removeAccount,
    bulkEnable,
    bulkRefreshStatus,
    bulkRunNow,
    bulkDelete,
    setActiveTab,
  } = useApp();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string | null;
    label?: string;
    isBulk: boolean;
  } | null>(null);

  const filteredItems = getFilteredAccounts(accountsState);
  const visibleIds = filteredItems.map((item) => item.effective.id);
  const selectedIds = accountsState.selectedIds;

  const isAllSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;

  const handleToggleSelectAll = () => {
    if (isAllSelected) {
      deselectAll();
    } else {
      selectAll(visibleIds);
    }
  };

  // 这两个回调直接传给 28 张记忆化卡片。写成内联箭头函数的话每次渲染都是新引用，
  // 卡片的 memo 会全部失效——那样加 memo 只是装饰。
  const handleOpenHistory = useCallback(() => {
    setActiveTab("history");
  }, [setActiveTab]);

  // 只存 id，标签留到渲染确认框时再查。
  //
  // 原来这里依赖 accountsState.accounts 去取一个显示用的标签，而那个对象在每条
  // accountStatus.changed 之后都是新的——于是这个回调的引用每次都变，28 张卡片的 memo
  // 全部失效。一个确认框的标题不值得让整页重渲染。
  const handleDeleteSingle = useCallback((id: string) => {
    setDeleteTarget({ id, isBulk: false });
  }, []);

  // 确认框的标签在渲染时从当前状态取，而不是点击时捕获。这样 handleDeleteSingle 不必
  // 依赖账号数据，卡片的 memo 得以保住。
  const deleteLabel =
    deleteTarget?.id != null
      ? (() => {
          const acc = accountsState.accounts[deleteTarget.id]?.effective;
          return acc?.email || acc?.note || deleteTarget.id;
        })()
      : undefined;

  const handleDeleteBulk = () => {
    if (selectedCount === 0) return;
    setDeleteTarget({
      id: null,
      isBulk: true,
    });
  };

  const handleConfirmDelete = async (profileAction: "detach" | "archive" | "purge") => {
    if (!deleteTarget) return;
    if (deleteTarget.isBulk) {
      await bulkDelete(Array.from(selectedIds), profileAction);
      deselectAll();
    } else if (deleteTarget.id) {
      await removeAccount(deleteTarget.id, profileAction);
    }
  };

  return (
    <div className="page-container">
      {/* 顶部搜索与筛选控制栏 */}
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
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", flex: 1, minWidth: "280px" }}>
          {/* 搜索框 */}
          <div style={{ position: "relative", minWidth: "200px" }}>
            <input
              type="search"
              placeholder="搜索邮箱、备注、ID..."
              value={accountsState.filter.keyword}
              onChange={(e) => setFilter({ keyword: e.target.value })}
              style={{ width: "100%", paddingLeft: "28px" }}
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
              <IconSearch size={14} />
            </span>
          </div>

          {/* 分组筛选 */}
          <select
            value={accountsState.filter.groupId}
            onChange={(e) => setFilter({ groupId: e.target.value })}
            style={{ fontSize: "12px" }}
            aria-label="按分组筛选"
          >
            <option value="all">全部分组</option>
            <option value="none">未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>

          {/* 状态筛选 */}
          <select
            value={accountsState.filter.status}
            onChange={(e) => setFilter({ status: e.target.value })}
            style={{ fontSize: "12px" }}
            aria-label="按状态筛选"
          >
            <option value="all">全部状态</option>
            <option value="ok">正常 (OK)</option>
            <option value="needs_login">需登录 (Needs Login)</option>
            <option value="waf">WAF 拦截</option>
            <option value="unknown">未知状态</option>
            <option value="stale">待复核</option>
            <option value="node_missing">节点已失效</option>
            <option value="disabled">已停用</option>
          </select>

          {/* 轮换规则筛选 */}
          <select
            value={accountsState.filter.switchRule}
            onChange={(e) => setFilter({ switchRule: e.target.value as SwitchRule | "all" })}
            style={{ fontSize: "12px" }}
            aria-label="按轮换规则筛选"
          >
            <option value="all">全部规则</option>
            <option value="random">随机 (Random)</option>
            <option value="sequential">顺序 (Sequential)</option>
          </select>
        </div>

        {/* 右侧动作按钮 */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            onClick={() => bulkRefreshStatus(visibleIds)}
            disabled={visibleIds.length === 0}
            style={{ fontSize: "12px" }}
            title="刷新当前视图中全部账号的状态"
          >
            <IconRefresh size={13} />
            <span>刷新当前状态</span>
          </button>

          <button
            className="btn-primary"
            onClick={() => setCreateModalOpen(true)}
            style={{ fontSize: "13px" }}
          >
            <IconPlus size={14} />
            <span>新建账号</span>
          </button>
        </div>
      </div>

      {/* 账号卡片网格主滚动区 */}
      <div
        className="page-scroll-body"
        style={{
          paddingBottom: selectedCount > 0 ? "80px" : "24px",
        }}
      >
        {filteredItems.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: "16px",
              alignItems: "start",
            }}
          >
            {filteredItems.map((item) => (
              <AccountCard
                key={item.effective.id}
                item={item}
                groups={groups}
                isSelected={selectedIds.has(item.effective.id)}
                onToggleSelect={toggleSelect}
                onDeleteClick={handleDeleteSingle}
                onOpenHistory={handleOpenHistory}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              accountsState.accountIds.length === 0
                ? "还没有添加任何 ChatGPT 账号"
                : "没有匹配当前筛选条件的账号"
            }
            description={
              accountsState.accountIds.length === 0
                ? "点击下方「新建账号」按钮添加第一个账号。系统将自动分配独立 Profile 并引导您登录。"
                : "请尝试清除关键词或切换状态与分组下拉选项查看其他账号。"
            }
            actionText={accountsState.accountIds.length === 0 ? "立即新建账号" : "重置筛选条件"}
            actionIcon={accountsState.accountIds.length === 0 ? <IconPlus size={14} /> : undefined}
            onAction={() => {
              if (accountsState.accountIds.length === 0) {
                setCreateModalOpen(true);
              } else {
                setFilter({ keyword: "", groupId: "all", status: "all", switchRule: "all" });
              }
            }}
          />
        )}
      </div>

      {/* 固定底部批量操作工具栏（严格遵循 UI_BRIEF：固定在底部不随卡片滚动） */}
      {selectedCount > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 100,
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-full)",
            boxShadow: "var(--shadow-lg)",
            padding: "8px 18px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            animation: "toastSlideIn 0.2s ease-out",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)" }}>
            <input
              type="checkbox"
              checked={isAllSelected}
              onChange={handleToggleSelectAll}
              aria-label="全选或取消全选"
            />
            <span>
              已勾选 <strong>{selectedCount}</strong> 个账号
            </span>
          </div>

          <div style={{ width: "1px", height: "18px", backgroundColor: "var(--border-subtle)" }} />

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <button
              onClick={() => bulkEnable(Array.from(selectedIds), true)}
              style={{ padding: "4px 10px", fontSize: "12px" }}
            >
              <IconCheck size={12} />
              <span>启用</span>
            </button>

            <button
              onClick={() => bulkEnable(Array.from(selectedIds), false)}
              style={{ padding: "4px 10px", fontSize: "12px" }}
            >
              <span>停用</span>
            </button>

            <button
              onClick={() => bulkRefreshStatus(Array.from(selectedIds))}
              style={{ padding: "4px 10px", fontSize: "12px" }}
            >
              <IconRefresh size={12} />
              <span>刷新状态</span>
            </button>

            <button
              onClick={() => bulkRunNow(Array.from(selectedIds))}
              style={{ padding: "4px 10px", fontSize: "12px" }}
            >
              <IconPlay size={12} />
              <span>立即运行</span>
            </button>

            <button
              className="btn-danger"
              onClick={handleDeleteBulk}
              style={{ padding: "4px 10px", fontSize: "12px" }}
            >
              <IconTrash size={12} />
              <span>删除</span>
            </button>
          </div>
        </div>
      )}

      {/* 新建账号模态框 */}
      <AccountCreateModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        groups={groups}
        onSubmit={async (data) => {
          await createAccount(data);
        }}
      />

      {/* 删除确认模态框 */}
      <AccountDeleteModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        accountId={deleteTarget?.id ?? null}
        accountLabel={deleteLabel}
        isBulk={deleteTarget?.isBulk ?? false}
        bulkCount={selectedCount}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
