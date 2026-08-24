// Page 8: 偏好设置 (Settings)
// 严格遵循 UI_BRIEF：
// 1. Agent 业务设置：脏值跟踪 + 提交前校验 + 可放弃修改
// 2. 桌面客户端偏好：主题、关闭行为、开机自启、自动调度
// 3. 更新策略只有两档（notifyOnly / installAtSafePoint），绝不添加第三档
// 4. 关于与开源许可说明

import React, { useEffect, useState } from "react";
import { useApp } from "../../state/AppContext";
import type { AgentSettings, AppTheme, CloseBehavior, UpdatePolicy } from "../../ipc/types";
import { toast } from "../../state/toastStore";
import { IconCheck, IconRefresh } from "../../components/Common/Icons";

export const SettingsPage: React.FC = () => {
  const {
    agentSettings,
    updateAgentSettings,
    desktopSettings,
    updateDesktopSettings,
    startupInfo,
    connection,
    checkAppUpdate,
  } = useApp();

  // Agent 设置本地草稿状态（用于脏值跟踪与放弃修改）
  const [agentDraft, setAgentDraft] = useState<AgentSettings | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);

  useEffect(() => {
    if (agentSettings && !agentDraft) {
      setAgentDraft(agentSettings);
    }
  }, [agentSettings, agentDraft]);

  // 判断 Agent 设置是否有未保存的修改
  const isAgentDirty =
    agentDraft && agentSettings
      ? JSON.stringify(agentDraft) !== JSON.stringify(agentSettings)
      : false;

  // 保存 Agent 设置（带提交前校验）
  const handleSaveAgentSettings = async () => {
    if (!agentDraft) return;

    // 提交前校验
    if (agentDraft.intervalMinutes < 1) {
      toast.warning("自动运行间隔必须大于或等于 1 分钟");
      return;
    }
    if (agentDraft.jitterMinutes < 0) {
      toast.warning("随机抖动时间不能为负数");
      return;
    }
    if (agentDraft.statusCheckMinutes < 1) {
      toast.warning("状态巡检间隔必须大于或等于 1 分钟");
      return;
    }

    setSavingAgent(true);
    try {
      await updateAgentSettings(agentDraft);
    } catch {
      // 错误由 AppContext 处理
    } finally {
      setSavingAgent(false);
    }
  };

  // 放弃修改，还原至服务端基线
  const handleDiscardAgentSettings = () => {
    if (agentSettings) {
      setAgentDraft(agentSettings);
      toast.info("已放弃未保存的修改");
    }
  };

  return (
    <div className="page-container">
      <div className="page-scroll-body" style={{ maxWidth: "800px" }}>
        {/* 模块 1: Agent 业务参数设置 */}
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
              <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>
                Agent 后台业务配置
              </h3>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                控制后台自动对话调度周期、巡检频次与 Chrome 浏览器行为。
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={handleDiscardAgentSettings}
                disabled={!isAgentDirty || savingAgent}
                style={{ fontSize: "12px" }}
              >
                放弃修改
              </button>
              <button
                className="btn-primary"
                onClick={handleSaveAgentSettings}
                disabled={!isAgentDirty || savingAgent}
                style={{ fontSize: "12px" }}
              >
                <IconCheck size={13} />
                <span>{savingAgent ? "正在保存..." : "保存修改"}</span>
              </button>
            </div>
          </div>

          {agentDraft ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    自动运行调度间隔 (分钟)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={agentDraft.intervalMinutes}
                    onChange={(e) =>
                      setAgentDraft({
                        ...agentDraft,
                        intervalMinutes: parseInt(e.target.value, 10) || 1,
                      })
                    }
                    style={{ width: "100%", marginTop: "6px" }}
                  />
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                    每个账号完成自动对话后，进入休眠等待下一次运行的基准时间。
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    随机时间抖动 (分钟)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={agentDraft.jitterMinutes}
                    onChange={(e) =>
                      setAgentDraft({
                        ...agentDraft,
                        jitterMinutes: parseInt(e.target.value, 10) || 0,
                      })
                    }
                    style={{ width: "100%", marginTop: "6px" }}
                  />
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                    在基准间隔上追加的随机延迟范围，避免固定规律引发风控。
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    账号状态巡检周期 (分钟)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={agentDraft.statusCheckMinutes}
                    onChange={(e) =>
                      setAgentDraft({
                        ...agentDraft,
                        statusCheckMinutes: parseInt(e.target.value, 10) || 1,
                      })
                    }
                    style={{ width: "100%", marginTop: "6px" }}
                  />
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                    后台静默检查账号 Cookie 存活态与 WAF 拦截状态的间隔。
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    打开网页超时时间 (分钟)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={agentDraft.openPageTimeoutMinutes}
                    onChange={(e) =>
                      setAgentDraft({
                        ...agentDraft,
                        openPageTimeoutMinutes: parseInt(e.target.value, 10) || 0,
                      })
                    }
                    style={{ width: "100%", marginTop: "6px" }}
                  />
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                    手动打开网页保持的最大时长，0 表示不限制。
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={agentDraft.headless}
                    onChange={(e) =>
                      setAgentDraft({ ...agentDraft, headless: e.target.checked })
                    }
                  />
                  <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>
                    以无头模式 (Headless) 运行后台自动任务
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={agentDraft.statusCheckOnStartup}
                    onChange={(e) =>
                      setAgentDraft({ ...agentDraft, statusCheckOnStartup: e.target.checked })
                    }
                  />
                  <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>
                    应用启动并连接 Agent 时立即执行一次全量状态巡检
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={agentDraft.profileAutoCleanEnabled}
                    onChange={(e) =>
                      setAgentDraft({ ...agentDraft, profileAutoCleanEnabled: e.target.checked })
                    }
                  />
                  <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>
                    自动定期清理孤儿 Profile 的临时磁盘缓存
                  </span>
                </label>
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>正在加载 Agent 设置...</div>
          )}
        </div>

        {/* 模块 2: 桌面客户端设置 */}
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
            marginBottom: "24px",
          }}
        >
          <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
            桌面客户端偏好
          </h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* 主题选择 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  外观主题
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  选择界面深色、浅色模式或跟随系统设置。
                </div>
              </div>
              <select
                value={desktopSettings.theme}
                onChange={(e) => updateDesktopSettings({ theme: e.target.value as AppTheme })}
                style={{ minWidth: "140px" }}
              >
                <option value="dark">深色模式 (Dark)</option>
                <option value="light">浅色模式 (Light)</option>
                <option value="system">跟随系统 (System)</option>
              </select>
            </div>

            {/* 窗口关闭行为 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  窗口关闭按钮行为
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  点击窗口右上角关闭按钮时的默认动作。
                </div>
              </div>
              <select
                value={desktopSettings.closeBehavior}
                onChange={(e) => updateDesktopSettings({ closeBehavior: e.target.value as CloseBehavior })}
                style={{ minWidth: "140px" }}
              >
                <option value="ask">每次询问我</option>
                <option value="minimizeToTray">最小化到系统托盘</option>
                <option value="exitAll">安全退出全部程序</option>
              </select>
            </div>

            {/* 开机自启 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  系统开机自启
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  随操作系统登录时在后台启动。
                </div>
              </div>
              <input
                type="checkbox"
                checked={desktopSettings.startAtLogin}
                onChange={(e) => updateDesktopSettings({ startAtLogin: e.target.checked })}
              />
            </div>

            {/* 自动调度 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  启动时自动开始调度
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  桌面连接到 Agent 后立即自动开启账号轮换调度。
                </div>
              </div>
              <input
                type="checkbox"
                checked={desktopSettings.autoStartScheduler}
                onChange={(e) => updateDesktopSettings({ autoStartScheduler: e.target.checked })}
              />
            </div>

            {/* 更新策略（UI_BRIEF 明确规定：严格只有两档！） */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                  自动更新策略
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  应用检测到新版本的安装模式。
                </div>
              </div>
              <select
                value={desktopSettings.updatePolicy}
                onChange={(e) => updateDesktopSettings({ updatePolicy: e.target.value as UpdatePolicy })}
                style={{ minWidth: "160px" }}
              >
                <option value="notifyOnly">仅提醒 (Notify Only)</option>
                <option value="installAtSafePoint">安全空闲时自动安装 (Safe Point)</option>
              </select>
            </div>
          </div>
        </div>

        {/* 模块 3: 关于与许可 */}
        <div
          style={{
            backgroundColor: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            padding: "20px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>
                关于与开源许可
              </h3>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                ChatGPT Account Keeper · GNU AGPLv3 开源协议
              </p>
            </div>

            <button onClick={checkAppUpdate} style={{ fontSize: "12px" }}>
              <IconRefresh size={12} />
              <span>检查更新</span>
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>客户端版本:</span>
              <span className="code-badge">{startupInfo?.version ? `v${startupInfo.version}` : "-"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Agent 核心版本:</span>
              <span className="code-badge">{connection.agentVersion ? `v${connection.agentVersion}` : "-"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>IPC 协议版本:</span>
              <span className="code-badge">v1.3</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>开源协议:</span>
              <span style={{ color: "var(--text-secondary)" }}>GNU Affero General Public License v3.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
