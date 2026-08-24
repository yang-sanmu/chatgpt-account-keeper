// 首次启动向导页面
// 严格遵循 UI_BRIEF 第七节：
// 1. 创建全新数据 -> connect_agent({ start: true })
// 2. 预览并导入旧项目 -> inspect_legacy 预检 -> import_legacy 迁移，失败必须显示「旧目录未被修改」
// 3. 选择数据目录 -> check_data_root -> use_data_root -> 提示需要重启

import React, { useState } from "react";
import { connectAgent, inspectLegacy, importLegacy, checkDataRoot, useDataRoot } from "../../ipc/bridge";
import type { LegacyInspection, MigrationProgress } from "../../ipc/types";
import { toast } from "../../state/toastStore";
import { formatBytes } from "../../utils/format";
import { IconAlert, IconFolder } from "../../components/Common/Icons";

export interface FirstRunWizardProps {
  onComplete: () => void;
}

type WizardMode = "select" | "import_inspect" | "import_running" | "custom_data_root";

export const FirstRunWizard: React.FC<FirstRunWizardProps> = ({ onComplete }) => {
  const [mode, setMode] = useState<WizardMode>("select");
  const [loading, setLoading] = useState(false);

  // 导入旧项目状态
  const [legacyPath, setLegacyPath] = useState("");
  const [inspection, setInspection] = useState<LegacyInspection | null>(null);
  const [migrationProgress] = useState<MigrationProgress | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  // 自定义数据目录状态
  const [customDataRoot, setCustomDataRoot] = useState("");
  const [customRootCheck, setCustomRootCheck] = useState<{ ok: boolean; reason?: string | null } | null>(null);
  const [needRestart, setNeedRestart] = useState(false);

  // 1. 创建全新数据
  const handleCreateFresh = async () => {
    setLoading(true);
    try {
      await connectAgent(true);
      toast.success("已创建并初始化全新数据仓库");
      onComplete();
    } catch (err) {
      toast.error("创建全新数据失败", err);
    } finally {
      setLoading(false);
    }
  };

  // 2. 预检旧项目
  const handleInspectLegacy = async () => {
    if (!legacyPath.trim()) {
      toast.warning("请输入旧项目根目录路径");
      return;
    }
    setLoading(true);
    setMigrationError(null);
    try {
      const res = await inspectLegacy(legacyPath.trim());
      // 预检失败是一次**成功**的 invoke，返回 {ok:false, error}。不检查 ok 的话界面会
      // 显示一份全是 0 的预览，并让「确认开始导入」变成可点——用户以为是个空项目。
      if (!res.ok) {
        setInspection(null);
        toast.error(
          `无法导入所选目录：${res.error?.message ?? "旧项目预检失败"}`,
          res.error ? { code: res.error.code, message: res.error.message, retryable: false } : undefined
        );
        return;
      }
      setInspection(res);
      setMode("import_inspect");
    } catch (err) {
      toast.error("旧项目只读预检失败", err);
    } finally {
      setLoading(false);
    }
  };

  // 执行旧项目导入
  const handleStartImport = async () => {
    setLoading(true);
    setMode("import_running");
    setMigrationError(null);
    try {
      await importLegacy(legacyPath.trim());
      toast.success("旧项目迁移完成，已接回数据！");
      onComplete();
    } catch (err) {
      const errorMsg = typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : "迁移未完成";
      setMigrationError(errorMsg);
      toast.error("旧项目导入失败", err);
    } finally {
      setLoading(false);
    }
  };

  // 3. 校验并使用自定义数据目录
  const handleCheckDataRoot = async () => {
    if (!customDataRoot.trim()) {
      toast.warning("请输入自定义数据目录路径");
      return;
    }
    setLoading(true);
    try {
      const check = await checkDataRoot(customDataRoot.trim());
      setCustomRootCheck({ ok: check.ok, reason: check.reason });
      if (check.ok) {
        await useDataRoot(check.path);
        setNeedRestart(true);
        toast.success("已设置数据目录，重启应用后生效");
      } else {
        toast.error("数据目录不可用", check.reason);
      }
    } catch (err) {
      toast.error("检查数据目录失败", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--bg-app)",
        padding: "24px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "560px",
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          padding: "32px",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
            欢迎使用 ChatGPT Account Keeper
          </h2>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px" }}>
            检测到本地尚未初始化数据仓库，请选择一种方式开始：
          </p>
        </div>

        {mode === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <button
              className="btn-primary"
              style={{ padding: "14px", fontSize: "14px", justifyContent: "flex-start" }}
              onClick={handleCreateFresh}
              disabled={loading}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 600 }}>✨ 创建全新数据</div>
                <div style={{ fontSize: "12px", opacity: 0.85, marginTop: "2px" }}>
                  在默认数据目录建立全新的 SQLite 数据库与 Profile 存储
                </div>
              </div>
            </button>

            <button
              style={{ padding: "14px", fontSize: "14px", justifyContent: "flex-start" }}
              onClick={() => setMode("import_inspect")}
              disabled={loading}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                  📦 预览并导入旧项目
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                  从旧版 Express/JSON 项目中只读预检并迁移账号、Profile 与历史
                </div>
              </div>
            </button>

            <button
              style={{ padding: "14px", fontSize: "14px", justifyContent: "flex-start" }}
              onClick={() => setMode("custom_data_root")}
              disabled={loading}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                  📁 自定义数据存储目录
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                  指定其他磁盘或非系统盘路径作为应用数据存储根目录
                </div>
              </div>
            </button>
          </div>
        )}

        {/* 导入预检步骤 */}
        {mode === "import_inspect" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                旧项目根目录路径
              </label>
              <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                <input
                  type="text"
                  placeholder="例如: D:\Projects\old-chatgpt-keeper"
                  value={legacyPath}
                  onChange={(e) => setLegacyPath(e.target.value)}
                  style={{ flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleInspectLegacy();
                  }}
                />
                <button onClick={handleInspectLegacy} disabled={loading}>
                  <IconFolder size={14} />
                  <span>预检</span>
                </button>
              </div>
            </div>

            {inspection && (
              <div
                style={{
                  padding: "16px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-input)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)", marginBottom: "8px" }}>
                  旧项目只读预检结果:
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" }}>
                  <div>账号数量: <strong>{inspection.counts?.accounts ?? 0} 个</strong></div>
                  <div>Profile 数量: <strong>{inspection.counts?.profiles ?? 0} 个</strong></div>
                  <div>会话集: <strong>{inspection.counts?.conversationSets ?? 0} 组</strong></div>
                  <div>历史记录: <strong>{inspection.counts?.histories ?? 0} 条</strong></div>
                  <div>Profile 占用: <strong>{formatBytes(inspection.totalProfileBytes)}</strong></div>
                  <div>
                    需要空闲空间: <strong>{formatBytes(inspection.requiredBytes)}</strong>
                  </div>
                </div>

                {/* 源目录要显示出来：用户可能选的是 profiles 子目录，程序会自动上溯到项目根，
                    不告知的话他会以为选错了。 */}
                {inspection.sourceRoot && (
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "8px" }}>
                    源目录: {inspection.sourceRoot}
                    {inspection.selectedProfilesDirectory && "（已自动识别为 profiles 的父目录）"}
                  </div>
                )}

                {/* enoughSpace 是三态：null 表示测不出目标盘剩余空间，此时不能断言空间充足，
                    也不能断言不足。把「测不出」如实说出来，让用户自己判断。 */}
                {inspection.enoughSpace === false && (
                  <div style={{ fontSize: "12px", color: "var(--color-danger)", marginTop: "10px" }}>
                    ⚠ 目标盘剩余 {formatBytes(inspection.availableBytes ?? undefined)}，不足以完成复制式迁移。
                    请清理空间或改选其它数据目录后重试。
                  </div>
                )}
                {inspection.enoughSpace === null && (
                  <div style={{ fontSize: "12px", color: "var(--color-warning)", marginTop: "10px" }}>
                    无法测定目标盘剩余空间，请自行确认至少有 {formatBytes(inspection.requiredBytes)} 可用。
                  </div>
                )}

                {/* 运行锁：迁移会跳过 Chrome 运行锁，但这些账号的 Profile 可能复制到
                    不一致的状态。先让用户去关掉那些窗口。 */}
                {inspection.activeLocks && inspection.activeLocks.length > 0 && (
                  <div style={{ fontSize: "12px", color: "var(--color-warning)", marginTop: "10px" }}>
                    ⚠ 有 {inspection.activeLocks.length} 个 Profile 正被 Chrome 占用：
                    {inspection.activeLocks.map((lock) => lock.name).join("、")}。
                    请先关闭这些账号的浏览器窗口，否则它们的登录态可能复制不完整。
                  </div>
                )}

                <div style={{ fontSize: "11px", color: "var(--color-success)", marginTop: "10px" }}>
                  ✓ 预检过程只读，绝不修改或删除旧目录中的任何文件。
                </div>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
              <button onClick={() => setMode("select")}>返回</button>
              {inspection && (
                <button className="btn-primary" onClick={handleStartImport} disabled={loading}>
                  {loading ? "正在导入..." : "确认开始导入"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 导入执行中与失败展示 */}
        {mode === "import_running" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", textAlign: "center" }}>
            {migrationError ? (
              <div
                style={{
                  padding: "16px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--color-danger-bg)",
                  border: "1px solid var(--color-danger-border)",
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-danger)", fontWeight: 600 }}>
                  <IconAlert size={18} />
                  <span>旧项目导入未成功</span>
                </div>
                <div style={{ fontSize: "13px", color: "var(--text-primary)", marginTop: "8px" }}>
                  {migrationError}
                </div>
                {/* 规范硬性要求：必须显示旧目录未被修改 */}
                <div
                  style={{
                    marginTop: "12px",
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: "rgba(0, 0, 0, 0.2)",
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--color-success)",
                  }}
                >
                  ✓ 保障承诺：旧目录未被修改，您的原始数据完整安全。
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "14px" }}>
                  <button onClick={() => setMode("select")}>返回重新选择</button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>
                  正在执行旧数据迁移，请稍候...
                </div>
                <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
                  正在复制 Profile 与 SQLite 数据库转换，迁移期间旧数据保持只读。
                </p>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: migrationProgress?.progress
                        ? `${Math.round(migrationProgress.progress * 100)}%`
                        : "60%",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* 自定义数据目录设置 */}
        {mode === "custom_data_root" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                指定自定义数据根目录路径
              </label>
              <input
                type="text"
                placeholder="例如: D:\GptAccountKeeperData"
                value={customDataRoot}
                onChange={(e) => setCustomDataRoot(e.target.value)}
                style={{ width: "100%", marginTop: "6px" }}
              />
            </div>

            {customRootCheck && !customRootCheck.ok && (
              <div style={{ color: "var(--color-danger)", fontSize: "12px" }}>
                校验失败: {customRootCheck.reason}
              </div>
            )}

            {needRestart ? (
              <div
                style={{
                  padding: "12px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--color-success-bg)",
                  color: "var(--color-success)",
                  fontSize: "13px",
                }}
              >
                ✓ 新数据目录已记录。请关闭并重新启动本程序以完成初始化。
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button onClick={() => setMode("select")}>返回</button>
                <button className="btn-primary" onClick={handleCheckDataRoot} disabled={loading}>
                  校验并应用
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
