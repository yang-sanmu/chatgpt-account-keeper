// Tauri IPC 通信封装层
// 统一错误处理、窄化与幂等键生成，避免各 UI 组件分散硬编码 invoke 字符串

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  Account,
  AgentEventEnvelope,
  ApiError,
  BootstrapSnapshot,
  ConnectionSnapshot,
  DataRootCheck,
  DesktopSettings,
  LegacyCounts,
  ExitProgress,
  LegacyInspection,
  LegacyProfileLock,
  MigrationProgress,
  PromoEligibility,
  StartupInfo,
  UpdateStatus,
  IpcMethod,
  IpcParams,
  IpcResult,
} from "./types";
import { TAURI_EVENTS } from "./constants";

// 规范化后端返回的错误对象，确保无论 Rust 抛出什么都有稳定的 code 和可读 message
export function normalizeApiError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null) {
    const errObj = error as Record<string, unknown>;
    const code =
      typeof errObj.code === "string" && errObj.code.trim().length > 0
        ? errObj.code
        : "INTERNAL";
    const message =
      typeof errObj.message === "string" && errObj.message.trim().length > 0
        ? errObj.message
        : "发生了未知错误";
    const retryable = Boolean(errObj.retryable);
    return { code, message, retryable, details: errObj.details };
  }
  if (typeof error === "string") {
    return {
      code: "INTERNAL",
      message: error,
      retryable: false,
    };
  }
  return {
    code: "INTERNAL",
    message: "内部服务异常",
    retryable: false,
  };
}

// 统一业务 IPC 通道
export async function agentCall<M extends IpcMethod>(
  method: M,
  params: IpcParams<M>,
  commandId?: string
): Promise<IpcResult<M>> {
  try {
    const result = await invoke<IpcResult<M>>("agent_call", {
      method,
      params,
      commandId: commandId ?? null,
    });
    return result;
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 生成用于变更类操作的幂等键
export async function newCommandId(): Promise<string> {
  try {
    return await invoke<string>("new_command_id");
  } catch {
    // 降级为前端 UUID 生成，保证即便 Rust 桥接抖动也不影响幂等性传递
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

// 获取启动期初始信息
export async function getStartupInfo(): Promise<StartupInfo> {
  try {
    return await invoke<StartupInfo>("get_startup_info");
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 连接 Agent（start=true 会拉起新 Agent 进程）
export async function connectAgent(start: boolean): Promise<ConnectionSnapshot> {
  try {
    return await invoke<ConnectionSnapshot>("connect_agent", { start });
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 手动触发一次全量状态快照同步
export async function refreshBootstrap(): Promise<void> {
  try {
    await invoke<void>("refresh_bootstrap");
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 保存桌面客户端设置（保存至 desktop.json）
export async function saveSettings(next: DesktopSettings): Promise<void> {
  try {
    await invoke<void>("save_settings", { next });
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 停止 Agent 并安全退出应用
export async function exitAll(force = false): Promise<void> {
  try {
    await invoke<void>("exit_all", { force });
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 隐藏窗口至系统托盘
export async function hideToTray(): Promise<void> {
  try {
    await invoke<void>("hide_to_tray");
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 托盘触发需要用户选择的动作时，让承载询问框的主窗口可见。
export async function showMainWindow(): Promise<void> {
  try {
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 检查数据目录有效性
export async function checkDataRoot(path: string): Promise<DataRootCheck> {
  try {
    return await invoke<DataRootCheck>("check_data_root", { path });
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 切换并指定新的数据目录（需要重启生效）
export async function useDataRoot(path: string): Promise<void> {
  try {
    await invoke<void>("use_data_root", { path });
  } catch (error) {
    throw normalizeApiError(error);
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/// 窄化预检计数。缺字段按 0 计，因为界面要显示「0 个账号」而不是空白。
function narrowCounts(value: unknown): LegacyCounts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const count = (key: string): number => optionalNumber(raw[key]) ?? 0;
  return {
    accounts: count("accounts"),
    profiles: count("profiles"),
    archivedProfiles: count("archivedProfiles"),
    groups: count("groups"),
    conversationSets: count("conversationSets"),
    proxyNodes: count("proxyNodes"),
    statuses: count("statuses"),
    histories: count("histories"),
    rejects: count("rejects"),
  };
}

function narrowLocks(value: unknown): LegacyProfileLock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    return [
      {
        collection: optionalString(raw.collection) ?? "",
        name: optionalString(raw.name) ?? "",
        files: Array.isArray(raw.files)
          ? raw.files.filter((file): file is string => typeof file === "string")
          : [],
      },
    ];
  });
}

// 只读预检旧版本数据目录。字段名以 src/agent/migrationProbe.js 的实际输出为准。
export async function inspectLegacy(path: string): Promise<LegacyInspection> {
  try {
    const raw = await invoke<Record<string, unknown>>("inspect_legacy", { path });
    const error =
      typeof raw.error === "object" && raw.error !== null
        ? (raw.error as Record<string, unknown>)
        : undefined;
    return {
      ok: raw.ok === true,
      sourceRoot: optionalString(raw.sourceRoot),
      selectedProfilesDirectory: raw.selectedProfilesDirectory === true,
      sourceFingerprint: optionalString(raw.sourceFingerprint),
      counts: narrowCounts(raw.counts),
      totalProfileBytes: optionalNumber(raw.totalProfileBytes),
      requiredBytes: optionalNumber(raw.requiredBytes),
      // null 是合法值：表示测不出目标盘剩余空间，与「0 字节」意义完全不同。
      availableBytes: raw.availableBytes === null ? null : optionalNumber(raw.availableBytes),
      enoughSpace: raw.enoughSpace === null ? null : raw.enoughSpace === true,
      requiresTrashDecision: raw.requiresTrashDecision === true,
      activeLocks: narrowLocks(raw.activeLocks),
      error: error
        ? {
            code: optionalString(error.code) ?? "MIGRATION_PROBE_FAILED",
            message: optionalString(error.message) ?? "旧项目预检失败",
          }
        : undefined,
    };
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 导入旧版本数据
export async function importLegacy(path: string): Promise<ConnectionSnapshot> {
  try {
    return await invoke<ConnectionSnapshot>("import_legacy", { path });
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 检查应用自更新
export async function checkUpdate(): Promise<UpdateStatus> {
  try {
    return await invoke<UpdateStatus>("check_update");
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 安装应用自更新
export async function installUpdate(): Promise<void> {
  try {
    await invoke<void>("install_update");
  } catch (error) {
    throw normalizeApiError(error);
  }
}

// 同步调度状态到系统托盘菜单
export async function setSchedulerTrayState(running: boolean): Promise<void> {
  try {
    await invoke<void>("set_scheduler_tray_state", { running });
  } catch {
    // 托盘更新属于辅助通知，出错不应阻断主业务流程
  }
}

// 账号原始对象字段兼容归一化
export function normalizeAccount(raw: unknown): Account {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : String(r.accountId ?? "");
  const email = typeof r.email === "string" && r.email.length > 0 ? r.email : null;
  const note = typeof r.note === "string" ? r.note : "";
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const groupId = typeof r.groupId === "string" && r.groupId.length > 0 ? r.groupId : null;
  const groupName = typeof r.groupName === "string" ? r.groupName : null;
  const switchRule = r.switchRule === "sequential" ? "sequential" : "random";
  const minWindows = typeof r.minWindows === "number" && r.minWindows >= 1 ? r.minWindows : 1;
  const maxWindows = typeof r.maxWindows === "number" && r.maxWindows >= 1 ? r.maxWindows : 1;

  // 状态字段：可能来自 status、state 或 loggedIn
  let status = "unknown";
  if (typeof r.status === "string" && r.status.length > 0) {
    status = r.status;
  } else if (typeof r.state === "string" && r.state.length > 0) {
    status = r.state;
  } else if (r.loggedIn === false) {
    // loggedIn 只能区分登录/未登录，对应 Agent 的 out。不要合成 needs_login：
    // 那个值 Agent 从来不发（真实取值见 src/health.js），造出来只会多一个没人认识的状态。
    status = "out";
  } else if (r.loggedIn === true) {
    status = "ok";
  }

  const statusCheckedAt =
    typeof r.statusCheckedAt === "string"
      ? r.statusCheckedAt
      : typeof r.checkedAt === "string"
      ? r.checkedAt
      : null;

  const stale = Boolean(r.stale);
  const promoEligibility = (
    r.promoEligibility === "free_trial" ||
    r.promoEligibility === "half_price" ||
    r.promoEligibility === "both" ||
    r.promoEligibility === "none"
  )
    ? (r.promoEligibility satisfies PromoEligibility)
    : null;
  const promoCheckedAt =
    typeof r.promoCheckedAt === "string" ? r.promoCheckedAt : null;
  const promoStale = Boolean(r.promoStale);
  const promoCheckDetail =
    typeof r.promoCheckDetail === "string" ? r.promoCheckDetail : null;
  const exitNode =
    typeof r.exitNode === "string"
      ? r.exitNode
      : typeof r.proxyName === "string"
      ? r.proxyName
      : null;
  const exitNodeMissing = Boolean(r.exitNodeMissing || r.proxyMissing);

  const rotationTopic =
    typeof r.rotationTopic === "string"
      ? r.rotationTopic
      : typeof r.rotationCurrentSet === "string"
      ? r.rotationCurrentSet
      : null;

  const rotationDone =
    typeof r.rotationDone === "number"
      ? r.rotationDone
      : typeof r.rotationWindowsDone === "number"
      ? r.rotationWindowsDone
      : 0;

  const rotationTarget =
    typeof r.rotationTarget === "number"
      ? r.rotationTarget
      : typeof r.rotationWindowsTarget === "number"
      ? r.rotationWindowsTarget
      : 0;

  const nextRunAt = typeof r.nextRunAt === "string" ? r.nextRunAt : null;
  const lastRunAt = typeof r.lastRunAt === "string" ? r.lastRunAt : null;
  const lastRunOk = typeof r.lastRunOk === "boolean" ? r.lastRunOk : null;
  const lastRunReason =
    typeof r.lastRunReason === "string"
      ? r.lastRunReason
      : typeof r.statusDetail === "string"
      ? r.statusDetail
      : null;

  const pageOpen = Boolean(r.pageOpen);
  const running = Boolean(r.running);
  const profileDir = typeof r.profileDir === "string" ? r.profileDir : undefined;
  const gptName = typeof r.gptName === "string" ? r.gptName : null;

  return {
    id,
    email,
    note,
    enabled,
    groupId,
    groupName,
    switchRule,
    minWindows,
    maxWindows,
    status,
    statusCheckedAt,
    stale,
    promoEligibility,
    promoCheckedAt,
    promoStale,
    promoCheckDetail,
    exitNode,
    exitNodeMissing,
    rotationTopic,
    rotationDone,
    rotationTarget,
    nextRunAt,
    lastRunAt,
    lastRunOk,
    lastRunReason,
    pageOpen,
    profileDir,
    gptName,
    running,
  };
}

// 统一监听各种 Tauri 事件
export async function subscribeTauriEvents(handlers: {
  onBootstrap?: (snapshot: BootstrapSnapshot) => void;
  onAgentEvent?: (event: AgentEventEnvelope) => void;
  onConnection?: (conn: ConnectionSnapshot) => void;
  onMigration?: (progress: MigrationProgress) => void;
  onUpdate?: (update: UpdateStatus) => void;
  onTrayAction?: (action: string) => void;
  onCloseRequested?: () => void;
  onExitProgress?: (progress: ExitProgress) => void;
}): Promise<UnlistenFn[]> {
  const unlisteners: UnlistenFn[] = [];

  if (handlers.onBootstrap) {
    unlisteners.push(
      await listen<BootstrapSnapshot>(TAURI_EVENTS.BOOTSTRAP, (e) => {
        handlers.onBootstrap?.(e.payload);
      })
    );
  }

  if (handlers.onAgentEvent) {
    unlisteners.push(
      await listen<AgentEventEnvelope>(TAURI_EVENTS.AGENT_EVENT, (e) => {
        handlers.onAgentEvent?.(e.payload);
      })
    );
  }

  if (handlers.onConnection) {
    unlisteners.push(
      await listen<ConnectionSnapshot>(TAURI_EVENTS.CONNECTION, (e) => {
        handlers.onConnection?.(e.payload);
      })
    );
  }

  if (handlers.onMigration) {
    unlisteners.push(
      await listen<MigrationProgress>(TAURI_EVENTS.MIGRATION, (e) => {
        handlers.onMigration?.(e.payload);
      })
    );
  }

  if (handlers.onUpdate) {
    unlisteners.push(
      await listen<UpdateStatus>(TAURI_EVENTS.UPDATE, (e) => {
        handlers.onUpdate?.(e.payload);
      })
    );
  }

  if (handlers.onTrayAction) {
    unlisteners.push(
      await listen<string>(TAURI_EVENTS.TRAY_ACTION, (e) => {
        handlers.onTrayAction?.(e.payload);
      })
    );
  }

  if (handlers.onExitProgress) {
    unlisteners.push(
      await listen<ExitProgress>(TAURI_EVENTS.EXIT, (event) => {
        handlers.onExitProgress?.(event.payload);
      })
    );
  }

  if (handlers.onCloseRequested) {
    unlisteners.push(
      await listen<void>(TAURI_EVENTS.CLOSE_REQUESTED, () => {
        handlers.onCloseRequested?.();
      })
    );
  }

  return unlisteners;
}
