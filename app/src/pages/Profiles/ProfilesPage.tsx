// Page 6: Chrome Profile 管理 (Profiles)
// 严格遵循 UI_BRIEF：首次进入自动扫描、孤儿筛选、清理缓存/归档/永久删除
// 破坏性操作的确认文案必须说明具体后果（涉及几个、Profile 会保留还是删除、是否可恢复）

import React, { useEffect, useState } from "react";
import type { ProfileInfo } from "../../ipc/types";
import { useApp } from "../../state/AppContext";
import { toast } from "../../state/toastStore";
import { formatBytes } from "../../utils/format";
import { ConfirmDialog } from "../../components/Common/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import { IconRefresh, IconTrash } from "../../components/Common/Icons";

export const ProfilesPage: React.FC = () => {
  const { profileScan, profileScanning, requestProfileScan, runOperation } = useApp();
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);

  // 破坏性操作模态框状态
  const [actionDialog, setActionDialog] = useState<{
    isOpen: boolean;
    type: "cleanCache" | "archive" | "purge";
    scope: "single" | "allOrphans" | "all";
    targetName?: string;
    count?: number;
  }>({
    isOpen: false,
    type: "cleanCache",
    scope: "single",
  });

  // 规范硬性要求：首次进入自动扫描，不要求用户先点按钮。
  //
  // 扫描结果来自 context 而不是这次调用的返回值：profiles.scan 是操作类方法，await 到的
  // 只是一个操作描述符，真正的数据由 operation.changed 送回来。
  useEffect(() => {
    if (profileScan === null && !profileScanning) {
      void requestProfileScan();
    }
  }, [profileScan, profileScanning, requestProfileScan]);

  const profiles: ProfileInfo[] = profileScan?.profiles ?? [];
  const totals = profileScan?.totals;
  const orphanCount = totals?.orphans ?? profiles.filter((p) => !p.linked).length;
  const totalSizeBytes = totals?.bytes ?? 0;
  const totalCacheBytes = totals?.cacheBytes ?? 0;

  const displayedProfiles = profiles.filter((p) => {
    if (onlyOrphans && p.linked) return false;
    return true;
  });

  // 执行具体的清理/归档/永久删除操作
  const handleExecuteAction = async () => {
    if (actionRunning) return;
    setActionRunning(true);
    const { type, scope, targetName } = actionDialog;
    try {
      if (type === "cleanCache") {
        if (scope === "single" && targetName) {
          const terminalOp = await runOperation("profiles.cleanCache", { name: targetName });
          const res = terminalOp?.result as
            | { profilesCleaned?: number; freedBytes?: number; skipped?: unknown[] }
            | undefined;
          if (res && typeof res.profilesCleaned === "number") {
            const skippedCount = Array.isArray(res.skipped) ? res.skipped.length : 0;
            if (res.profilesCleaned > 0) {
              toast.success(`已清理 Profile「${targetName}」的缓存`);
            } else if (skippedCount > 0) {
              toast.info(`未执行清理：Profile「${targetName}」正被占用`);
            } else {
              toast.info(`Profile「${targetName}」缓存未发生变更`);
            }
          } else {
            toast.success(`Profile「${targetName}」缓存清理任务已完成`);
          }
        } else {
          const terminalOp = await runOperation("profiles.cleanCache", { scope: "all" });
          const res = terminalOp?.result as
            | { profilesCleaned?: number; freedBytes?: number; skipped?: unknown[] }
            | undefined;
          if (res && typeof res.profilesCleaned === "number") {
            const skippedCount = Array.isArray(res.skipped) ? res.skipped.length : 0;
            if (res.profilesCleaned > 0) {
              if (skippedCount > 0) {
                toast.success(
                  `已清理 ${res.profilesCleaned} 个 Profile 缓存，跳过占用中 ${skippedCount} 个`
                );
              } else {
                toast.success(`已清理 ${res.profilesCleaned} 个 Profile 缓存`);
              }
            } else if (skippedCount > 0) {
              toast.info(`未执行清理：跳过占用中 ${skippedCount} 个`);
            } else {
              toast.info("未发现可清理的 Profile 缓存");
            }
          } else {
            toast.success("Profile 缓存清理任务已完成");
          }
        }
      } else if (type === "archive") {
        if (scope === "single" && targetName) {
          await runOperation("profiles.archiveOrphan", { name: targetName });
          toast.success(`已归档孤儿 Profile「${targetName}」`);
        } else {
          // 逐个归档孤儿：占用中的孤儿不提交
          const orphans = profiles.filter((p) => !p.linked);
          const busyCount = orphans.filter((p) => p.busy).length;
          const eligibleOrphans = orphans.filter((p) => !p.busy);
          let succeededCount = 0;
          const failures: { name: string; error: unknown }[] = [];

          for (const o of eligibleOrphans) {
            try {
              await runOperation("profiles.archiveOrphan", { name: o.name });
              succeededCount++;
            } catch (error) {
              failures.push({ name: o.name, error });
            }
          }

          if (failures.length === 0) {
            if (succeededCount > 0) {
              toast.success(
                `已归档 ${succeededCount} 个孤儿 Profile` +
                  (busyCount > 0 ? `，跳过占用中 ${busyCount} 个` : "")
              );
            } else if (busyCount > 0) {
              toast.info(`未执行归档：跳过占用中 ${busyCount} 个`);
            }
          } else {
            toast.error(
              `归档孤儿 Profile 部分失败：成功 ${succeededCount} 个，失败 ${failures.length} 个` +
                (busyCount > 0 ? `，跳过占用中 ${busyCount} 个` : ""),
              failures[0]?.error
            );
          }
        }
      } else if (type === "purge") {
        if (scope === "single" && targetName) {
          await runOperation("profiles.purgeOrphan", { name: targetName });
          toast.success(`已彻底永久删除孤儿 Profile「${targetName}」`);
        } else {
          // 逐个清除孤儿：占用中的孤儿不提交
          const orphans = profiles.filter((p) => !p.linked);
          const busyCount = orphans.filter((p) => p.busy).length;
          const eligibleOrphans = orphans.filter((p) => !p.busy);
          let succeededCount = 0;
          const failures: { name: string; error: unknown }[] = [];

          for (const o of eligibleOrphans) {
            try {
              await runOperation("profiles.purgeOrphan", { name: o.name });
              succeededCount++;
            } catch (error) {
              failures.push({ name: o.name, error });
            }
          }

          if (failures.length === 0) {
            if (succeededCount > 0) {
              toast.success(
                `已彻底永久删除 ${succeededCount} 个孤儿 Profile` +
                  (busyCount > 0 ? `，跳过占用中 ${busyCount} 个` : "")
              );
            } else if (busyCount > 0) {
              toast.info(`未执行删除：跳过占用中 ${busyCount} 个`);
            }
          } else {
            toast.error(
              `彻底删除孤儿 Profile 部分失败：成功 ${succeededCount} 个，失败 ${failures.length} 个` +
                (busyCount > 0 ? `，跳过占用中 ${busyCount} 个` : ""),
              failures[0]?.error
            );
          }
        }
      }

      setActionDialog((prev) => ({ ...prev, isOpen: false }));
    } catch (err) {
      toast.error("操作执行失败", err);
    } finally {
      setActionRunning(false);
    }
  };

  return (
    <div className="page-container">
      {/* 顶部统计与操作栏 */}
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
        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "13px" }}>
          <div>
            总共: <strong>{profiles.length}</strong> 个 Profile
          </div>
          <div>
            磁盘占用: <strong>{formatBytes(totalSizeBytes)}</strong>
          </div>
          <div>
            缓存可清理: <strong style={{ color: "var(--color-primary)" }}>{formatBytes(totalCacheBytes)}</strong>
          </div>
          <div>
            孤儿 Profile: <strong style={{ color: orphanCount > 0 ? "var(--color-warning)" : "var(--text-primary)" }}>{orphanCount}</strong> 个
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* 孤儿筛选切换 */}
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={onlyOrphans}
              onChange={(e) => setOnlyOrphans(e.target.checked)}
            />
            <span>仅显示孤儿 Profile</span>
          </label>

          <button
            onClick={() =>
              setActionDialog({
                isOpen: true,
                type: "cleanCache",
                scope: "all",
              })
            }
            style={{ fontSize: "12px" }}
          >
            <span>一键清理全部缓存</span>
          </button>

          {orphanCount > 0 && (
            <button
              onClick={() =>
                setActionDialog({
                  isOpen: true,
                  type: "purge",
                  scope: "allOrphans",
                  count: orphanCount,
                })
              }
              className="btn-danger"
              style={{ fontSize: "12px" }}
            >
              <span>清空全部孤儿 ({orphanCount})</span>
            </button>
          )}

          <button onClick={requestProfileScan} disabled={profileScanning} className="btn-icon" title="重新扫描">
            <IconRefresh size={14} />
          </button>
        </div>
      </div>

      {/* Profile 表格列表主滚动区 */}
      <div className="page-scroll-body">
        {displayedProfiles.length > 0 ? (
          <div style={{ backgroundColor: "var(--bg-card)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-subtle)", backgroundColor: "rgba(0, 0, 0, 0.1)", color: "var(--text-muted)" }}>
                  <th style={{ padding: "10px 14px" }}>Profile 目录名</th>
                  <th style={{ padding: "10px 14px" }}>归属账号 / 状态</th>
                  <th style={{ padding: "10px 14px" }}>磁盘占用</th>
                  <th style={{ padding: "10px 14px" }}>可清理缓存</th>
                  <th style={{ padding: "10px 14px" }}>占用状态</th>
                  <th style={{ padding: "10px 14px", textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {displayedProfiles.map((p) => (
                  <tr key={p.name} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "10px 14px", fontWeight: 600, color: "var(--text-primary)" }}>
                      <div className="code-badge">{p.name}</div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {!p.linked ? (
                        <span
                          style={{
                            color: "var(--color-warning)",
                            backgroundColor: "var(--color-warning-bg)",
                            padding: "2px 6px",
                            borderRadius: "var(--radius-sm)",
                            fontWeight: 600,
                            fontSize: "11px",
                          }}
                        >
                          孤儿 Profile (未关联账号)
                        </span>
                      ) : (
                        <span style={{ color: "var(--color-success)", fontWeight: 500 }}>
                          已绑定账号（{p.accountLabels.join("、") || p.accountIds.join("、")}）
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 14px" }}>{formatBytes(p.bytes)}</td>
                    <td style={{ padding: "10px 14px", color: "var(--text-secondary)" }}>
                      {formatBytes(p.cacheBytes)}
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--text-muted)" }}>
                      {p.busy ? (
                        <span style={{ color: "var(--color-warning)" }}>占用中</span>
                      ) : (
                        "空闲"
                      )}
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
                        {p.cacheBytes > 0 ? (
                          <button
                            onClick={() =>
                              setActionDialog({
                                isOpen: true,
                                type: "cleanCache",
                                scope: "single",
                                targetName: p.name,
                              })
                            }
                            disabled={p.busy}
                            title={
                              p.busy
                                ? "该 Profile 正被 Chrome 或运行中的任务占用，无法清理"
                                : "清理缓存不会影响登录状态"
                            }
                            style={{ padding: "3px 8px", fontSize: "11px" }}
                          >
                            清理缓存
                          </button>
                        ) : null}

                        {!p.linked && (
                          <>
                            <button
                              onClick={() =>
                                setActionDialog({
                                  isOpen: true,
                                  type: "archive",
                                  scope: "single",
                                  targetName: p.name,
                                })
                              }
                              disabled={p.busy}
                              title={
                                p.busy
                                  ? "该 Profile 正被占用，无法归档"
                                  : "移动到 profiles-archive/，数据仍完整保留"
                              }
                              style={{ padding: "3px 8px", fontSize: "11px" }}
                            >
                              归档
                            </button>
                            <button
                              onClick={() =>
                                setActionDialog({
                                  isOpen: true,
                                  type: "purge",
                                  scope: "single",
                                  targetName: p.name,
                                })
                              }
                              className="btn-danger"
                              disabled={p.busy}
                              title={
                                p.busy
                                  ? "该 Profile 正被占用，无法删除"
                                  : "永久删除，不可恢复"
                              }
                              style={{ padding: "3px 8px", fontSize: "11px" }}
                            >
                              <IconTrash size={11} />
                              <span>彻底删除</span>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={onlyOrphans ? "没有孤儿 Profile" : "暂无 Profile 目录记录"}
            description={
              onlyOrphans
                ? "所有 Chrome 数据目录均与现有账号正常绑定。"
                : "系统将会在添加账号或登录时自动分配 Profile。"
            }
          />
        )}
      </div>

      {/* 破坏性操作二次确认对话框（明确说明具体后果与影响范围） */}
      <ConfirmDialog
        isOpen={actionDialog.isOpen}
        loading={actionRunning}
        onClose={() => {
          if (actionRunning) return;
          setActionDialog((prev) => ({ ...prev, isOpen: false }));
        }}
        onConfirm={handleExecuteAction}
        isDangerous={actionDialog.type === "purge"}
        title={
          actionDialog.type === "cleanCache"
            ? "确认清理浏览器缓存？"
            : actionDialog.type === "archive"
            ? "确认归档孤儿 Profile？"
            : "确认永久彻底删除 Profile？"
        }
        description={
          actionDialog.type === "cleanCache" ? (
            <div>
              <p>
                <strong>影响范围:</strong> 将清理 Chrome 的临时缓存文件、Code Cache 与 GPU
                缓存。
              </p>
              <p style={{ marginTop: "6px", color: "var(--color-success)" }}>
                ✓ 登录凭据保留：Cookie、Local Storage 与登录会话不会受到影响，无需重新登录。
              </p>
            </div>
          ) : actionDialog.type === "archive" ? (
            <div>
              <p>
                <strong>影响范围:</strong> 将选中的孤儿 Profile 移动至归档目录（<code>profiles-archive/</code>）。
              </p>
              <p style={{ marginTop: "6px" }}>
                ✓ 数据安全：Profile 依然完整保存在磁盘上，未来可手动恢复或关联。
              </p>
            </div>
          ) : (
            <div>
              <p style={{ color: "var(--color-danger)", fontWeight: 600 }}>
                ⚠️ 危险破坏性操作警告：
              </p>
              <p style={{ marginTop: "6px" }}>
                将永久删除 {actionDialog.scope === "allOrphans" ? `${actionDialog.count ?? "所有"} 个` : `Profile「${actionDialog.targetName}」`}
                的全部磁盘文件，包括其中的所有 Cookie、本地存储、扩展数据与历史记录。
              </p>
              <p style={{ marginTop: "6px", color: "var(--color-danger)" }}>
                ✕ 此操作不可撤销，删除后数据将无法找回！
              </p>
            </div>
          )
        }
      />
    </div>
  );
};
