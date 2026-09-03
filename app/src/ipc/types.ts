// 严格对齐 contracts/ipc-v1.schema.json 与 UI_BRIEF.md

import type {
  BootstrapResult,
  HistoryAccountResult,
  HistoryEntryResult,
  Operation,
  ProxyStateResult,
} from "./generated";

export type AppTheme = "dark" | "light" | "system";
export type CloseBehavior = "ask" | "minimizeToTray" | "exitAll";
export type UpdatePolicy = "notifyOnly" | "installAtSafePoint";

export interface DesktopSettings {
  theme: AppTheme;
  closeBehavior: CloseBehavior;
  startAtLogin: boolean;
  autoStartScheduler: boolean;
  updatePolicy: UpdatePolicy;
  ignoredUpdateVersion?: string | null;
  pendingLegacyImportRoot?: string | null;
}

export interface StartupInfo {
  version: string;
  dataDirectory: string;
  cacheDirectory: string;
  stateDirectory: string;
  agentLogFile: string;
  endpoint: string;
  isDevelopment: boolean;
  initialized: boolean;
  bootstrapWarning: string | null;
  settings: DesktopSettings;
}

export interface ConnectionSnapshot {
  connected: boolean;
  status: string;
  detail: string;
  agentVersion?: string | null;
  instanceId?: string | null;
}

export type SwitchRule = "random" | "sequential";
export type PromoEligibility = "free_trial" | "half_price" | "both" | "none";

export interface Account {
  id: string;
  email: string | null;
  note: string;
  enabled: boolean;
  groupId: string | null;
  groupName: string | null;
  switchRule: SwitchRule;
  minWindows: number;
  maxWindows: number;
  status: string;
  statusCheckedAt: string | null;
  stale: boolean;
  promoEligibility: PromoEligibility | null;
  promoCheckedAt: string | null;
  promoStale: boolean;
  promoCheckDetail: string | null;
  exitNode: string | null;
  exitNodeMissing: boolean;
  rotationTopic: string | null;
  rotationDone: number;
  rotationTarget: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunReason?: string | null;
  pageOpen: boolean;
  profileDir?: string;
  gptName?: string | null;
  /// Agent 认为这个账号此刻正在被占用（见契约的 accountResult.running）。
  ///
  /// 这是比「翻 operations 找非终态记录」更权威的信号：调度自己拉起的运行不一定有对应的
  /// operation 记录留在前端手里（例如前端刚连上，之前的调度已经在跑）。两个信号一起用：
  /// 这个决定「要不要标成运行中」，operations 决定「显示在跑什么」。
  running: boolean;
}

export interface AccountPatch {
  note?: string;
  groupId?: string | null;
  enabled?: boolean;
  switchRule?: SwitchRule;
  minWindows?: number;
  maxWindows?: number;
}

export interface Group {
  id: string;
  name: string;
  proxyId: string | null;
  timezone: string | null;
  locale: string | null;
}

export interface GroupPatch {
  name?: string;
  proxyId?: string | null;
  timezone?: string | null;
  locale?: string | null;
}

export type BootstrapSnapshot = BootstrapResult;

export type ProxyState = ProxyStateResult;
export type ProxyNode = ProxyStateResult["nodes"][number];
export type ProxyStatus = ProxyStateResult["status"];
export type ProxySubscription = ProxyStateResult["subscription"];
export type ProxyRuntime = ProxyStateResult["runtime"];

export interface ConversationSet {
  topic: string;
  minRounds: number;
  maxRounds: number;
}

export interface AgentSettings {
  intervalMinutes: number;
  jitterMinutes: number;
  headless: boolean;
  statusCheckMinutes: number;
  statusCheckOnStartup: boolean;
  openPageTimeoutMinutes: number;
  profileAutoCleanEnabled: boolean;
}

export interface SchedulerAccountState {
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunOk?: boolean | null;
  reason?: string | null;
  busy?: boolean;
}

export interface SchedulerState {
  running: boolean;
  enabled: boolean;
  accounts: Record<string, SchedulerAccountState>;
  lastResults?: Record<string, unknown>;
  message?: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type OperationState = Operation["state"];

export type HistoryAccount = HistoryAccountResult;
export type HistoryEntry = HistoryEntryResult;
export type HistoryRound = HistoryEntryResult["rounds"][number];

export interface QueueSnapshot {
  queuedTotal: number;
  waiting: {
    queued?: number;
    workSlot?: number;
    account?: number;
    chrome?: number;
  };
  running: number;
  closing: number;
  workSlots: { used: number; limit: number };
  chromeSlots: { used: number; limit: number };
}

export type BrowserRunPurpose =
  | "login"
  | "open-page"
  | "manual-run"
  | "scheduled-run"
  | "status-check"
  | "selector-check";

export type BrowserRunState =
  | "waiting"
  | "launching"
  | "running"
  | "closing"
  | "closed"
  | "close_failed";

/// 退出进度。由 Rust 的 exit_all 逐阶段发出。
export interface ExitProgress {
  stage: "connecting" | "draining" | "waiting" | "forcing" | "done";
  message: string;
  elapsedSeconds: number;
  /// 是否已经可以提供「强制结束」。开始几秒内刻意为 false，避免诱导用户跳过 checkpoint。
  canForce: boolean;
}

export interface DataRootCheck {
  ok: boolean;
  path: string;
  reason?: string | null;
  initialized: boolean;
}

/// 旧项目预检的计数。字段名与 `src/migration/legacyPlan.js` 的 `plan.counts` 一致。
export interface LegacyCounts {
  accounts: number;
  profiles: number;
  archivedProfiles: number;
  groups: number;
  conversationSets: number;
  proxyNodes: number;
  statuses: number;
  histories: number;
  rejects: number;
}

/// 被 Chrome 占用的 Profile。迁移会排除运行锁，但要先让用户知道哪些账号还开着。
export interface LegacyProfileLock {
  collection: string;
  name: string;
  files: string[];
}

/// `inspect_legacy` 的返回。
///
/// 形状由 `src/agent/migrationProbe.js` 决定，**不是猜的**：它输出
/// `{ok, sourceRoot, selectedProfilesDirectory, sourceFingerprint, counts, totalProfileBytes,
/// requiredBytes, availableBytes, enoughSpace, requiresTrashDecision, activeLocks}`，
/// 失败时输出 `{ok:false, error:{code, message}}`。
export interface LegacyInspection {
  ok: boolean;
  sourceRoot?: string;
  /// 用户选的是 profiles 子目录而不是项目根；程序已自动上溯到父目录。
  selectedProfilesDirectory?: boolean;
  sourceFingerprint?: string;
  counts?: LegacyCounts;
  totalProfileBytes?: number;
  /// 迁移所需的空闲空间（含安全余量），不等于 totalProfileBytes。
  requiredBytes?: number;
  availableBytes?: number | null;
  /// null 表示无法测定目标盘剩余空间，此时不应断言「空间不足」。
  enoughSpace?: boolean | null;
  requiresTrashDecision?: boolean;
  activeLocks?: LegacyProfileLock[];
  error?: { code: string; message: string };
}

export interface MigrationProgress {
  state: "running" | "complete" | "failed";
  stage: string;
  message: string;
  progress?: number | null;
  error?: ApiError | null;
}

export interface UpdateStatus {
  state: string;
  message: string;
  version?: string | null;
  notes?: string | null;
  stage?: string | null;
  percent?: number | null;
  canCancel?: boolean;
}

export type {
  IpcMethod,
  IpcParams,
  IpcResult,
  OperationMethod,
  AgentEventEnvelope,
  Operation,
  IpcError,
  ErrorCode,
  ProfileInfo,
  ProfileScanResult,
  ProxyNodeTestedPayload,
  ProfileChangedPayload,
  GroupChangedPayload,
  ConversationChangedPayload,
  SchedulerAccountChangedPayload,
  AccountResult,
  AccountArray,
  GroupResult,
  GroupArray,
  HistoryAccountResult,
  HistoryAccountArray,
  HistoryEntryResult,
  HistoryEntryArray,
  ProxyStateResult,
  SchedulerResult,
  SettingsResult,
  BootstrapResult,
  QueueSnapshotResult,
  BrowserRun,
  BrowserRunListResult,
  BrowserRunCloseResult,
} from "./generated";
