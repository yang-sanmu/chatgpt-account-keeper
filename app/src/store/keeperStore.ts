// 全局状态仓库。
//
// 用 zustand 而不是 Context 的理由是订阅粒度：账号页有几十张卡片，Context 的 value 一变
// 全部消费者都要重渲染，要靠层层 memo + 拆 Provider 才勉强挡住。zustand 的每个组件按
// selector 订阅，一条巡检事件只唤醒读了那条记录的那张卡。
//
// 事件处理逻辑集中在这里，不散到页面里：18 种 agent 事件里有一半会被多个页面同时关心
// （账号状态既影响卡片也影响总览计数），谁先收到谁更新会让状态出现分叉。
//
// ---------------------------------------------------------------------------
// 各份数据靠什么保持新鲜
// ---------------------------------------------------------------------------
//
// 页面切换是**卸载 + 重新挂载**（App.tsx 用三元链渲染，不是 CSS 隐藏），所以组件内计算的
// 派生显示（相对时间等）进页面自然就是最新的。下面这张表只关于 store 里的状态 —— 它跨页
// 存活，不随切页刷新。
//
// A. 事件完全覆盖，**不要**再加进页拉取（加了就是每次切页一次无谓 IPC）：
//    accounts       account.changed / accountStatus.changed / openPage.changed
//                   / scheduler.accountChanged
//    operations     operation.changed
//    proxies        proxyState.changed / proxyNode.tested
//    groups         group.changed
//    conversations  conversation.changed
//    scheduler      scheduler.changed
//    agentSettings  settings.changed
//
// B. 事件有缺口，需要进页面时拉一次。缺口各不相同，不能互相照抄：
//    queue          queue.changed 只在**变化时**推，前端刚连上时没有初值
//                   → 总览 mount 时 refreshQueue()
//    browserRuns    同上，且 browserRun.changed 只说「变了」不带快照
//                   → 总览 mount 时 refreshBrowserRuns()
//    historyAccounts  只有 bootstrap 那一份；history.appended 现在会触发重取，但用户可能
//                   在别的机器/进程跑过
//                   → 历史页 mount 时 refreshHistoryAccounts() + 表头手动刷新
//    profileScan    没有对应事件，扫描本身是个操作，必须主动发起
//                   → Profile 页首次进入自动扫描
//
// C. 断线重连期间丢掉的事件由 Rust 侧补：seq 出现缺口时会重发 keeper://bootstrap。
//    前端不需要自己检测缺口。

import { create } from "zustand";
import {
  agentCall,
  checkUpdate,
  connectAgent,
  exitAll,
  getStartupInfo,
  hideToTray,
  installUpdate,
  newCommandId,
  normalizeAccount,
  refreshBootstrap,
  saveSettings,
  setSchedulerTrayState,
  showMainWindow,
  subscribeTauriEvents,
} from "@/ipc/bridge";
import { notify } from "@/lib/notify";
import type {
  Account,
  AgentEventEnvelope,
  AgentSettings,
  BootstrapSnapshot,
  BrowserRunListResult,
  ConnectionSnapshot,
  ConversationSet,
  DesktopSettings,
  ExitProgress,
  Group,
  HistoryAccount,
  IpcParams,
  Operation,
  OperationMethod,
  ProfileScanResult,
  ProxyState,
  QueueSnapshot,
  SchedulerState,
  StartupInfo,
  UpdateStatus,
} from "@/ipc/types";
import {
  applyAccountChanged,
  applyAccountRemoved,
  applyAccountStatus,
  applyDraft,
  beginSubmit,
  DEFAULT_ACCOUNT_FILTER,
  discardDraft as discardDraftIn,
  failSubmit,
  finishSubmit,
  reconcileFromSnapshot,
  type AccountDraft,
  type AccountFilter,
  type AccountRecords,
  type AccountStatusPatch,
} from "./accountModel";
import { normalizeProfileScan, normalizeScheduler } from "./normalize";

export type NavKey =
  | "overview"
  | "accounts"
  | "operations"
  | "history"
  | "proxies"
  | "conversations"
  | "profiles"
  | "settings";

export type ProfileAction = "detach" | "archive" | "purge";

const TERMINAL_OPERATION_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const PENDING_OPERATION_STATES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "waiting_user",
]);

/// 早于 agentCall 响应到达的终态操作的缓存上限。定长 FIFO：不设上限会在长时间运行后
/// 攒下永不回收的条目。
const MAX_EARLY_TERMINAL = 200;

const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: "system",
  closeBehavior: "ask",
  startAtLogin: false,
  autoStartScheduler: false,
  updatePolicy: "notifyOnly",
};

const DEFAULT_PROXY_STATE: ProxyState = {
  nodes: [],
  status: {
    running: false,
    basePort: 7890,
    basePortShifted: false,
    nodeCount: 0,
    routedNodeCount: 0,
    subscription: null,
    clashVergeDir: null,
    mihomo: { path: null, found: false },
  },
  subscription: null,
  runtime: null,
};

const DEFAULT_SCHEDULER: SchedulerState = {
  running: false,
  enabled: false,
  accounts: {},
};

export interface LoginSession {
  accountId: string;
  accountEmail: string | null;
  accountNote: string;
  operation: Operation | null;
}

export interface UpdateDialogState {
  open: boolean;
  status: UpdateStatus | null;
  installing: boolean;
}

interface KeeperState {
  // --- 启动与连接 ---
  startupInfo: StartupInfo | null;
  initializing: boolean;
  connection: ConnectionSnapshot;
  draining: boolean;

  // --- 业务数据 ---
  accounts: AccountRecords;
  accountIds: string[];
  accountFilter: AccountFilter;
  selectedAccountIds: ReadonlySet<string>;
  /// 账号邮箱是否明文显示。默认全部隐藏（脱敏），用户可一键全部展示。
  emailsRevealed: boolean;

  groups: Group[];
  proxies: ProxyState;
  conversations: Record<string, ConversationSet>;
  scheduler: SchedulerState;
  schedulerStarting: boolean;
  schedulerStartDialogOpen: boolean;
  operations: Operation[];
  historyAccounts: HistoryAccount[];
  browserRuns: BrowserRunListResult | null;
  queue: QueueSnapshot | null;
  agentSettings: AgentSettings | null;
  desktopSettings: DesktopSettings;

  profileScan: ProfileScanResult | null;
  profileScanning: boolean;
  /// 上一次扫描失败了。存在的唯一原因是打断自动重试：Profile 页以「还没有结果」为触发
  /// 条件自动扫描，而失败会把 profileScanning 放回 false，条件重新成立 —— Agent 没连上
  /// 时这就是每轮一个错误提示的无限循环。
  profileScanFailed: boolean;

  // --- 界面外壳 ---
  nav: NavKey;
  sidebarCollapsed: boolean;
  login: LoginSession | null;
  updateDialog: UpdateDialogState;
  closeDialogOpen: boolean;
  exitProgress: ExitProgress | null;
  /// 历史页当前选中的账号。从账号卡片跳过去时带上。
  historyFocusAccountId: string | null;
  /// 账号卡片上「历史」按钮打开的抽屉。null 表示关闭。
  ///
  /// 与 historyFocusAccountId 分开：抽屉是在账号页原地看一眼，不改变当前页面；跳转到历史页
  /// 才用那个。合成一个字段会让开抽屉这个动作把历史页的选中项也换掉。
  historyDrawerAccountId: string | null;
}

interface KeeperActions {
  bootstrapApp: () => Promise<void>;
  teardown: () => void;

  setNav: (nav: NavKey) => void;
  toggleSidebar: () => void;
  openHistoryFor: (accountId: string) => void;
  openHistoryDrawer: (accountId: string) => void;
  closeHistoryDrawer: () => void;

  setAccountFilter: (patch: Partial<AccountFilter>) => void;
  resetAccountFilter: () => void;
  toggleAccountSelected: (id: string) => void;
  selectAccounts: (ids: readonly string[]) => void;
  clearAccountSelection: () => void;
  setEmailsRevealed: (revealed: boolean) => void;

  editAccount: (id: string, patch: AccountDraft) => void;
  discardAccountEdits: (id: string) => void;
  saveAccount: (id: string, patch: AccountDraft) => Promise<void>;
  createAccount: (patch: AccountDraft) => Promise<Account | null>;
  removeAccount: (id: string, profileAction: ProfileAction) => Promise<void>;
  refreshAccountStatus: (id: string) => Promise<void>;
  runAccountNow: (id: string) => Promise<void>;
  checkAccountSelectors: (id: string, deep?: boolean) => Promise<void>;
  startLogin: (id: string, force?: boolean) => Promise<void>;
  closeLogin: () => void;
  toggleAccountPage: (id: string, currentlyOpen: boolean) => Promise<void>;

  bulkSetEnabled: (ids: readonly string[], enabled: boolean) => Promise<void>;
  bulkRefreshStatus: (ids: readonly string[]) => Promise<void>;
  bulkRunNow: (ids: readonly string[]) => Promise<void>;
  bulkRemove: (ids: readonly string[], profileAction: ProfileAction) => Promise<void>;

  startScheduler: () => Promise<void>;
  confirmSchedulerStart: (remember: boolean) => Promise<void>;
  dismissSchedulerStartDialog: () => void;
  stopScheduler: () => Promise<void>;
  toggleScheduler: () => Promise<void>;

  syncBootstrap: () => Promise<void>;
  requestProfileScan: () => Promise<void>;
  refreshBrowserRuns: () => Promise<void>;
  refreshQueue: () => Promise<void>;
  refreshHistoryAccounts: () => Promise<void>;

  updateDesktopSettings: (patch: Partial<DesktopSettings>) => Promise<void>;
  updateAgentSettings: (patch: Partial<AgentSettings>) => Promise<void>;

  checkForUpdate: () => Promise<void>;
  installPendingUpdate: () => Promise<void>;
  dismissUpdateDialog: () => void;

  requestClose: () => void;
  dismissCloseDialog: () => void;
  minimizeToTray: (remember: boolean) => Promise<void>;
  exitEverything: (remember: boolean) => Promise<void>;
  forceExit: () => void;

  runOperation: <M extends OperationMethod>(
    method: M,
    params: IpcParams<M>
  ) => Promise<Operation>;
}

export type KeeperStore = KeeperState & KeeperActions;

const INITIAL_STATE: KeeperState = {
  startupInfo: null,
  initializing: true,
  connection: { connected: false, status: "正在初始化", detail: "准备连接后台服务" },
  draining: false,

  accounts: {},
  accountIds: [],
  accountFilter: DEFAULT_ACCOUNT_FILTER,
  selectedAccountIds: new Set<string>(),
  emailsRevealed: false,

  groups: [],
  proxies: DEFAULT_PROXY_STATE,
  conversations: {},
  scheduler: DEFAULT_SCHEDULER,
  schedulerStarting: false,
  schedulerStartDialogOpen: false,
  operations: [],
  historyAccounts: [],
  browserRuns: null,
  queue: null,
  agentSettings: null,
  desktopSettings: DEFAULT_DESKTOP_SETTINGS,

  profileScan: null,
  profileScanning: false,
  profileScanFailed: false,

  nav: "overview",
  sidebarCollapsed: false,
  login: null,
  updateDialog: { open: false, status: null, installing: false },
  closeDialogOpen: false,
  exitProgress: null,
  historyFocusAccountId: null,
  historyDrawerAccountId: null,
};

/// 等待某个 operation 走到终态的挂起 promise。
interface OperationWaiter {
  resolve: (operation: Operation) => void;
  reject: (error: unknown) => void;
}

/// 模块级可变状态，刻意不放进 store：它们不参与渲染，放进 state 只会制造无意义的订阅
/// 唤醒。事件监听器的注销函数同理。
const operationWaiters = new Map<string, OperationWaiter>();
const earlyTerminalOperations = new Map<string, Operation>();
let eventUnsubscribers: (() => void)[] = [];
let bootstrapStarted = false;

function rememberEarlyTerminal(operation: Operation): void {
  if (earlyTerminalOperations.size >= MAX_EARLY_TERMINAL) {
    const oldest = earlyTerminalOperations.keys().next().value;
    if (oldest !== undefined) earlyTerminalOperations.delete(oldest);
  }
  earlyTerminalOperations.set(operation.id, operation);
}

function operationFailure(operation: Operation): unknown {
  return operation.error ?? new Error(operation.message ?? `操作${operation.state}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/// 把 accountStatus.changed / openPage.changed / scheduler.accountChanged 的裸 payload
/// 收敛成 AccountStatusPatch。
///
/// 这里逐字段窄化而不是直接 spread：payload 来自另一个进程，字段可能缺、可能是 null、
/// 也可能类型不对，直接展开会把脏值写进基线，之后在渲染层炸。
function toStatusPatch(payload: unknown): AccountStatusPatch {
  const raw = asRecord(payload);
  const patch: AccountStatusPatch = {};

  const status = optionalString(raw.status) ?? optionalString(raw.state);
  if (status !== undefined && status.length > 0) {
    patch.status = status;
  } else if (typeof raw.loggedIn === "boolean") {
    // 同 normalizeAccount：未登录对应 out，不是界面自造的 needs_login。
    patch.status = raw.loggedIn ? "ok" : "out";
  }

  const stale = optionalBoolean(raw.stale);
  if (stale !== undefined) patch.stale = stale;

  if (raw.promoEligibility === null) {
    patch.promoEligibility = null;
  } else if (
    raw.promoEligibility === "free_trial" ||
    raw.promoEligibility === "half_price" ||
    raw.promoEligibility === "both" ||
    raw.promoEligibility === "none"
  ) {
    patch.promoEligibility = raw.promoEligibility;
  }
  if (raw.promoCheckedAt !== undefined) {
    patch.promoCheckedAt = optionalString(raw.promoCheckedAt) ?? null;
  }
  const promoStale = optionalBoolean(raw.promoStale);
  if (promoStale !== undefined) patch.promoStale = promoStale;
  if (raw.promoCheckDetail !== undefined) {
    patch.promoCheckDetail = optionalString(raw.promoCheckDetail) ?? null;
  }

  if (raw.statusCheckedAt !== undefined) {
    patch.statusCheckedAt = optionalString(raw.statusCheckedAt) ?? null;
  } else if (raw.checkedAt !== undefined) {
    patch.statusCheckedAt = optionalString(raw.checkedAt) ?? null;
  }

  if (raw.nextRunAt !== undefined) patch.nextRunAt = optionalString(raw.nextRunAt) ?? null;
  if (raw.lastRunAt !== undefined) patch.lastRunAt = optionalString(raw.lastRunAt) ?? null;
  if (raw.lastRunOk !== undefined) patch.lastRunOk = optionalBoolean(raw.lastRunOk) ?? null;
  if (raw.lastRunReason !== undefined) {
    patch.lastRunReason = optionalString(raw.lastRunReason) ?? null;
  }

  const pageOpen = optionalBoolean(raw.pageOpen) ?? optionalBoolean(raw.open);
  if (pageOpen !== undefined) patch.pageOpen = pageOpen;

  const running = optionalBoolean(raw.running);
  if (running !== undefined) patch.running = running;

  if (raw.rotationTopic !== undefined) {
    patch.rotationTopic = optionalString(raw.rotationTopic) ?? null;
  }
  const rotationDone = optionalNumber(raw.rotationDone);
  if (rotationDone !== undefined) patch.rotationDone = rotationDone;
  const rotationTarget = optionalNumber(raw.rotationTarget);
  if (rotationTarget !== undefined) patch.rotationTarget = rotationTarget;

  if (raw.exitNode !== undefined) patch.exitNode = optionalString(raw.exitNode) ?? null;
  const exitNodeMissing = optionalBoolean(raw.exitNodeMissing);
  if (exitNodeMissing !== undefined) patch.exitNodeMissing = exitNodeMissing;

  if (raw.gptName !== undefined) patch.gptName = optionalString(raw.gptName) ?? null;
  if (raw.email !== undefined) patch.email = optionalString(raw.email) ?? null;

  return patch;
}

function accountIdOf(payload: unknown): string {
  const raw = asRecord(payload);
  const id = optionalString(raw.id) ?? optionalString(raw.accountId) ?? "";
  return id.trim();
}

/// 批量操作的结果汇报。
///
/// 全成功才报成功。部分失败必须报错并给出失败数与第一个稳定错误码 —— 无条件报成功会让
/// 用户看到「已提交 N 个」却不知道其中几个失败了，只会疑惑剩下的账号为什么没动。
function reportBulk(
  action: string,
  total: number,
  failures: readonly { id: string; error: unknown }[]
): void {
  const succeeded = total - failures.length;
  if (failures.length === 0) {
    notify.success(`${action}完成`, `共 ${succeeded} 个账号`);
    return;
  }
  const code = asRecord(failures[0]?.error).code;
  notify.error(
    `${action}部分失败`,
    `成功 ${succeeded} 个，失败 ${failures.length} 个` +
      (typeof code === "string" ? `（首个错误 ${code}）` : "")
  );
}

export const useKeeperStore = create<KeeperStore>()((set, get) => {
  async function startSchedulerNow(remember: boolean): Promise<void> {
    if (get().schedulerStarting) return;
    if (get().scheduler.running) {
      set({ schedulerStartDialogOpen: false });
      return;
    }
    set({ schedulerStarting: true });
    try {
      if (remember) {
        const next = { ...get().desktopSettings, autoStartScheduler: true };
        // 偏好保存成功后才启动；写入失败时保留询问框，不能假装已经记住选择。
        await saveSettings(next);
        set({ desktopSettings: next });
      }
      await agentCall("scheduler.start", {}, await newCommandId());
      set({ schedulerStartDialogOpen: false });
      notify.success("自动调度已启动");
    } catch (error) {
      notify.error("启动自动调度失败", error);
    } finally {
      set({ schedulerStarting: false });
    }
  }

  /// 串行执行一批单账号调用并汇总结果。
  ///
  /// 必须保持串行：runNow 与 refreshStatus 每个都可能拉起一个真实 Chrome，并发提交 28 个
  /// 账号等于同时开 28 个浏览器。
  async function runSequentially(
    action: string,
    ids: readonly string[],
    step: (id: string) => Promise<void>
  ): Promise<void> {
    const failures: { id: string; error: unknown }[] = [];
    for (const id of ids) {
      try {
        await step(id);
      } catch (error) {
        failures.push({ id, error });
      }
    }
    reportBulk(action, ids.length, failures);
  }

  function handleBootstrap(snapshot: BootstrapSnapshot): void {
    set((state) => {
      const serverAccounts: Account[] = (snapshot.accounts ?? []).map(normalizeAccount);
      const { records, ids } = reconcileFromSnapshot(state.accounts, serverAccounts);
      const scheduler = snapshot.scheduler
        ? normalizeScheduler(snapshot.scheduler)
        : state.scheduler;

      // 选中项里已经不存在的账号要清掉，仍存在的保留 —— 一次刷新不该让用户重新勾一遍。
      const validIds = new Set(ids);
      const selected = new Set<string>();
      for (const id of state.selectedAccountIds) {
        if (validIds.has(id)) selected.add(id);
      }

      return {
        accounts: records,
        accountIds: ids,
        selectedAccountIds: selected,
        groups: snapshot.groups ?? state.groups,
        proxies: snapshot.proxies ?? state.proxies,
        conversations: snapshot.conversations ?? state.conversations,
        scheduler,
        schedulerStartDialogOpen: scheduler.running ? false : state.schedulerStartDialogOpen,
        agentSettings: snapshot.settings ?? state.agentSettings,
        operations: snapshot.operations ?? state.operations,
        historyAccounts: snapshot.historyAccounts ?? state.historyAccounts,
        draining: Boolean(snapshot.draining),
        // 收到全量快照说明 IPC 通了。上一次扫描如果是因为未连接而失败，现在可以再试。
        profileScanFailed: false,
      };
    });
  }

  function handleOperation(operation: Operation): void {
    const waiter = operationWaiters.get(operation.id);

    if (TERMINAL_OPERATION_STATES.has(operation.state)) {
      if (waiter) {
        operationWaiters.delete(operation.id);
        if (operation.state === "succeeded") waiter.resolve(operation);
        else waiter.reject(operationFailure(operation));
      } else {
        // 终态早于 agentCall 的响应到达。runOperation 会先来这里查。
        rememberEarlyTerminal(operation);
      }
    } else if (!PENDING_OPERATION_STATES.has(operation.state) && waiter) {
      operationWaiters.delete(operation.id);
      waiter.reject(new Error(`操作进入未知状态：${operation.state}`));
    }

    set((state) => {
      const index = state.operations.findIndex((item) => item.id === operation.id);
      const operations =
        index >= 0
          ? state.operations.map((item, at) => (at === index ? operation : item))
          : [operation, ...state.operations];

      const login =
        state.login && state.login.operation?.id === operation.id
          ? { ...state.login, operation }
          : state.login;

      return { operations, login };
    });

    // profile-scan 的结果就是扫描数据本身。profiles.scan 是操作类方法，调用它只拿到一个
    // 操作描述符；真正的 profiles 数组在这个事件里。
    if (operation.kind === "profile-scan") {
      if (operation.state === "succeeded") {
        set({
          profileScan: normalizeProfileScan(operation.result),
          profileScanning: false,
          profileScanFailed: false,
        });
      } else if (TERMINAL_OPERATION_STATES.has(operation.state)) {
        set({ profileScanning: false, profileScanFailed: true });
      }
      return;
    }

    // 其它 Profile 操作改变了磁盘状态，必须重新扫描才知道新的占用。
    if (operation.state === "succeeded" && operation.kind.startsWith("profile-")) {
      void get().requestProfileScan();
    }
  }

  function handleAgentEvent(envelope: AgentEventEnvelope): void {
    switch (envelope.name) {
      case "account.changed": {
        const account = normalizeAccount(envelope.payload);
        if (!account.id) break;
        set((state) => {
          const { records, isNew } = applyAccountChanged(state.accounts, account);
          return {
            accounts: records,
            accountIds: isNew ? [...state.accountIds, account.id] : state.accountIds,
          };
        });
        break;
      }

      case "account.removed": {
        const id = accountIdOf(envelope.payload);
        if (!id) break;
        set((state) => {
          const selected = new Set(state.selectedAccountIds);
          selected.delete(id);
          return {
            accounts: applyAccountRemoved(state.accounts, id),
            accountIds: state.accountIds.filter((item) => item !== id),
            selectedAccountIds: selected,
          };
        });
        break;
      }

      case "accountStatus.changed":
      case "openPage.changed": {
        const id = accountIdOf(envelope.payload);
        if (!id) break;
        const patch = toStatusPatch(envelope.payload);
        set((state) => ({ accounts: applyAccountStatus(state.accounts, id, patch) }));
        break;
      }

      case "group.changed": {
        const payload = envelope.payload;
        if (!payload.id) break;
        if ("removed" in payload) {
          set((state) => ({
            groups: state.groups.filter((group) => group.id !== payload.id),
          }));
          break;
        }
        const group: Group = {
          id: payload.id,
          name: payload.name,
          proxyId: payload.proxyId,
          timezone: payload.timezone,
          locale: payload.locale,
        };
        set((state) => {
          const index = state.groups.findIndex((item) => item.id === group.id);
          return {
            groups:
              index >= 0
                ? state.groups.map((item, at) => (at === index ? group : item))
                : [...state.groups, group],
          };
        });
        break;
      }

      case "proxyState.changed": {
        set((state) => ({
          proxies: { ...state.proxies, ...(envelope.payload as ProxyState) },
        }));
        break;
      }

      case "proxyNode.tested": {
        // 测速结果回填到那一行，不能只进任务中心。
        //
        // payload 与节点字段名**不同**：Agent 发的是 { id, ok, delay, message, testedAt }，
        // 而节点上是 latencyMs / latencyOk / latencyMessage / latencyTestedAt。
        const payload = envelope.payload;
        if (!payload.id) break;
        set((state) => ({
          proxies: {
            ...state.proxies,
            // 未知节点不新增行：订阅刷新后 Agent 可能测到一个我们还没拉到的节点，凭一条
            // 测速事件凭空造一行会缺 server / port 等全部字段。
            nodes: state.proxies.nodes.map((node) =>
              node.id === payload.id
                ? {
                    ...node,
                    latencyMs: payload.ok ? payload.delay : null,
                    latencyOk: payload.ok,
                    latencyMessage: payload.ok ? null : payload.message,
                    latencyTestedAt: payload.testedAt,
                  }
                : node
            ),
          },
        }));
        break;
      }

      case "conversation.changed": {
        const payload = envelope.payload;
        if (!payload.name) break;
        if ("removed" in payload) {
          set((state) => {
            if (!(payload.name in state.conversations)) return state;
            const next = { ...state.conversations };
            delete next[payload.name];
            return { conversations: next };
          });
          break;
        }
        set((state) => ({
          conversations: {
            ...state.conversations,
            [payload.name]: {
              topic: payload.set.topic,
              minRounds: payload.set.minRounds,
              maxRounds: payload.set.maxRounds,
            },
          },
        }));
        break;
      }

      case "scheduler.changed": {
        const scheduler = normalizeScheduler(envelope.payload);
        set({
          scheduler,
          ...(scheduler.running ? { schedulerStartDialogOpen: false } : {}),
        });
        // 让托盘菜单与真实状态一致。
        void setSchedulerTrayState(scheduler.running);
        break;
      }

      case "scheduler.accountChanged": {
        const payload = envelope.payload;
        const accountId = payload.accountId?.trim();
        if (!accountId) break;

        const patch: AccountStatusPatch = {};
        if (payload.nextAt !== undefined) patch.nextRunAt = payload.nextAt;
        if (payload.lastAt !== undefined) patch.lastRunAt = payload.lastAt;
        if (payload.lastResult !== undefined) {
          patch.lastRunOk = payload.lastResult ? payload.lastResult.ok : null;
          patch.lastRunReason = payload.lastResult ? payload.lastResult.reason : null;
        }

        set((state) => ({
          accounts: applyAccountStatus(state.accounts, accountId, patch),
          scheduler: {
            ...state.scheduler,
            accounts: {
              ...state.scheduler.accounts,
              [accountId]: {
                ...state.scheduler.accounts[accountId],
                nextRunAt: payload.nextAt !== undefined ? payload.nextAt : state.scheduler.accounts[accountId]?.nextRunAt,
                lastRunAt: payload.lastAt !== undefined ? payload.lastAt : state.scheduler.accounts[accountId]?.lastRunAt,
                lastRunOk: patch.lastRunOk !== undefined ? patch.lastRunOk : state.scheduler.accounts[accountId]?.lastRunOk,
                reason: patch.lastRunReason !== undefined ? patch.lastRunReason : state.scheduler.accounts[accountId]?.reason,
                busy: payload.busy ?? state.scheduler.accounts[accountId]?.busy,
              },
            },
          },
        }));
        break;
      }

      case "operation.changed": {
        const operation = envelope.payload;
        if (operation?.id) handleOperation(operation);
        break;
      }

      case "settings.changed": {
        if (envelope.payload) set({ agentSettings: envelope.payload as AgentSettings });
        break;
      }

      case "agent.draining": {
        const raw = asRecord(envelope.payload);
        set({ draining: optionalBoolean(raw.draining) ?? true });
        break;
      }

      case "queue.changed": {
        if (envelope.payload) set({ queue: envelope.payload as QueueSnapshot });
        break;
      }

      case "browserRun.changed": {
        void get().refreshBrowserRuns();
        break;
      }

      case "history.appended": {
        // 跑完一轮对话就要让历史页的账号摘要跟上。
        //
        // 这个事件原来被直接 break 掉，于是 historyAccounts 只有 bootstrap 时那一份快照：
        // 左栏的「上次成功/失败」和时间会一直显示启动那一刻的状态，一个昨天失败、今天已经
        // 连续成功的账号在界面上永远是红的。
        //
        // 只重取摘要列表（很小），不动条目本身 —— 条目由 useAccountHistory 按当前选中账号
        // 自己拉，塞进 store 会变成一份需要同步的第二副本。
        void get().refreshHistoryAccounts();
        break;
      }

      // profile.changed 刻意不处理：Profile 的刷新以 operation.changed 为唯一权威来源，
      // 两个入口都触发 profiles.scan 会让一次清理引发两次全盘扫描。
      case "profile.changed":
      case "agent.readyForUpdate":
        break;
    }
  }

  return {
    ...INITIAL_STATE,

    // ---------------------------------------------------------------- 启动
    bootstrapApp: async () => {
      // React 18 StrictMode 在开发模式下会把 effect 跑两遍。第二遍不该再拉起一个 Agent。
      if (bootstrapStarted) return;
      bootstrapStarted = true;

      eventUnsubscribers = await subscribeTauriEvents({
        onBootstrap: handleBootstrap,
        onAgentEvent: handleAgentEvent,
        onConnection: (connection) => set({ connection }),
        onUpdate: (status) =>
          set({
            updateDialog: {
              open: true,
              status,
              installing: status.state === "installing",
            },
          }),
        onTrayAction: (action) => {
          // 四个托盘动作复用页面上已有的同名逻辑，不另写一套。
          const store = get();
          if (action === "scheduler-start") void store.startScheduler();
          else if (action === "scheduler-stop") void store.stopScheduler();
          else if (action === "check-update") void store.checkForUpdate();
          else if (action === "exit-all") void store.exitEverything(false);
        },
        onCloseRequested: () => get().requestClose(),
        onExitProgress: (exitProgress) => set({ exitProgress }),
      });

      try {
        const startupInfo = await getStartupInfo();
        set({ startupInfo, desktopSettings: startupInfo.settings });

        if (startupInfo.initialized) {
          set({ connection: await connectAgent(true) });

          // 先检查更新，再决定是否启动调度。
          //
          // 反过来会造成一个真实的坏状态：调度已经拉起 Chrome 在跑对话，此时检查到新版本，
          // 用户点「立即更新」，而安装流程的预检会因为「有任务在运行」直接拒绝 —— 用户
          // 只能先停调度、等收尾、再来一次。
          let updateFound = false;
          try {
            const status = await checkUpdate();
            if (status.state === "available") {
              updateFound = true;
              set({ updateDialog: { open: true, status, installing: false } });
            }
          } catch {
            // 启动期的更新检查失败不该产生一个用户此刻无法处理的错误提示。
          }

          if (startupInfo.settings.autoStartScheduler) {
            if (updateFound) {
              notify.info(
                "已暂缓自动启动调度",
                "发现新版本；安装更新或忽略后可手动启动调度"
              );
            } else {
              void agentCall("scheduler.start", {}, await newCommandId()).catch(() => {});
            }
          }
        }
      } catch (error) {
        notify.error("启动初始化失败", error);
      } finally {
        set({ initializing: false });
      }
    },

    teardown: () => {
      for (const unsubscribe of eventUnsubscribers) unsubscribe();
      eventUnsubscribers = [];
    },

    // ------------------------------------------------------------ 界面外壳
    setNav: (nav) => set({ nav }),
    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    openHistoryFor: (accountId) => set({ nav: "history", historyFocusAccountId: accountId }),
    openHistoryDrawer: (accountId) => set({ historyDrawerAccountId: accountId }),
    closeHistoryDrawer: () => set({ historyDrawerAccountId: null }),

    // ------------------------------------------------------------ 账号筛选
    setAccountFilter: (patch) =>
      set((state) => ({ accountFilter: { ...state.accountFilter, ...patch } })),
    resetAccountFilter: () => set({ accountFilter: DEFAULT_ACCOUNT_FILTER }),

    toggleAccountSelected: (id) =>
      set((state) => {
        const selected = new Set(state.selectedAccountIds);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        return { selectedAccountIds: selected };
      }),

    selectAccounts: (ids) => set({ selectedAccountIds: new Set(ids) }),
    clearAccountSelection: () => set({ selectedAccountIds: new Set<string>() }),
    setEmailsRevealed: (emailsRevealed) => set({ emailsRevealed }),

    // ------------------------------------------------------------ 账号编辑
    editAccount: (id, patch) =>
      set((state) => ({ accounts: applyDraft(state.accounts, id, patch) })),

    discardAccountEdits: (id) =>
      set((state) => ({ accounts: discardDraftIn(state.accounts, id) })),

    saveAccount: async (id, patch) => {
      set((state) => ({ accounts: beginSubmit(state.accounts, id, patch) }));
      try {
        const commandId = await newCommandId();
        const updated = await agentCall("accounts.update", { id, patch }, commandId);
        set((state) => ({
          accounts: finishSubmit(
            state.accounts,
            id,
            patch,
            updated ? normalizeAccount(updated) : undefined
          ),
        }));
      } catch (error) {
        set((state) => ({ accounts: failSubmit(state.accounts, id) }));
        notify.error("保存账号失败", error);
        throw error;
      }
    },

    createAccount: async (patch) => {
      try {
        const commandId = await newCommandId();
        const created = normalizeAccount(
          await agentCall("accounts.create", patch, commandId)
        );
        set((state) => {
          const { records, isNew } = applyAccountChanged(state.accounts, created);
          return {
            accounts: records,
            accountIds: isNew ? [...state.accountIds, created.id] : state.accountIds,
          };
        });
        notify.success("账号已创建", "正在准备登录");
        // 新账号唯一有意义的下一步就是登录，直接拉起登录窗口。
        await get().startLogin(created.id, false);
        return created;
      } catch (error) {
        notify.error("创建账号失败", error);
        return null;
      }
    },

    removeAccount: async (id, profileAction) => {
      try {
        const commandId = await newCommandId();
        await agentCall("accounts.remove", { id, profileAction }, commandId);
        set((state) => {
          const selected = new Set(state.selectedAccountIds);
          selected.delete(id);
          return {
            accounts: applyAccountRemoved(state.accounts, id),
            accountIds: state.accountIds.filter((item) => item !== id),
            selectedAccountIds: selected,
          };
        });
        notify.success("账号已删除");
      } catch (error) {
        notify.error("删除账号失败", error);
        throw error;
      }
    },

    refreshAccountStatus: async (id) => {
      try {
        await agentCall("accounts.refreshStatus", { id }, await newCommandId());
        notify.info("已提交状态刷新");
      } catch (error) {
        notify.error("刷新账号状态失败", error);
      }
    },

    runAccountNow: async (id) => {
      try {
        await agentCall("accounts.runNow", { id }, await newCommandId());
        notify.success("已提交立即运行");
      } catch (error) {
        notify.error("立即运行失败", error);
      }
    },

    checkAccountSelectors: async (id, deep = false) => {
      try {
        await agentCall("accounts.checkSelectors", { id, deep }, await newCommandId());
        notify.info("已提交选择器检查");
      } catch (error) {
        notify.error("检查选择器失败", error);
      }
    },

    startLogin: async (id, force = false) => {
      try {
        const commandId = await newCommandId();
        const operation = await agentCall(
          "browser.startLogin",
          { accountId: id, force },
          commandId
        );
        const record = get().accounts[id];
        set({
          login: {
            accountId: id,
            accountEmail: record?.effective.email ?? null,
            accountNote: record?.effective.note ?? "",
            operation,
          },
        });
      } catch (error) {
        notify.error("发起登录失败", error);
      }
    },

    closeLogin: () => set({ login: null }),

    toggleAccountPage: async (id, currentlyOpen) => {
      try {
        const commandId = await newCommandId();
        if (currentlyOpen) {
          await agentCall("browser.closePage", { accountId: id }, commandId);
          notify.info("正在关闭网页");
        } else {
          await agentCall("browser.openPage", { accountId: id }, commandId);
          notify.info("正在打开网页");
        }
      } catch (error) {
        notify.error(currentlyOpen ? "关闭网页失败" : "打开网页失败", error);
      }
    },

    // ------------------------------------------------------------ 批量操作
    bulkSetEnabled: async (ids, enabled) => {
      await runSequentially(enabled ? "批量启用" : "批量停用", ids, async (id) => {
        const commandId = await newCommandId();
        const updated = await agentCall(
          "accounts.update",
          { id, patch: { enabled } },
          commandId
        );
        if (updated) {
          const account = normalizeAccount(updated);
          set((state) => ({
            accounts: applyAccountChanged(state.accounts, account).records,
          }));
        }
      });
    },

    bulkRefreshStatus: async (ids) => {
      await runSequentially("批量刷新状态", ids, async (id) => {
        await agentCall("accounts.refreshStatus", { id }, await newCommandId());
      });
    },

    bulkRunNow: async (ids) => {
      await runSequentially("批量立即运行", ids, async (id) => {
        await agentCall("accounts.runNow", { id }, await newCommandId());
      });
    },

    bulkRemove: async (ids, profileAction) => {
      await runSequentially("批量删除", ids, async (id) => {
        const commandId = await newCommandId();
        await agentCall("accounts.remove", { id, profileAction }, commandId);
        // 只在成功后移除。乐观移除会让删除失败的账号从界面消失，下次刷新又出现。
        set((state) => {
          const selected = new Set(state.selectedAccountIds);
          selected.delete(id);
          return {
            accounts: applyAccountRemoved(state.accounts, id),
            accountIds: state.accountIds.filter((item) => item !== id),
            selectedAccountIds: selected,
          };
        });
      });
    },

    // -------------------------------------------------------------- 调度
    startScheduler: async () => {
      if (get().scheduler.running || get().schedulerStarting) return;
      if (!get().desktopSettings.autoStartScheduler) {
        set({ schedulerStartDialogOpen: true });
        try {
          await showMainWindow();
        } catch (error) {
          notify.error("无法显示启动调度询问", error);
        }
        return;
      }
      await startSchedulerNow(false);
    },

    confirmSchedulerStart: async (remember) => {
      if (!get().schedulerStartDialogOpen) return;
      await startSchedulerNow(remember);
    },

    dismissSchedulerStartDialog: () => {
      if (!get().schedulerStarting) set({ schedulerStartDialogOpen: false });
    },

    stopScheduler: async () => {
      try {
        await agentCall("scheduler.stop", {}, await newCommandId());
        notify.info("自动调度已停止");
      } catch (error) {
        notify.error("停止自动调度失败", error);
      }
    },

    toggleScheduler: async () => {
      const store = get();
      if (store.scheduler.running) await store.stopScheduler();
      else await store.startScheduler();
    },

    // -------------------------------------------------------------- 同步
    syncBootstrap: async () => {
      try {
        await refreshBootstrap();
        notify.success("已请求全量同步");
      } catch (error) {
        notify.error("请求状态同步失败", error);
      }
    },

    requestProfileScan: async () => {
      set({ profileScanning: true, profileScanFailed: false });
      try {
        await agentCall("profiles.scan", {}, await newCommandId());
      } catch (error) {
        // 记下这次失败，否则 Profile 页的自动扫描条件会重新成立，形成重试循环。
        set({ profileScanning: false, profileScanFailed: true });
        notify.error("扫描 Profile 目录失败", error);
      }
    },

    refreshBrowserRuns: async () => {
      try {
        set({ browserRuns: await agentCall("browserRuns.list", {}) });
      } catch {
        // 明细列表是诊断信息，取不到时保留上一次的结果，不打断用户。
      }
    },

    refreshQueue: async () => {
      try {
        set({ queue: await agentCall("queue.getSnapshot", {}) });
      } catch {
        // 同上：队列快照每几秒刷一次，一次失败不值得一个提示。
      }
    },

    refreshHistoryAccounts: async () => {
      try {
        set({ historyAccounts: await agentCall("history.listAccounts", {}) });
      } catch {
        // 摘要取不到时保留上一份，不打断用户。历史页有手动刷新按钮可以重试。
      }
    },

    // -------------------------------------------------------------- 设置
    updateDesktopSettings: async (patch) => {
      const next = { ...get().desktopSettings, ...patch };
      try {
        await saveSettings(next);
        set({ desktopSettings: next });
      } catch (error) {
        notify.error("保存桌面偏好失败", error);
        throw error;
      }
    },

    updateAgentSettings: async (patch) => {
      try {
        await agentCall("settings.update", { patch }, await newCommandId());
        set((state) => ({
          agentSettings: state.agentSettings ? { ...state.agentSettings, ...patch } : null,
        }));
        notify.success("Agent 设置已保存");
      } catch (error) {
        notify.error("保存 Agent 设置失败", error);
        throw error;
      }
    },

    // -------------------------------------------------------------- 更新
    checkForUpdate: async () => {
      try {
        const status = await checkUpdate();
        // 手动检查无论结果如何都弹窗，否则用户点了按钮什么都不发生。
        set({ updateDialog: { open: true, status, installing: false } });
      } catch (error) {
        notify.error("检查更新失败", error);
      }
    },

    installPendingUpdate: async () => {
      set((state) => ({ updateDialog: { ...state.updateDialog, installing: true } }));
      try {
        await installUpdate();
      } catch (error) {
        set((state) => ({ updateDialog: { ...state.updateDialog, installing: false } }));
        notify.error("安装更新失败", error);
      }
    },

    dismissUpdateDialog: () =>
      set({ updateDialog: { open: false, status: null, installing: false } }),

    // ---------------------------------------------------------- 退出流程
    requestClose: () => {
      const behavior = get().desktopSettings.closeBehavior;
      if (behavior === "minimizeToTray") {
        void hideToTray().catch((error) => notify.error("隐藏到托盘失败", error));
      } else if (behavior === "exitAll") {
        void exitAll().catch((error) => notify.error("退出失败", error));
      } else {
        set({ closeDialogOpen: true });
      }
    },

    dismissCloseDialog: () => set({ closeDialogOpen: false }),

    minimizeToTray: async (remember) => {
      set({ closeDialogOpen: false });
      if (remember) await get().updateDesktopSettings({ closeBehavior: "minimizeToTray" });
      await hideToTray().catch((error) => notify.error("隐藏到托盘失败", error));
    },

    exitEverything: async (remember) => {
      set({ closeDialogOpen: false });
      if (remember) await get().updateDesktopSettings({ closeBehavior: "exitAll" });
      await exitAll().catch((error) => notify.error("退出失败", error));
    },

    forceExit: () => {
      void exitAll(true).catch((error) => notify.error("强制退出失败", error));
    },

    // ------------------------------------------------------- 操作类方法
    runOperation: async (method, params) => {
      const commandId = await newCommandId();
      const initial = await agentCall(method, params, commandId);

      if (
        !initial ||
        typeof initial !== "object" ||
        typeof initial.id !== "string" ||
        initial.id.trim().length === 0
      ) {
        throw new Error(`操作 ${method} 未返回有效的 Operation 描述符`);
      }

      // 终态可能早于这次响应到达（Agent 很快完成时常见）。
      const early = earlyTerminalOperations.get(initial.id);
      if (early) {
        earlyTerminalOperations.delete(initial.id);
        if (early.state === "succeeded") return early;
        throw operationFailure(early);
      }

      if (TERMINAL_OPERATION_STATES.has(initial.state)) {
        if (initial.state === "succeeded") return initial;
        throw operationFailure(initial);
      }

      if (!PENDING_OPERATION_STATES.has(initial.state)) {
        throw new Error(`操作 ${method} 处于未知状态：${initial.state}`);
      }

      return new Promise<Operation>((resolve, reject) => {
        operationWaiters.set(initial.id, { resolve, reject });
      });
    },
  };
});

/// 仅供测试使用：把 store 与模块级缓存复位。
///
/// 存在的原因是 zustand 的 store 是模块单例，跨测试会残留上一条用例的账号与在途 promise。
export function __resetKeeperStoreForTests(): void {
  operationWaiters.clear();
  earlyTerminalOperations.clear();
  eventUnsubscribers = [];
  bootstrapStarted = false;
  useKeeperStore.setState(
    {
      ...INITIAL_STATE,
      selectedAccountIds: new Set<string>(),
    },
    false
  );
}
