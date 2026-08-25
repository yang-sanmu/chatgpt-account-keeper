// 前端 IPC 类型契约与数据模型定义
// 严格对齐 contracts/ipc-v1.schema.json 与 UI_BRIEF.md

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

/// 代理节点。字段名与 `src/proxyManager.js` 的 `getNodes()` 一致。
///
/// 注意测速结果有**两种形状**：这里是 `proxies.getState` 返回的
/// `latencyMs / latencyOk / latencyMessage / latencyTestedAt`，而 `proxyNode.tested`
/// 事件的 payload 是 `{ id, ok, delay, message, testedAt }`（来自 rememberLatency）。
/// 两者必须显式转换，直接读事件里的 `latencyMs` 会永远拿到 undefined。
export interface ProxyNode {
  id: string;
  name: string;
  /// 订阅里缺字段时为 null，界面要能显示「—」而不是 "null:null"。
  server: string | null;
  port: number | null;
  type: string | null;
  enabled: boolean;
  /// 订阅刷新后节点消失。仍留在列表里，但不能被分组引用。
  missing: boolean;
  latencyMs: number | null;
  latencyOk: boolean | null;
  latencyMessage: string | null;
  latencyTestedAt: string | null;
  /// 只有被分组实际引用且启用的节点才有边车监听端口；测速走独立临时进程。
  localPort: number | null;
}

/// `proxyNode.tested` 事件的 payload。与上面的节点字段名不同，见 ProxyNode 的说明。
export interface ProxyNodeTestedPayload {
  id: string;
  ok?: boolean;
  delay?: number | null;
  message?: string | null;
  testedAt?: string;
}

export interface ProxySubscription {
  url?: string;
  updatedAt?: string | null;
  nodeCount?: number;
}

export interface ProxyRuntime {
  directory?: string;
  clashVergeDir?: string;
}

export interface ProxyStatus {
  running: boolean;
  localPort?: number;
  error?: string | null;
}

export interface ProxyState {
  nodes: ProxyNode[];
  status: ProxyStatus;
  subscription: ProxySubscription | null;
  runtime: ProxyRuntime | null;
}

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
}

export interface SchedulerState {
  running: boolean;
  enabled: boolean;
  accounts: Record<string, SchedulerAccountState>;
  lastResults?: Record<string, unknown>;
  message?: string;
}

export type OperationState =
  | "queued"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface Operation {
  id: string;
  kind: string;
  resourceId: string | null;
  state: OperationState;
  stage: string | null;
  effectiveSource: "manual" | "scheduled" | "background" | null;
  message: string | null;
  progress: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  result?: unknown;
  error?: ApiError | null;
  blocksUpdate: boolean;
}

export interface HistoryRound {
  question: string | null;
  answer: string | null;
  at: string | null;
}

export interface HistoryEntry {
  time: string | null;
  ok: boolean | null;
  setName: string | null;
  topic: string | null;
  totalRounds: number;
  targetRounds: number | null;
  stopReason: string | null;
  error: string | null;
  needReauth: boolean;
  rounds: HistoryRound[];
}

export interface HistoryAccount {
  accountId: string;
  entryCount: number;
  deleted: boolean;
  lastAt: string | null;
  lastOk: boolean | null;
  note: string | null;
  email: string | null;
  gptName: string | null;
}

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

export interface BrowserRun {
  browserRunId: string;
  accountId: string;
  operationId: string | null;
  purpose: BrowserRunPurpose;
  effectiveSource: string | null;
  profilePath: string | null;
  rootPid: number | null;
  rootStartTime: number | null;
  startedAt: string;
  state: BrowserRunState;
  closeReason: string | null;
  closeError: string | null;
}

export interface BrowserRunListResult {
  active: BrowserRun[];
  recent: BrowserRun[];
  chromeOccupancy: number;
  quarantined: unknown[];
}

export interface ProfileInfo {
  name: string;
  path: string;
  sizeBytes: number;
  isOrphan: boolean;
  linkedAccountId?: string | null;
  cacheSizeBytes?: number;
  lastUsedAt?: string | null;
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

export interface BootstrapSnapshot {
  instanceId: string;
  revision: number;
  accounts: unknown[];
  statuses?: Record<string, unknown>;
  openPages?: Record<string, boolean>;
  groups: Group[];
  proxies: ProxyState;
  conversations: Record<string, ConversationSet>;
  scheduler: SchedulerState;
  settings: AgentSettings;
  operations: Operation[];
  activeOperations?: Operation[];
  historyAccounts: HistoryAccount[];
  draining: boolean;
  protocol?: unknown;
  agentVersion?: string;
}

export interface AgentEventEnvelope {
  name: string;
  seq?: number;
  instanceId?: string;
  occurredAt?: string;
  payload: unknown;
}
