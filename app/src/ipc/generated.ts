/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * Sources: contracts/ipc-v1.schema.json, contracts/ipc-v1.methods.schema.json,
 *          src/agent/methodContracts.js
 * Regenerate with: npm run ipc:generate
 */

/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "historyEntryArray".
 */
export type HistoryEntryArray = HistoryEntryResult[];
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountArray".
 */
export type AccountArray = AccountResult[];
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "groupArray".
 */
export type GroupArray = GroupResult[];
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "historyAccountArray".
 */
export type HistoryAccountArray = HistoryAccountResult[];
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "jsonValue".
 */
export type JsonValue = unknown;
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "errorCode".
 */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "RESOURCE_BUSY"
  | "PROFILE_IN_USE"
  | "PROXY_UNAVAILABLE"
  | "ALREADY_OPEN"
  | "LOGIN_FORCE_CONFLICT"
  | "CHROME_NOT_FOUND"
  | "AGENT_DRAINING"
  | "PROTOCOL_MISMATCH"
  | "FRAME_TOO_LARGE"
  | "INTERNAL";
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "operationArray".
 */
export type OperationArray = Operation[];
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "method".
 */
export type Method =
  | "system.hello"
  | "system.bootstrap"
  | "system.getActivity"
  | "system.prepareUpdate"
  | "system.shutdown"
  | "accounts.list"
  | "accounts.create"
  | "accounts.update"
  | "accounts.remove"
  | "accounts.getStatus"
  | "accounts.refreshStatus"
  | "accounts.runNow"
  | "accounts.checkSelectors"
  | "browser.startLogin"
  | "browser.getTask"
  | "browser.openPage"
  | "browser.closePage"
  | "browser.listOpenPages"
  | "accounts.history"
  | "history.query"
  | "history.listAccounts"
  | "groups.list"
  | "groups.create"
  | "groups.update"
  | "groups.remove"
  | "proxies.getState"
  | "proxies.importSubscription"
  | "proxies.refreshSubscription"
  | "proxies.setRuntimeDirectory"
  | "proxies.setNodeEnabled"
  | "proxies.testNode"
  | "proxies.testAll"
  | "profiles.scan"
  | "profiles.cleanCache"
  | "profiles.archiveOrphan"
  | "profiles.purgeOrphan"
  | "conversations.list"
  | "conversations.upsert"
  | "conversations.remove"
  | "scheduler.getState"
  | "scheduler.start"
  | "scheduler.stop"
  | "settings.get"
  | "settings.update"
  | "operations.get"
  | "operations.listActive"
  | "operations.list"
  | "queue.getSnapshot"
  | "browserRuns.list"
  | "browserRuns.close";
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "eventName".
 */
export type EventName =
  | "account.changed"
  | "account.removed"
  | "accountStatus.changed"
  | "openPage.changed"
  | "operation.changed"
  | "group.changed"
  | "proxyState.changed"
  | "proxyNode.tested"
  | "profile.changed"
  | "conversation.changed"
  | "scheduler.changed"
  | "scheduler.accountChanged"
  | "history.appended"
  | "settings.changed"
  | "agent.draining"
  | "agent.readyForUpdate"
  | "queue.changed"
  | "browserRun.changed";
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "proxyNodeTestedPayload".
 */
export type ProxyNodeTestedPayload =
  | {
      id: string;
      ok: true;
      delay: number | null;
      testedAt: string;
    }
  | {
      id: string;
      ok: false;
      message: string;
      testedAt: string;
    };
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "profileChangedPayload".
 */
export type ProfileChangedPayload =
  | {
      kind: "profile-scan";
      name: null;
      result: ProfileScanResult;
    }
  | {
      kind: "profile-cache-clean" | "profile-orphan-archive" | "profile-orphan-purge";
      name: string | null;
      result: JsonValue;
    };
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "groupChangedPayload".
 */
export type GroupChangedPayload =
  | GroupResult
  | {
      id: string;
      removed: true;
    };
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "conversationChangedPayload".
 */
export type ConversationChangedPayload =
  | {
      name: string;
      set: ConversationResult;
    }
  | {
      name: string;
      removed: true;
    };
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "event".
 */
export type Event =
  | (EventBase & {
      event: "operation.changed";
      payload: Operation;
    })
  | (EventBase & {
      event: "proxyNode.tested";
      payload: ProxyNodeTestedPayload;
    })
  | (EventBase & {
      event: "profile.changed";
      payload: ProfileChangedPayload;
    })
  | (EventBase & {
      event: "group.changed";
      payload: GroupChangedPayload;
    })
  | (EventBase & {
      event: "conversation.changed";
      payload: ConversationChangedPayload;
    })
  | (EventBase & {
      event: "scheduler.accountChanged";
      payload: SchedulerAccountChangedPayload;
    })
  | (EventBase & {
      event:
        | "account.changed"
        | "account.removed"
        | "accountStatus.changed"
        | "openPage.changed"
        | "proxyState.changed"
        | "scheduler.changed"
        | "history.appended"
        | "settings.changed"
        | "agent.draining"
        | "agent.readyForUpdate"
        | "queue.changed"
        | "browserRun.changed";
    });

export interface KeeperIPCV1GeneratedSchema {
  emptyParams?: EmptyParams;
  openPageMap?: OpenPageMap;
  loginTaskResult?: LoginTaskResult;
  accountResult?: AccountResult;
  historyEntryResult?: HistoryEntryResult;
  historyEntryArray?: HistoryEntryArray;
  accountArray?: AccountArray;
  accountStatusResult?: AccountStatusResult;
  groupResult?: GroupResult;
  groupArray?: GroupArray;
  conversationResult?: ConversationResult;
  conversationMap?: ConversationMap;
  settingsResult?: SettingsResult;
  schedulerResult?: SchedulerResult;
  historyAccountResult?: HistoryAccountResult;
  historyAccountArray?: HistoryAccountArray;
  proxyStateResult?: ProxyStateResult;
  okResult?: OkResult;
  acceptedResult?: AcceptedResult;
  operationResult?: Operation;
  operationArray?: OperationArray;
  idParams?: IdParams;
  selectorCheckParams?: SelectorCheckParams;
  taskIdParams?: TaskIdParams;
  operationListParams?: OperationListParams;
  queueSnapshotResult?: QueueSnapshotResult;
  browserRun?: BrowserRun;
  browserRunListResult?: BrowserRunListResult;
  browserRunCloseParams?: BrowserRunCloseParams;
  browserRunCloseResult?: BrowserRunCloseResult;
  accountIdParams?: AccountIdParams;
  helloParams?: HelloParams;
  helloResult?: HelloResult;
  prepareUpdateParams?: PrepareUpdateParams;
  prepareUpdateResult?: PrepareUpdateResult;
  shutdownParams?: ShutdownParams;
  bootstrapResult?: BootstrapResult;
  activityResult?: ActivityResult;
  accountPatch?: AccountPatch;
  accountCreateParams?: AccountPatch;
  accountUpdateParams?: AccountUpdateParams;
  accountRemoveParams?: AccountRemoveParams;
  loginParams?: LoginParams;
  historyQueryParams?: HistoryQueryParams;
  groupCreateParams?: GroupCreateParams;
  groupUpdateParams?: GroupUpdateParams;
  subscriptionParams?: SubscriptionParams;
  runtimeDirectoryParams?: RuntimeDirectoryParams;
  nodeEnabledParams?: NodeEnabledParams;
  profileCleanParams?: ProfileCleanParams;
  nameParams?: NameParams;
  conversationUpsertParams?: ConversationUpsertParams;
  settingsUpdateParams?: SettingsUpdateParams;
  jsonValue?: JsonValue;
  protocolVersion?: ProtocolVersion;
  method?: Method;
  request?: Request;
  successResponse?: SuccessResponse;
  errorCode?: ErrorCode;
  ipcError?: IpcError;
  errorResponse?: ErrorResponse;
  eventName?: EventName;
  eventBase?: EventBase;
  proxyNodeTestedPayload?: ProxyNodeTestedPayload;
  profileInfo?: ProfileInfo;
  profileScanResult?: ProfileScanResult;
  profileChangedPayload?: ProfileChangedPayload;
  groupChangedPayload?: GroupChangedPayload;
  conversationChangedPayload?: ConversationChangedPayload;
  schedulerAccountChangedPayload?: SchedulerAccountChangedPayload;
  event?: Event;
  operation?: Operation;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "emptyParams".
 */
export interface EmptyParams {}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "openPageMap".
 */
export interface OpenPageMap {
  [k: string]: {
    url: string;
    openedAt: string;
  };
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "loginTaskResult".
 */
export interface LoginTaskResult {
  accountId: string;
  force: boolean;
  status: "opening" | "clearing" | "waiting" | "saving" | "success" | "failed" | "timeout";
  message: string;
  startedAt: string;
  finishedAt?: string;
  code?: string;
  conflictTaskId?: string;
  email?: string | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountResult".
 */
export interface AccountResult {
  id: string;
  sortOrder?: number;
  note?: string;
  email?: string | null;
  gptName?: string | null;
  profileName?: string;
  profileDir?: string;
  groupId?: string | null;
  enabled: boolean;
  switchRule: "random" | "sequential";
  minWindows: number;
  maxWindows: number;
  rotation?: {
    currentSet: string | null;
    windowsDone: number;
    windowsTarget: number;
  };
  state: "ok" | "reauth" | "out" | "unknown" | null;
  loggedIn: boolean;
  statusDetail: string | null;
  checkedAt: string | null;
  stale: boolean;
  lastCheckState: "ok" | "reauth" | "out" | "unknown" | null;
  lastCheckDetail: string | null;
  confirmedState: "ok" | "reauth" | "out" | null;
  confirmedAt: string | null;
  consecutiveUnknowns: number;
  unknownSince: string | null;
  promoEligibility: "free_trial" | "half_price" | "both" | "none" | null;
  promoCheckedAt: string | null;
  promoStale: boolean;
  promoCheckDetail: string | null;
  pageOpen: boolean;
  rotationCurrentSet: string | null;
  rotationWindowsDone: number;
  rotationWindowsTarget: number;
  groupName: string | null;
  proxyId: string | null;
  proxyName: string | null;
  proxyMissing: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  running: boolean;
  lastRunOk: boolean | null;
  lastRunReason: string | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "historyEntryResult".
 */
export interface HistoryEntryResult {
  time: string | null;
  ok: boolean | null;
  setName: string | null;
  topic: string | null;
  totalRounds: number;
  targetRounds: number | null;
  stopReason: string | null;
  error: string | null;
  needReauth: boolean;
  rounds: {
    question: string | null;
    answer: string | null;
    at: string | null;
  }[];
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountStatusResult".
 */
export interface AccountStatusResult {
  id: string;
  state: "ok" | "reauth" | "out" | "unknown" | null;
  loggedIn: boolean;
  email: string | null;
  detail: string | null;
  checkedAt: string | null;
  stale: boolean;
  lastCheckState: "ok" | "reauth" | "out" | "unknown" | null;
  lastCheckDetail: string | null;
  confirmedState: "ok" | "reauth" | "out" | null;
  confirmedAt: string | null;
  consecutiveUnknowns: number;
  unknownSince: string | null;
  promoEligibility: "free_trial" | "half_price" | "both" | "none" | null;
  promoCheckedAt: string | null;
  promoStale: boolean;
  promoCheckDetail: string | null;
  skipped: boolean;
  skipKind: string | null;
  skipReason: string | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "groupResult".
 */
export interface GroupResult {
  id: string;
  sortOrder?: number;
  name: string;
  proxyId: string | null;
  timezone: string | null;
  locale: string | null;
  tzManual?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "conversationResult".
 */
export interface ConversationResult {
  id?: string;
  sortOrder?: number;
  topic: string;
  minRounds: number;
  maxRounds: number;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "conversationMap".
 */
export interface ConversationMap {
  [k: string]: {
    topic: string;
    minRounds: number;
    maxRounds: number;
  };
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "settingsResult".
 */
export interface SettingsResult {
  intervalMinutes: number;
  jitterMinutes: number;
  headless: boolean;
  statusCheckMinutes: number;
  statusCheckOnStartup: boolean;
  openPageTimeoutMinutes: number;
  profileAutoCleanEnabled: boolean;
  schedulerEnabled?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "schedulerResult".
 */
export interface SchedulerResult {
  running: boolean;
  enabled: boolean;
  accounts: {
    [k: string]: {
      nextAt: string | null;
      lastAt: string | null;
      busy: boolean;
    };
  };
  lastResults: {
    [k: string]: {
      ok: boolean;
      reason: string | null;
      time: string;
    };
  };
  message?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "historyAccountResult".
 */
export interface HistoryAccountResult {
  accountId: string;
  entryCount: number;
  deleted: boolean;
  lastAt?: string | null;
  lastOk?: boolean | null;
  note?: string | null;
  email?: string | null;
  gptName?: string | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "proxyStateResult".
 */
export interface ProxyStateResult {
  nodes: {
    id: string;
    name: string;
    type: string | null;
    server: string | null;
    port: number | null;
    enabled: boolean;
    missing: boolean;
    latencyMs: number | null;
    latencyOk: boolean | null;
    latencyMessage: string | null;
    latencyTestedAt: string | null;
    localPort: number | null;
  }[];
  status: {
    running: boolean;
    mihomo: {
      path: string | null;
      found: boolean;
    };
    nodeCount: number;
    routedNodeCount: number;
    subscription: {
      configured: true;
      host: string;
      updatedAt: string | null;
      count: number;
    } | null;
    clashVergeDir: string | null;
    basePort: number;
    basePortShifted: boolean;
  };
  subscription: {
    configured: true;
    host: string;
    updatedAt: string | null;
    count: number;
  } | null;
  runtime: {
    path: string | null;
    found: boolean;
  } | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "okResult".
 */
export interface OkResult {
  ok: boolean;
  profile?: JsonValue;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "acceptedResult".
 */
export interface AcceptedResult {
  accepted: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "operationResult".
 *
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "operation".
 */
export interface Operation {
  id: string;
  kind: string;
  resourceId: string | null;
  state: "queued" | "running" | "waiting_user" | "succeeded" | "failed" | "timed_out" | "cancelled";
  stage: string | null;
  effectiveSource?: "manual" | "scheduled" | "background" | null;
  message: string | null;
  progress: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  result: JsonValue;
  error: IpcError | null;
  blocksUpdate: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "ipcError".
 */
export interface IpcError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "idParams".
 */
export interface IdParams {
  id: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "selectorCheckParams".
 */
export interface SelectorCheckParams {
  id: string;
  deep?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "taskIdParams".
 */
export interface TaskIdParams {
  taskId: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "operationListParams".
 */
export interface OperationListParams {
  limit?: number;
  includeTerminal?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "queueSnapshotResult".
 */
export interface QueueSnapshotResult {
  queuedTotal: number;
  waiting: {
    queued: number;
    workSlot: number;
    account: number;
    chrome: number;
  };
  running: number;
  closing: number;
  workSlots: {
    used: number;
    limit: number;
  };
  chromeSlots: {
    used: number;
    limit: number;
  };
  bySource: {
    [k: string]: number;
  };
  byWorkKind: {
    [k: string]: number;
  };
  admissionPaused: boolean;
  browserRuns?: {
    active: number;
    byPurpose: {
      [k: string]: number;
    };
  };
  broker?: {
    running: boolean;
    generationId: string | null;
  } | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "browserRun".
 */
export interface BrowserRun {
  browserRunId: string;
  accountId: string;
  operationId: string | null;
  purpose: "login" | "open-page" | "manual-run" | "scheduled-run" | "status-check" | "selector-check";
  effectiveSource: string | null;
  profilePath: string | null;
  rootPid: number | null;
  rootStartTime: number | null;
  debugEndpointFingerprint: string | null;
  launcherRunToken: string | null;
  brokerGenerationId: string | null;
  startedAt: string;
  state: "waiting" | "launching" | "running" | "closing" | "closed" | "close_failed";
  closeReason: string | null;
  closeError: string | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "browserRunListResult".
 */
export interface BrowserRunListResult {
  active: BrowserRun[];
  recent: BrowserRun[];
  chromeOccupancy: number;
  quarantined: {
    accountId: string;
    reason: string;
  }[];
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "browserRunCloseParams".
 */
export interface BrowserRunCloseParams {
  browserRunId: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "browserRunCloseResult".
 */
export interface BrowserRunCloseResult {
  ok: boolean;
  run: BrowserRun | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountIdParams".
 */
export interface AccountIdParams {
  accountId: string;
  url?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "helloParams".
 */
export interface HelloParams {
  protocol: ProtocolVersion;
  clientVersion: string;
  capabilities: string[];
  authToken?: string;
  dataRoot?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "protocolVersion".
 */
export interface ProtocolVersion {
  major: number;
  minor: number;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "helloResult".
 */
export interface HelloResult {
  protocol: {
    major: 1;
    minMinor: number;
    maxMinor: number;
  };
  agentVersion: string;
  buildId: string;
  dataSchemaVersion: number;
  instanceId: string;
  dataRoot: string | null;
  capabilities: string[];
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "prepareUpdateParams".
 */
export interface PrepareUpdateParams {
  commit?: boolean;
  reason?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "prepareUpdateResult".
 */
export interface PrepareUpdateResult {
  ready: boolean;
  committed?: boolean;
  draining: boolean;
  scheduler: SchedulerResult;
  openPages: OpenPageMap;
  operations: OperationArray;
  blockers: {
    kind: "open-page" | "operation" | "account-busy" | "chrome-reclaim-failed";
    resourceId: string;
    detail: JsonValue;
  }[];
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "shutdownParams".
 */
export interface ShutdownParams {
  reason?: string;
  force?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "bootstrapResult".
 */
export interface BootstrapResult {
  instanceId: string;
  revision: number;
  accounts: AccountArray;
  statuses: {
    [k: string]: {
      state: "ok" | "reauth" | "out" | "unknown" | null;
      loggedIn: boolean | null;
      email: string | null;
      detail: string | null;
      checkedAt: string | null;
      lastCheckState: "ok" | "reauth" | "out" | "unknown" | null;
      lastCheckDetail: string | null;
      confirmedState: "ok" | "reauth" | "out" | null;
      confirmedAt: string | null;
      consecutiveUnknowns: number;
      unknownSince: string | null;
      stale: boolean;
      promoEligibility: "free_trial" | "half_price" | "both" | "none" | null;
      promoCheckedAt: string | null;
      promoStale: boolean;
      promoCheckDetail: string | null;
    };
  };
  openPages: OpenPageMap;
  groups: GroupArray;
  proxies: ProxyStateResult;
  conversations: ConversationMap;
  scheduler: SchedulerResult;
  settings: SettingsResult;
  operations: OperationArray;
  activeOperations: OperationArray;
  historyAccounts: HistoryAccountArray;
  draining: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "activityResult".
 */
export interface ActivityResult {
  draining: boolean;
  scheduler: SchedulerResult;
  openPages: OpenPageMap;
  operations: OperationArray;
  blockers: {
    kind: "open-page" | "operation" | "account-busy" | "chrome-reclaim-failed";
    resourceId: string;
    detail: JsonValue;
  }[];
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountPatch".
 *
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountCreateParams".
 */
export interface AccountPatch {
  note?: string;
  groupId?: string | null;
  enabled?: boolean;
  switchRule?: "random" | "sequential";
  minWindows?: number;
  maxWindows?: number;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountUpdateParams".
 */
export interface AccountUpdateParams {
  id: string;
  patch: AccountPatch;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "accountRemoveParams".
 */
export interface AccountRemoveParams {
  id: string;
  profileAction?: "detach" | "archive" | "purge";
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "loginParams".
 */
export interface LoginParams {
  accountId: string;
  force?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "historyQueryParams".
 */
export interface HistoryQueryParams {
  accountId: string;
  limit?: number;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "groupCreateParams".
 */
export interface GroupCreateParams {
  name: string;
  proxyId?: string | null;
  timezone?: string | null;
  locale?: string | null;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "groupUpdateParams".
 */
export interface GroupUpdateParams {
  id: string;
  patch: {
    name?: string;
    proxyId?: string | null;
    timezone?: string | null;
    locale?: string | null;
  };
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "subscriptionParams".
 */
export interface SubscriptionParams {
  url: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "runtimeDirectoryParams".
 */
export interface RuntimeDirectoryParams {
  directory?: string;
  clashVergeDir?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "nodeEnabledParams".
 */
export interface NodeEnabledParams {
  id: string;
  enabled: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "profileCleanParams".
 */
export interface ProfileCleanParams {
  scope?: "all" | "linked" | "orphan";
  name?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "nameParams".
 */
export interface NameParams {
  name: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "conversationUpsertParams".
 */
export interface ConversationUpsertParams {
  name: string;
  set: {
    topic: string;
    minRounds: number;
    maxRounds: number;
  };
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "settingsUpdateParams".
 */
export interface SettingsUpdateParams {
  patch?: {
    intervalMinutes?: number;
    jitterMinutes?: number;
    headless?: boolean;
    statusCheckMinutes?: number;
    statusCheckOnStartup?: boolean;
    openPageTimeoutMinutes?: number;
    profileAutoCleanEnabled?: boolean;
  };
  intervalMinutes?: number;
  jitterMinutes?: number;
  headless?: boolean;
  statusCheckMinutes?: number;
  statusCheckOnStartup?: boolean;
  openPageTimeoutMinutes?: number;
  profileAutoCleanEnabled?: boolean;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "request".
 */
export interface Request {
  id: string;
  method: Method;
  params: {};
  commandId?: string;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "successResponse".
 */
export interface SuccessResponse {
  id: string;
  result: JsonValue;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "errorResponse".
 */
export interface ErrorResponse {
  id: string | null;
  error: IpcError;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "eventBase".
 */
export interface EventBase {
  event: EventName;
  seq: number;
  instanceId: string;
  revision: number;
  occurredAt: string;
  payload: JsonValue;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "profileInfo".
 */
export interface ProfileInfo {
  name: string;
  linked: boolean;
  accountIds: string[];
  accountLabels: string[];
  nonStandardReference: boolean;
  busy: boolean;
  bytes: number;
  files: number;
  cacheBytes: number;
  cacheFiles: number;
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "profileScanResult".
 */
export interface ProfileScanResult {
  profiles: ProfileInfo[];
  orphans: ProfileInfo[];
  totals: {
    profiles: number;
    linked: number;
    orphans: number;
    bytes: number;
    cacheBytes: number;
    orphanBytes: number;
    archiveCount: number;
    archiveBytes: number;
    trashCount: number;
    trashBytes: number;
  };
}
/**
 * This interface was referenced by `KeeperIPCV1GeneratedSchema`'s JSON-Schema
 * via the `definition` "schedulerAccountChangedPayload".
 */
export interface SchedulerAccountChangedPayload {
  accountId: string;
  nextAt: string | null;
  lastAt: string | null;
  busy: boolean;
  lastResultState: "succeeded" | "failed" | null;
  lastResult: {
    ok: boolean;
    reason: string | null;
    time: string;
  } | null;
}

export interface IpcMethodContracts {
  "system.hello": { params: HelloParams; result: HelloResult };
  "system.bootstrap": { params: Record<string, never>; result: BootstrapResult };
  "system.getActivity": { params: Record<string, never>; result: ActivityResult };
  "system.prepareUpdate": { params: PrepareUpdateParams; result: PrepareUpdateResult };
  "system.shutdown": { params: ShutdownParams; result: AcceptedResult };
  "accounts.list": { params: Record<string, never>; result: AccountArray };
  "accounts.create": { params: AccountPatch; result: AccountResult };
  "accounts.update": { params: AccountUpdateParams; result: AccountResult };
  "accounts.remove": { params: AccountRemoveParams; result: OkResult };
  "accounts.getStatus": { params: IdParams; result: AccountStatusResult };
  "accounts.refreshStatus": { params: IdParams; result: Operation };
  "accounts.runNow": { params: IdParams; result: Operation };
  "accounts.checkSelectors": { params: SelectorCheckParams; result: Operation };
  "browser.startLogin": { params: LoginParams; result: Operation };
  "browser.openPage": { params: AccountIdParams; result: Operation };
  "browser.closePage": { params: AccountIdParams; result: OkResult };
  "browser.listOpenPages": { params: Record<string, never>; result: OpenPageMap };
  "browser.getTask": { params: TaskIdParams; result: LoginTaskResult };
  "history.query": { params: HistoryQueryParams; result: HistoryEntryArray };
  "accounts.history": { params: HistoryQueryParams; result: HistoryEntryArray };
  "history.listAccounts": { params: Record<string, never>; result: HistoryAccountArray };
  "groups.list": { params: Record<string, never>; result: GroupArray };
  "groups.create": { params: GroupCreateParams; result: GroupResult };
  "groups.update": { params: GroupUpdateParams; result: GroupResult };
  "groups.remove": { params: IdParams; result: OkResult };
  "proxies.getState": { params: Record<string, never>; result: ProxyStateResult };
  "proxies.importSubscription": { params: SubscriptionParams; result: Operation };
  "proxies.refreshSubscription": { params: Record<string, never>; result: Operation };
  "proxies.setRuntimeDirectory": { params: RuntimeDirectoryParams; result: Operation };
  "proxies.setNodeEnabled": { params: NodeEnabledParams; result: Operation };
  "proxies.testNode": { params: IdParams; result: Operation };
  "proxies.testAll": { params: Record<string, never>; result: Operation };
  "profiles.scan": { params: Record<string, never>; result: Operation };
  "profiles.cleanCache": { params: ProfileCleanParams; result: Operation };
  "profiles.archiveOrphan": { params: NameParams; result: Operation };
  "profiles.purgeOrphan": { params: NameParams; result: Operation };
  "conversations.list": { params: Record<string, never>; result: ConversationMap };
  "conversations.upsert": { params: ConversationUpsertParams; result: ConversationResult };
  "conversations.remove": { params: NameParams; result: OkResult };
  "scheduler.getState": { params: Record<string, never>; result: SchedulerResult };
  "scheduler.start": { params: Record<string, never>; result: SchedulerResult };
  "scheduler.stop": { params: Record<string, never>; result: SchedulerResult };
  "settings.get": { params: Record<string, never>; result: SettingsResult };
  "settings.update": { params: SettingsUpdateParams; result: SettingsResult };
  "operations.get": { params: IdParams; result: Operation };
  "operations.listActive": { params: Record<string, never>; result: OperationArray };
  "operations.list": { params: OperationListParams; result: OperationArray };
  "queue.getSnapshot": { params: Record<string, never>; result: QueueSnapshotResult };
  "browserRuns.list": { params: Record<string, never>; result: BrowserRunListResult };
  "browserRuns.close": { params: BrowserRunCloseParams; result: BrowserRunCloseResult };
}

export type IpcMethod = keyof IpcMethodContracts;
export type IpcParams<M extends IpcMethod> = IpcMethodContracts[M]["params"];
export type IpcResult<M extends IpcMethod> = IpcMethodContracts[M]["result"];

export const OPERATION_METHODS = [
  "accounts.refreshStatus",
  "accounts.runNow",
  "accounts.checkSelectors",
  "browser.startLogin",
  "browser.openPage",
  "proxies.importSubscription",
  "proxies.refreshSubscription",
  "proxies.setRuntimeDirectory",
  "proxies.setNodeEnabled",
  "proxies.testNode",
  "proxies.testAll",
  "profiles.scan",
  "profiles.cleanCache",
  "profiles.archiveOrphan",
  "profiles.purgeOrphan",
  "operations.get"
] as const satisfies readonly IpcMethod[];
export type OperationMethod = (typeof OPERATION_METHODS)[number];

/** Tauri 将 Agent 信封的 event 字段改名为 name，并省略 revision。 */
export type AgentEventEnvelope = Event extends infer Envelope
  ? Envelope extends { event: infer Name extends EventName; payload: infer Payload }
    ? Omit<Envelope, "event" | "revision"> & { name: Name; payload: Payload }
    : never
  : never;
