// Page 4: 分组与代理管理 (Groups & Proxies)
// 严格遵循 UI_BRIEF：
// 1. 节点行显示 server:port、本地端口、延迟（颜色分级）
// 2. proxyNode.tested 结果直接回填到对应行
// 3. 「新建分组」和「编辑分组」是两个明确状态（不使用空项代表新建）

import React, { useState } from "react";
import { useApp } from "../../state/AppContext";
import { agentCall, newCommandId } from "../../ipc/bridge";
import type { Group, GroupPatch, ProxyNode } from "../../ipc/types";
import { toast } from "../../state/toastStore";
import { Modal } from "../../components/Common/Modal";
import { ConfirmDialog } from "../../components/Common/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import {
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../../components/Common/Icons";

export const ProxiesPage: React.FC = () => {
  const { groups, proxies } = useApp();

  // 分组模态框状态：明确区分 create 和 edit
  const [groupModalState, setGroupModalState] = useState<{
    mode: "create" | "edit";
    isOpen: boolean;
    targetGroup: Group | null;
  }>({
    mode: "create",
    isOpen: false,
    targetGroup: null,
  });

  const [groupNameInput, setGroupNameInput] = useState("");
  const [groupProxyInput, setGroupProxyInput] = useState<string | null>(null);
  const [groupTzInput, setGroupTzInput] = useState("");
  const [groupLocaleInput, setGroupLocaleInput] = useState("");
  const [groupSubmitting, setGroupSubmitting] = useState(false);

  // 删除分组确认
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);

  // 导入订阅模态框
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [subUrlInput, setSubUrlInput] = useState("");
  const [subLoading, setSubLoading] = useState(false);

  // 测试中节点 ID 集合
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());

  // 打开新建分组模态框（明确状态 1）
  const handleOpenCreateGroup = () => {
    setGroupNameInput("");
    setGroupProxyInput(null);
    setGroupTzInput("");
    setGroupLocaleInput("");
    setGroupModalState({
      mode: "create",
      isOpen: true,
      targetGroup: null,
    });
  };

  // 打开编辑分组模态框（明确状态 2）
  const handleOpenEditGroup = (g: Group) => {
    setGroupNameInput(g.name);
    setGroupProxyInput(g.proxyId);
    setGroupTzInput(g.timezone || "");
    setGroupLocaleInput(g.locale || "");
    setGroupModalState({
      mode: "edit",
      isOpen: true,
      targetGroup: g,
    });
  };

  const handleSaveGroup = async () => {
    if (!groupNameInput.trim()) {
      toast.warning("请输入分组名称");
      return;
    }
    setGroupSubmitting(true);
    try {
      const cid = await newCommandId();
      const patch: GroupPatch = {
        name: groupNameInput.trim(),
        proxyId: groupProxyInput || null,
        timezone: groupTzInput.trim() || null,
        locale: groupLocaleInput.trim() || null,
      };

      if (groupModalState.mode === "create") {
        await agentCall("groups.create", patch, cid);
        toast.success("分组已创建");
      } else if (groupModalState.targetGroup) {
        await agentCall("groups.update", { id: groupModalState.targetGroup.id, patch }, cid);
        toast.success("分组已更新");
      }
      setGroupModalState((prev) => ({ ...prev, isOpen: false }));
    } catch (err) {
      toast.error(groupModalState.mode === "create" ? "创建分组失败" : "更新分组失败", err);
    } finally {
      setGroupSubmitting(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!deleteGroupId) return;
    try {
      const cid = await newCommandId();
      await agentCall("groups.remove", { id: deleteGroupId }, cid);
      toast.success("分组已删除");
      setDeleteGroupId(null);
    } catch (err) {
      toast.error("删除分组失败", err);
    }
  };

  // 导入订阅
  const handleImportSubscription = async () => {
    if (!subUrlInput.trim()) {
      toast.warning("请输入订阅链接 URL");
      return;
    }
    setSubLoading(true);
    try {
      const cid = await newCommandId();
      await agentCall("proxies.importSubscription", { url: subUrlInput.trim() }, cid);
      toast.success("订阅已成功导入并解析节点");
      setSubModalOpen(false);
      setSubUrlInput("");
    } catch (err) {
      toast.error("导入订阅失败", err);
    } finally {
      setSubLoading(false);
    }
  };

  // 刷新订阅
  const handleRefreshSubscription = async () => {
    try {
      const cid = await newCommandId();
      await agentCall("proxies.refreshSubscription", {}, cid);
      toast.info("已提交订阅刷新任务");
    } catch (err) {
      toast.error("刷新订阅失败", err);
    }
  };

  // 切换节点启用状态
  const handleToggleNode = async (node: ProxyNode) => {
    try {
      const cid = await newCommandId();
      await agentCall("proxies.setNodeEnabled", { id: node.id, enabled: !node.enabled }, cid);
      toast.success(`节点已${!node.enabled ? "启用" : "停用"}`);
    } catch (err) {
      toast.error("切换节点状态失败", err);
    }
  };

  // 测试单个节点
  const handleTestNode = async (nodeId: string) => {
    setTestingNodes((prev) => new Set(prev).add(nodeId));
    try {
      const cid = await newCommandId();
      await agentCall("proxies.testNode", { id: nodeId }, cid);
      toast.info("已提交节点测速任务");
    } catch (err) {
      toast.error("测试节点失败", err);
    } finally {
      setTestingNodes((prev) => {
        const copy = new Set(prev);
        copy.delete(nodeId);
        return copy;
      });
    }
  };

  // 测试全部节点
  const handleTestAll = async () => {
    try {
      const cid = await newCommandId();
      await agentCall("proxies.testAll", {}, cid);
      toast.info("已提交全部节点批量测速任务");
    } catch (err) {
      toast.error("发起全部测速失败", err);
    }
  };

  return (
    <div className="page-container">
      <div className="page-scroll-body">
        {/* 第一部分：出口分组管理 */}
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
            marginBottom: "24px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>出口分组</h3>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                为不同账号划分独立的代理出口节点、时区与语言环境。
              </p>
            </div>
            <button className="btn-primary" onClick={handleOpenCreateGroup} style={{ fontSize: "12px" }}>
              <IconPlus size={13} />
              <span>新建分组</span>
            </button>
          </div>

          {groups.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}>
              {groups.map((g) => (
                <div
                  key={g.id}
                  style={{
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-md)",
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--text-primary)" }}>
                        {g.name}
                      </span>
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          onClick={() => handleOpenEditGroup(g)}
                          className="btn-icon"
                          title="编辑分组属性"
                        >
                          <IconEdit size={13} />
                        </button>
                        <button
                          onClick={() => setDeleteGroupId(g.id)}
                          className="btn-icon"
                          style={{ color: "var(--color-danger)" }}
                          title="删除此分组"
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--text-secondary)", marginTop: "6px" }}>
                      <div>
                        绑定节点: <strong>{g.proxyId || "直连 / 未绑定"}</strong>
                      </div>
                      {g.timezone && <div>时区: <code>{g.timezone}</code></div>}
                      {g.locale && <div>语言区域: <code>{g.locale}</code></div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无出口分组"
              description="您可以创建第一个分组，并将指定账号与代理节点绑定以实现多出口分流。"
              actionText="新建分组"
              onAction={handleOpenCreateGroup}
            />
          )}
        </div>

        {/* 第二部分：Mihomo 代理节点与订阅管理 */}
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>代理节点与订阅</h3>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "2px 6px",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: proxies.status.running ? "var(--color-success-bg)" : "var(--color-warning-bg)",
                    color: proxies.status.running ? "var(--color-success)" : "var(--color-warning)",
                  }}
                >
                  {proxies.status.running ? `Mihomo 运行中 (本地端口: ${proxies.status.localPort ?? 7890})` : "Mihomo 未启动"}
                </span>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                {proxies.subscription?.url
                  ? `已绑定订阅 (${proxies.nodes.length} 个节点，上次更新: ${proxies.subscription.updatedAt || "-"})`
                  : "尚未导入代理订阅，当前仅支持直连模式。"}
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setSubModalOpen(true)} style={{ fontSize: "12px" }}>
                <span>导入订阅</span>
              </button>

              {proxies.subscription?.url && (
                <button onClick={handleRefreshSubscription} style={{ fontSize: "12px" }}>
                  <IconRefresh size={12} />
                  <span>更新订阅</span>
                </button>
              )}

              <button
                onClick={handleTestAll}
                disabled={proxies.nodes.length === 0}
                className="btn-primary"
                style={{ fontSize: "12px" }}
              >
                <span>测速全部</span>
              </button>
            </div>
          </div>

          {/* 节点列表与延迟回填展示 */}
          {proxies.nodes.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}>
                    <th style={{ padding: "8px 10px" }}>状态</th>
                    <th style={{ padding: "8px 10px" }}>节点名称</th>
                    <th style={{ padding: "8px 10px" }}>服务器 / 端口</th>
                    <th style={{ padding: "8px 10px" }}>类型</th>
                    <th style={{ padding: "8px 10px" }}>延迟 (分级)</th>
                    <th style={{ padding: "8px 10px", textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {proxies.nodes.map((node: ProxyNode) => {
                    const isTesting = testingNodes.has(node.id);
                    // 延迟颜色分级：<200ms 绿色，<500ms 黄色，>500ms 橙色，错误/超时 红色
                    let latencyColor = "var(--text-muted)";
                    let latencyBg = "var(--bg-input)";
                    // latencyOk === false 表示测过且失败；null 表示还没测过。两者要分开，
                    // 否则「没测过」会被涂成红色。
                    const testFailed = node.latencyOk === false;
                    if (testFailed) {
                      latencyColor = "var(--color-danger)";
                      latencyBg = "var(--color-danger-bg)";
                    } else if (typeof node.latencyMs === "number") {
                      if (node.latencyMs < 200) {
                        latencyColor = "var(--color-success)";
                        latencyBg = "var(--color-success-bg)";
                      } else if (node.latencyMs < 500) {
                        latencyColor = "var(--color-warning)";
                        latencyBg = "var(--color-warning-bg)";
                      } else {
                        latencyColor = "#f97316";
                        latencyBg = "rgba(249, 115, 22, 0.12)";
                      }
                    }

                    return (
                      <tr key={node.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                        <td style={{ padding: "8px 10px" }}>
                          <input
                            type="checkbox"
                            checked={node.enabled}
                            onChange={() => handleToggleNode(node)}
                            aria-label={`启用节点 ${node.name}`}
                          />
                        </td>
                        <td style={{ padding: "8px 10px", fontWeight: 600, color: "var(--text-primary)" }}>
                          {node.name}
                        </td>
                        {/* 规范硬性要求：显示 server:port。订阅缺字段时显示 —，
                            不能渲染成 "null:null"。 */}
                        <td style={{ padding: "8px 10px" }} className="code-badge">
                          {node.server ? `${node.server}:${node.port ?? "?"}` : "—"}
                        </td>
                        <td style={{ padding: "8px 10px", color: "var(--text-secondary)" }}>
                          {node.type?.toUpperCase() ?? "—"}
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          {isTesting ? (
                            <span style={{ color: "var(--color-primary)" }}>测速中...</span>
                          ) : testFailed ? (
                            <span
                              style={{
                                color: "var(--color-danger)",
                                backgroundColor: latencyBg,
                                padding: "2px 6px",
                                borderRadius: "var(--radius-sm)",
                                fontSize: "11px",
                              }}
                            >
                              {node.latencyMessage ?? "测速失败"}
                            </span>
                          ) : typeof node.latencyMs === "number" ? (
                            <span
                              style={{
                                color: latencyColor,
                                backgroundColor: latencyBg,
                                padding: "2px 6px",
                                borderRadius: "var(--radius-sm)",
                                fontWeight: 600,
                                fontSize: "11px",
                              }}
                            >
                              {node.latencyMs} ms
                            </span>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>未测速</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right" }}>
                          <button
                            onClick={() => handleTestNode(node.id)}
                            disabled={isTesting}
                            style={{ padding: "3px 8px", fontSize: "11px" }}
                          >
                            {isTesting ? "测速中" : "单节点测速"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="暂无代理节点"
              description="点击右上角「导入订阅」按钮添加您的订阅链接，系统将自动解析节点并支持测速。"
              actionText="导入订阅"
              onAction={() => setSubModalOpen(true)}
            />
          )}
        </div>
      </div>

      {/* 新建/编辑分组模态框（明确两个状态） */}
      <Modal
        isOpen={groupModalState.isOpen}
        onClose={() => setGroupModalState((prev) => ({ ...prev, isOpen: false }))}
        title={groupModalState.mode === "create" ? "新建出口分组" : "编辑出口分组"}
        footer={
          <>
            <button
              onClick={() => setGroupModalState((prev) => ({ ...prev, isOpen: false }))}
              disabled={groupSubmitting}
            >
              取消
            </button>
            <button className="btn-primary" onClick={handleSaveGroup} disabled={groupSubmitting}>
              {groupSubmitting ? "保存中..." : "保存分组"}
            </button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              分组名称
            </label>
            <input
              type="text"
              placeholder="例如: 美西个人、香港节点..."
              value={groupNameInput}
              onChange={(e) => setGroupNameInput(e.target.value)}
              style={{ width: "100%", marginTop: "6px" }}
              autoFocus
            />
          </div>

          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              绑定代理节点
            </label>
            <select
              value={groupProxyInput || ""}
              onChange={(e) => setGroupProxyInput(e.target.value === "" ? null : e.target.value)}
              style={{ width: "100%", marginTop: "6px" }}
            >
              <option value="">(直连 / 不走代理)</option>
              {proxies.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name} ({node.server}:{node.port})
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                时区 (可选)
              </label>
              <input
                type="text"
                placeholder="例如: America/Los_Angeles"
                value={groupTzInput}
                onChange={(e) => setGroupTzInput(e.target.value)}
                style={{ width: "100%", marginTop: "6px" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                语言区域 (可选)
              </label>
              <input
                type="text"
                placeholder="例如: en-US, zh-CN"
                value={groupLocaleInput}
                onChange={(e) => setGroupLocaleInput(e.target.value)}
                style={{ width: "100%", marginTop: "6px" }}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除分组确认 */}
      <ConfirmDialog
        isOpen={deleteGroupId !== null}
        onClose={() => setDeleteGroupId(null)}
        onConfirm={handleDeleteGroup}
        title="确认删除该分组？"
        description="删除后，属于该分组的账号将自动转为「未分组」状态，已保存的账号数据与 Profile 均不会受到影响。"
      />

      {/* 导入订阅模态框 */}
      <Modal
        isOpen={subModalOpen}
        onClose={() => setSubModalOpen(false)}
        title="导入代理订阅"
        footer={
          <>
            <button onClick={() => setSubModalOpen(false)} disabled={subLoading}>
              取消
            </button>
            <button className="btn-primary" onClick={handleImportSubscription} disabled={subLoading}>
              {subLoading ? "正在解析..." : "确认导入"}
            </button>
          </>
        }
      >
        <div>
          <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            订阅链接 (Clash / Shadowsocks / V2Ray 协议)
          </label>
          <input
            type="text"
            placeholder="https://example.com/api/v1/client/subscribe?token=..."
            value={subUrlInput}
            onChange={(e) => setSubUrlInput(e.target.value)}
            style={{ width: "100%", marginTop: "6px" }}
            autoFocus
          />
          <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
            支持导入标准 Clash / SSR 格式的托管订阅地址。
          </div>
        </div>
      </Modal>
    </div>
  );
};
