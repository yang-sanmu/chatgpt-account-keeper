// 全局应用状态上下文
// 汇聚 IPC 事件流、全量快照同步、账号草稿合并与跨页面协同

import React, { createContext, useContext, useEffect, useState, useCallback, useTransition, useMemo } from "react";
import type {
  Account,
  AccountPatch,
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
  Operation,
  ProfileInfo,
  ProfileScanResult,
  ProxyState,
  QueueSnapshot,
  SchedulerState,
  StartupInfo,
  UpdateStatus,
} from "../ipc/types";
import {
  agentCall,
  connectAgent,
  exitAll,
  getStartupInfo,
  hideToTray,
  installUpdate,
  checkUpdate,
  listenTauriEvents,
  newCommandId,
  normalizeAccount,
  refreshBootstrap,
  saveSettings,
  setSchedulerTrayState,
} from "../ipc/bridge";
import {
  createInitialAccountsState,
  deselectAllAccounts,
  discardAccountDraft,
  failAccountSubmit,
  finishAccountSubmit,
  handleSingleAccountChanged,
  handleSingleAccountRemoved,
  handleSingleAccountStatusChanged,
  reconcileAccountsFromBootstrap,
  selectAllAccounts,
  setAccountFilter,
  startAccountSubmit,
  toggleAccountSelection,
  updateAccountDraft,
  type AccountFilter,
  type AccountsState,
} from "./accountsStore";
import { toast } from "./toastStore";

interface ActiveLoginState {
  accountId: string;
  accountEmail?: string | null;
  accountNote?: string;
  operation: Operation | null;
}

interface UpdateModalState {
  isOpen: boolean;
  status: UpdateStatus | null;
  installing: boolean;
}

export interface AppContextValue {
  startupInfo: StartupInfo | null;
  isInitializing: boolean;
  connection: ConnectionSnapshot;
  bootstrap: BootstrapSnapshot | null;
  desktopSettings: DesktopSettings;
  updateDesktopSettings: (patch: Partial<DesktopSettings>) => Promise<void>;
  agentSettings: AgentSettings | null;
  updateAgentSettings: (patch: Partial<AgentSettings>) => Promise<void>;
  
  accountsState: AccountsState;
  updateDraft: (id: string, patch: AccountPatch) => void;
  discardDraft: (id: string) => void;
  toggleSelect: (id: string) => void;
  selectAll: (ids: string[]) => void;
  deselectAll: () => void;
  setFilter: (filter: Partial<AccountFilter>) => void;
  saveAccount: (id: string, patch: AccountPatch) => Promise<void>;
  createAccount: (patch: AccountPatch) => Promise<Account>;
  removeAccount: (id: string, profileAction: "detach" | "archive" | "purge") => Promise<void>;
  refreshAccountStatus: (id: string) => Promise<void>;
  runAccountNow: (id: string) => Promise<void>;
  checkAccountSelectors: (id: string, deep?: boolean) => Promise<void>;
  startLogin: (id: string, force?: boolean) => Promise<void>;
  toggleOpenPage: (id: string, currentlyOpen: boolean) => Promise<void>;
  
  bulkEnable: (ids: string[], enabled: boolean) => Promise<void>;
  bulkRefreshStatus: (ids: string[]) => Promise<void>;
  bulkRunNow: (ids: string[]) => Promise<void>;
  bulkDelete: (ids: string[], profileAction: "detach" | "archive" | "purge") => Promise<void>;

  groups: Group[];
  proxies: ProxyState;
  conversations: Record<string, ConversationSet>;
  scheduler: SchedulerState;
  operations: Operation[];
  activeOperations: Operation[];
  historyAccounts: HistoryAccount[];
  browserRuns: BrowserRunListResult | null;
  queueSnapshot: QueueSnapshot | null;
  profileScan: ProfileScanResult | null;
  profileScanning: boolean;
  requestProfileScan: () => Promise<void>;
  draining: boolean;

  activeLogin: ActiveLoginState | null;
  closeActiveLogin: () => void;
  manualRefreshBootstrap: () => Promise<void>;
  startScheduler: () => Promise<void>;
  stopScheduler: () => Promise<void>;
  toggleScheduler: () => Promise<void>;

  updateModalState: UpdateModalState;
  checkAppUpdate: () => Promise<void>;
  installAppUpdate: () => Promise<void>;
  closeUpdateModal: () => void;

  closeModalOpen: boolean;
  exitProgress: ExitProgress | null;
  forceExitAll: () => void;
  handleMinimizeToTray: (remember: boolean) => Promise<void>;
  handleExitAll: (remember: boolean) => Promise<void>;
  closeCloseModal: () => void;

  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const defaultDesktopSettings: DesktopSettings = {
  theme: "dark",
  closeBehavior: "ask",
  startAtLogin: false,
  autoStartScheduler: false,
  updatePolicy: "notifyOnly",
};

const defaultProxyState: ProxyState = {
  nodes: [],
  status: { running: false },
  subscription: null,
  runtime: null,
};

const defaultSchedulerState: SchedulerState = {
  running: false,
  enabled: false,
  accounts: {},
};

const AppContext = createContext<AppContextValue | null>(null);

/// 账号卡片用到的动作集合。
///
/// 单独一个 context 的原因是依赖粒度：AppContext 的 value 依赖 accountsState，任何账号
/// 变化都会换掉它，于是 28 张卡片的 memo 同时失效。卡片其实只要这 7 个回调，而它们的
/// 依赖是空的——拆出来之后这个 value 在整个进程生命周期里都是同一个引用。
export type AccountActions = Pick<
  AppContextValue,
  | "updateDraft"
  | "saveAccount"
  | "startLogin"
  | "toggleOpenPage"
  | "runAccountNow"
  | "refreshAccountStatus"
  | "checkAccountSelectors"
>;

const AccountActionsContext = createContext<AccountActions | null>(null);

/// 把 profile-scan 的操作结果窄化成 ProfileScanResult。
///
/// 字段名以 src/profileManager.js 的 scan() 为准：`bytes` / `cacheBytes` / `linked`，
/// 不是 `sizeBytes` / `cacheSizeBytes` / `isOrphan`。
function normalizeProfileScan(raw: unknown): ProfileScanResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.profiles)) return null;

  const narrowProfile = (value: unknown): ProfileInfo | null => {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : null;
    if (!name) return null;
    const numeric = (key: string): number =>
      typeof entry[key] === "number" && Number.isFinite(entry[key]) ? (entry[key] as number) : 0;
    const strings = (key: string): string[] =>
      Array.isArray(entry[key])
        ? (entry[key] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
    return {
      name,
      linked: entry.linked === true,
      accountIds: strings("accountIds"),
      accountLabels: strings("accountLabels"),
      nonStandardReference: entry.nonStandardReference === true,
      busy: entry.busy === true,
      bytes: numeric("bytes"),
      files: numeric("files"),
      cacheBytes: numeric("cacheBytes"),
      cacheFiles: numeric("cacheFiles"),
    };
  };

  const profiles = source.profiles
    .map(narrowProfile)
    .filter((profile): profile is ProfileInfo => profile !== null);
  const totalsSource =
    typeof source.totals === "object" && source.totals !== null
      ? (source.totals as Record<string, unknown>)
      : {};
  const total = (key: string, fallback: number): number =>
    typeof totalsSource[key] === "number" && Number.isFinite(totalsSource[key])
      ? (totalsSource[key] as number)
      : fallback;
  const orphans = profiles.filter((profile) => !profile.linked);
  const sum = (items: ProfileInfo[], field: "bytes" | "cacheBytes"): number =>
    items.reduce((accumulated, item) => accumulated + item[field], 0);

  return {
    profiles,
    orphans,
    totals: {
      profiles: total("profiles", profiles.length),
      linked: total("linked", profiles.length - orphans.length),
      orphans: total("orphans", orphans.length),
      bytes: total("bytes", sum(profiles, "bytes")),
      cacheBytes: total("cacheBytes", sum(profiles, "cacheBytes")),
      orphanBytes: total("orphanBytes", sum(orphans, "bytes")),
      archiveCount: total("archiveCount", 0),
      archiveBytes: total("archiveBytes", 0),
      trashCount: total("trashCount", 0),
      trashBytes: total("trashBytes", 0),
    },
  };
}

interface BulkFailure {
  id: string;
  error: unknown;
}

/// 批量操作的结果汇报。
///
/// 全成功才报 success。部分失败必须报 error 并给出失败数与第一个稳定错误码——原来四个
/// 批量操作都在 `catch {}` 之后无条件报 success，用户看到「已提交 2 个账号」却不知道
/// 另外 2 个失败了，只会疑惑为什么剩下的账号没动。
function reportBulkOutcome(action: string, total: number, failures: BulkFailure[]): void {
  const succeeded = total - failures.length;
  if (failures.length === 0) {
    toast.success(`${action}完成（${succeeded}/${total}）`);
    return;
  }
  const first = failures[0];
  const code =
    typeof first?.error === "object" && first.error !== null
      ? (first.error as { code?: string }).code
      : undefined;
  toast.error(
    `${action}部分失败：成功 ${succeeded} 个，失败 ${failures.length} 个` +
      (code ? `（首个错误 ${code}）` : "")
  );
}

export function useAccountActions(): AccountActions {
  const context = useContext(AccountActionsContext);
  if (!context) {
    throw new Error("useAccountActions must be used within an AppProvider");
  }
  return context;
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [startupInfo, setStartupInfo] = useState<StartupInfo | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("overview");

  const [connection, setConnection] = useState<ConnectionSnapshot>({
    connected: false,
    status: "正在初始化...",
    detail: "准备连接服务",
  });

  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null);
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>(defaultDesktopSettings);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);

  const [accountsState, setAccountsState] = useState<AccountsState>(createInitialAccountsState);
  const [groups, setGroups] = useState<Group[]>([]);
  const [proxies, setProxies] = useState<ProxyState>(defaultProxyState);
  const [conversations, setConversations] = useState<Record<string, ConversationSet>>({});
  const [scheduler, setScheduler] = useState<SchedulerState>(defaultSchedulerState);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [activeOperations, setActiveOperations] = useState<Operation[]>([]);
  const [historyAccounts, setHistoryAccounts] = useState<HistoryAccount[]>([]);
  const [browserRuns, setBrowserRuns] = useState<BrowserRunListResult | null>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot | null>(null);
  const [profileScan, setProfileScan] = useState<ProfileScanResult | null>(null);
  /// 扫描进行中。42 个账号的 Profile 目录可能几 GB，必须让用户看到在扫。
  const [profileScanning, setProfileScanning] = useState(false);
  const [draining, setDraining] = useState(false);

  const [activeLogin, setActiveLogin] = useState<ActiveLoginState | null>(null);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [exitProgress, setExitProgress] = useState<ExitProgress | null>(null);
  const [updateModalState, setUpdateModalState] = useState<UpdateModalState>({
    isOpen: false,
    status: null,
    installing: false,
  });

  const [, startTransition] = useTransition();

  // 应用主题样式属性
  useEffect(() => {
    const theme = desktopSettings.theme;
    const root = document.documentElement;
    if (theme === "light") {
      root.setAttribute("data-theme", "light");
    } else if (theme === "dark") {
      root.removeAttribute("data-theme");
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (prefersDark) {
        root.removeAttribute("data-theme");
      } else {
        root.setAttribute("data-theme", "light");
      }
    }
  }, [desktopSettings.theme]);

  // 处理全量快照到达
  const handleBootstrapPayload = useCallback((snapshot: BootstrapSnapshot) => {
    startTransition(() => {
      setBootstrap(snapshot);

      // 归一化账号列表并应用行为 1（草稿保留与三路合并）
      const normalizedAccounts: Account[] = (snapshot.accounts || []).map(normalizeAccount);
      setAccountsState((prev) => reconcileAccountsFromBootstrap(prev, normalizedAccounts));

      if (snapshot.groups) setGroups(snapshot.groups);
      if (snapshot.proxies) setProxies(snapshot.proxies);
      if (snapshot.conversations) setConversations(snapshot.conversations);
      if (snapshot.scheduler) setScheduler(snapshot.scheduler);
      if (snapshot.settings) setAgentSettings(snapshot.settings);
      if (snapshot.operations) setOperations(snapshot.operations);
      if (snapshot.activeOperations) setActiveOperations(snapshot.activeOperations);
      if (snapshot.historyAccounts) setHistoryAccounts(snapshot.historyAccounts);
      setDraining(Boolean(snapshot.draining));
    });
  }, []);

  // 调度启动/停止
  const startScheduler = useCallback(async () => {
    try {
      const cid = await newCommandId();
      await agentCall("scheduler.start", {}, cid);
      toast.success("自动调度已启动");
    } catch (err) {
      toast.error("启动自动调度失败", err);
    }
  }, []);

  const stopScheduler = useCallback(async () => {
    try {
      const cid = await newCommandId();
      await agentCall("scheduler.stop", {}, cid);
      toast.info("自动调度已停止");
    } catch (err) {
      toast.error("停止自动调度失败", err);
    }
  }, []);

  const toggleScheduler = useCallback(async () => {
    if (scheduler.running) {
      await stopScheduler();
    } else {
      await startScheduler();
    }
  }, [scheduler.running, startScheduler, stopScheduler]);

  // 检查更新
  const checkAppUpdate = useCallback(async () => {
    try {
      const status = await checkUpdate();
      setUpdateModalState({
        isOpen: true,
        status,
        installing: false,
      });
    } catch (err) {
      toast.error("检查更新失败", err);
    }
  }, []);

  /// 启动时的更新检查。返回是否发现了可安装的新版本。
  ///
  /// 与手动检查的区别：手动检查无论结果如何都弹窗（否则用户点了按钮什么都不发生），
  /// 启动检查只在**真的有更新**时弹。每次启动都弹一句「已是最新版本」是噪音。
  ///
  /// 也不能让它挡住启动：网络不通时 check_update 会返回 error 状态，那时照常继续，
  /// 只是不打扰用户。
  const checkUpdateBeforeScheduler = useCallback(async (): Promise<boolean> => {
    try {
      const status = await checkUpdate();
      if (status.state !== "available") return false;
      setUpdateModalState({ isOpen: true, status, installing: false });
      return true;
    } catch {
      // 启动期的更新检查失败不该产生一个用户此刻无法处理的错误提示。
      return false;
    }
  }, []);

  // 安装更新
  const installAppUpdate = useCallback(async () => {
    try {
      setUpdateModalState((prev) => ({ ...prev, installing: true }));
      await installUpdate();
    } catch (err) {
      setUpdateModalState((prev) => ({ ...prev, installing: false }));
      toast.error("安装更新失败", err);
    }
  }, []);

  const closeUpdateModal = useCallback(() => {
    setUpdateModalState({ isOpen: false, status: null, installing: false });
  }, []);

  // 托盘动作分发
  const handleTrayAction = useCallback((action: string) => {
    switch (action) {
      case "scheduler-start":
        startScheduler();
        break;
      case "scheduler-stop":
        stopScheduler();
        break;
      case "check-update":
        checkAppUpdate();
        break;
      case "exit-all":
        exitAll().catch((err) => toast.error("退出失败", err));
        break;
    }
  }, [startScheduler, stopScheduler, checkAppUpdate]);

  /// 请求一次 Profile 扫描。
  ///
  /// 只提交操作，结果由 operation.changed 送回来（profiles.scan 是操作类方法）。
  const requestProfileScan = useCallback(async () => {
    setProfileScanning(true);
    try {
      const cid = await newCommandId();
      await agentCall("profiles.scan", {}, cid);
    } catch (err) {
      setProfileScanning(false);
      toast.error("扫描 Profile 目录失败", err);
    }
  }, []);

  // 窗口关闭请求处理
  const handleCloseRequested = useCallback(() => {
    const behavior = desktopSettings.closeBehavior;
    if (behavior === "minimizeToTray") {
      hideToTray().catch((err) => toast.error("隐藏到托盘失败", err));
    } else if (behavior === "exitAll") {
      exitAll().catch((err) => toast.error("退出失败", err));
    } else {
      setCloseModalOpen(true);
    }
  }, [desktopSettings.closeBehavior]);

  // 监听 18 种业务事件
  const handleAgentEvent = useCallback((envelope: AgentEventEnvelope) => {
    const { name, payload } = envelope;
    const p = (payload || {}) as Record<string, unknown>;

    switch (name) {
      case "account.changed": {
        const updated = normalizeAccount(payload);
        setAccountsState((prev) => handleSingleAccountChanged(prev, updated));
        break;
      }
      case "account.removed": {
        const id = String(p.id || p.accountId || "");
        if (id) {
          setAccountsState((prev) => handleSingleAccountRemoved(prev, id));
        }
        break;
      }
      case "accountStatus.changed": {
        const id = String(p.id || p.accountId || "");
        if (id) {
          setAccountsState((prev) =>
            handleSingleAccountStatusChanged(prev, {
              id,
              status: typeof p.status === "string" ? p.status : undefined,
              state: typeof p.state === "string" ? p.state : undefined,
              loggedIn: typeof p.loggedIn === "boolean" ? p.loggedIn : undefined,
              stale: typeof p.stale === "boolean" ? p.stale : undefined,
              statusCheckedAt: typeof p.statusCheckedAt === "string" ? p.statusCheckedAt : undefined,
              checkedAt: typeof p.checkedAt === "string" ? p.checkedAt : undefined,
              lastRunOk: typeof p.lastRunOk === "boolean" ? p.lastRunOk : undefined,
              lastRunReason: typeof p.lastRunReason === "string" ? p.lastRunReason : undefined,
              pageOpen: typeof p.pageOpen === "boolean" ? p.pageOpen : undefined,
              rotationDone: typeof p.rotationDone === "number" ? p.rotationDone : undefined,
              rotationTarget: typeof p.rotationTarget === "number" ? p.rotationTarget : undefined,
              rotationTopic: typeof p.rotationTopic === "string" ? p.rotationTopic : undefined,
              exitNode: typeof p.exitNode === "string" ? p.exitNode : undefined,
              exitNodeMissing: typeof p.exitNodeMissing === "boolean" ? p.exitNodeMissing : undefined,
            })
          );
        }
        break;
      }
      case "openPage.changed": {
        const id = String(p.id || p.accountId || "");
        const open = Boolean(p.open ?? p.pageOpen);
        if (id) {
          setAccountsState((prev) =>
            handleSingleAccountStatusChanged(prev, { id, pageOpen: open })
          );
        }
        break;
      }
      case "group.changed": {
        if (p.groups && Array.isArray(p.groups)) {
          setGroups(p.groups as Group[]);
        } else if (p.group && typeof p.group === "object") {
          const g = p.group as Group;
          setGroups((prev) => {
            const idx = prev.findIndex((item) => item.id === g.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = g;
              return copy;
            }
            return [...prev, g];
          });
        }
        break;
      }
      case "proxyState.changed": {
        setProxies((prev) => ({ ...prev, ...(payload as ProxyState) }));
        break;
      }
      case "proxyNode.tested": {
        // 测速结果回填到那一行，不能只进任务中心。
        //
        // 事件 payload 与节点字段名**不同**：Agent 发的是 `{ id, ok, delay, message,
        // testedAt }`（见 src/proxyManager.js 的 rememberLatency），而节点上是
        // `latencyMs / latencyOk / latencyMessage / latencyTestedAt`。原来这里直接读
        // `p.latencyMs`，永远是 undefined，于是延迟从来没出现在行上。
        const nodeId = String(p.id ?? "");
        if (!nodeId) break;

        const ok = typeof p.ok === "boolean" ? p.ok : null;
        const latencyMs = typeof p.delay === "number" ? p.delay : null;
        const latencyMessage = typeof p.message === "string" ? p.message : null;
        const latencyTestedAt =
          typeof p.testedAt === "string" ? p.testedAt : new Date().toISOString();

        setProxies((prev) => ({
          ...prev,
          // 未知节点不新增行：订阅刷新后 Agent 可能测到一个我们还没拉到的节点，
          // 凭一条测速事件凭空造一行会缺 server/port 等全部字段。
          nodes: prev.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  latencyMs,
                  latencyOk: ok,
                  latencyMessage,
                  latencyTestedAt,
                }
              : node
          ),
        }));
        break;
      }
      case "conversation.changed": {
        if (p.conversations && typeof p.conversations === "object") {
          setConversations(p.conversations as Record<string, ConversationSet>);
        }
        break;
      }
      case "scheduler.changed": {
        const nextScheduler = payload as SchedulerState;
        setScheduler(nextScheduler);
        // 同步系统托盘调度状态
        if (typeof nextScheduler.running === "boolean") {
          setSchedulerTrayState(nextScheduler.running);
        }
        break;
      }
      case "scheduler.accountChanged": {
        const id = String(p.accountId || p.id || "");
        if (id) {
          setScheduler((prev) => ({
            ...prev,
            accounts: {
              ...prev.accounts,
              [id]: {
                ...prev.accounts[id],
                nextRunAt: typeof p.nextRunAt === "string" ? p.nextRunAt : prev.accounts[id]?.nextRunAt,
                lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : prev.accounts[id]?.lastRunAt,
                lastRunOk: typeof p.lastRunOk === "boolean" ? p.lastRunOk : prev.accounts[id]?.lastRunOk,
              },
            },
          }));
        }
        break;
      }
      case "operation.changed": {
        const op = payload as Operation;
        if (op && op.id) {
          setOperations((prev) => {
            const idx = prev.findIndex((o) => o.id === op.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = op;
              return copy;
            }
            return [op, ...prev];
          });

          // 如果是正在前台跟随的登录任务，实时更新
          setActiveLogin((current) => {
            if (current && current.operation?.id === op.id) {
              return { ...current, operation: op };
            }
            return current;
          });

          // profile-scan 的结果就是扫描数据本身。
          //
          // profiles.scan 是操作类方法（契约返回 operationResult），调用它只拿到一个操作
          // 描述符——原来 Profile 页直接 await 那个返回值并去里面找 profiles 数组，永远
          // 找不到，于是 42 个账号的机器上显示「无 Profile」且没有加载指示（loading 早已
          // 置回 false）。真正的数据在这里。
          if (op.kind === "profile-scan") {
            if (op.state === "succeeded") {
              setProfileScan(normalizeProfileScan(op.result));
              setProfileScanning(false);
            } else if (op.state === "failed" || op.state === "timed_out" || op.state === "cancelled") {
              setProfileScanning(false);
            }
          } else if (
            op.state === "succeeded" &&
            op.kind.startsWith("profile-")
          ) {
            // 其它 Profile 操作改变了磁盘状态，必须重新扫描才知道新的占用。
            void requestProfileScan();
          }
        }
        break;
      }
      case "settings.changed": {
        if (payload) {
          setAgentSettings(payload as AgentSettings);
        }
        break;
      }
      case "agent.draining": {
        setDraining(Boolean(p.draining ?? true));
        break;
      }
      case "queue.changed": {
        if (payload) {
          setQueueSnapshot(payload as QueueSnapshot);
        }
        break;
      }
      case "browserRun.changed": {
        // 增量更新 browser run 快照
        agentCall<BrowserRunListResult>("browserRuns.list")
          .then((res) => setBrowserRuns(res))
          .catch(() => {});
        break;
      }
    }
  }, []);

  // 初始化流程
  useEffect(() => {
    let unlisteners: (() => void)[] = [];

    const initialize = async () => {
      try {
        const info = await getStartupInfo();
        setStartupInfo(info);
        setDesktopSettings(info.settings);

        if (info.initialized) {
          // 已初始化数据目录，连接已有或启动 Agent
          const conn = await connectAgent(true);
          setConnection(conn);

          // 启动顺序：先检查更新，再决定是否启动调度。
          //
          // 反过来会造成一个真实的坏状态：调度已经拉起 Chrome 在跑对话，此时检查到新
          // 版本，用户点「立即更新」，而安装流程的第一步预检会因为「有任务在运行」直接
          // 被拒——用户只能先手动停调度、等任务收尾、再来一次。更新检查是只读的、几百
          // 毫秒的网络请求，让它先跑完不会推迟什么。
          //
          // 发现更新时**不自动启动调度**：这时屏幕上有一个待用户决定的更新提示，先把
          // 机器拉进「有任务在跑」的状态只会让那个决定变得更难执行。
          const updateFound = await checkUpdateBeforeScheduler();

          if (info.settings.autoStartScheduler) {
            if (updateFound) {
              toast.info("发现新版本，已暂缓自动启动调度；安装更新或忽略后可手动启动");
            } else {
              agentCall("scheduler.start", {}, await newCommandId()).catch(() => {});
            }
          }
        }
      } catch (err) {
        toast.error("启动初始化失败", err);
      } finally {
        setIsInitializing(false);
      }
    };

    listenTauriEvents({
      onBootstrap: handleBootstrapPayload,
      onAgentEvent: handleAgentEvent,
      onConnection: (conn) => setConnection(conn),
      onUpdate: (update) => {
        setUpdateModalState({
          isOpen: true,
          status: update,
          installing: update.state === "installing",
        });
      },
      onTrayAction: handleTrayAction,
      onCloseRequested: handleCloseRequested,
      onExitProgress: setExitProgress,
    }).then((un) => {
      unlisteners = un;
    });

    initialize();

    return () => {
      for (const un of unlisteners) un();
    };
  }, [
    handleBootstrapPayload,
    handleAgentEvent,
    handleTrayAction,
    handleCloseRequested,
    checkUpdateBeforeScheduler,
  ]);

  /// 用户在等待期间选择不再等待。跳过有序关闭，直接回收进程树。
  const forceExitAll = useCallback(() => {
    exitAll(true).catch((err) => toast.error("强制退出失败", err));
  }, []);

  // 手动触发全量快照同步
  const manualRefreshBootstrap = useCallback(async () => {
    try {
      await refreshBootstrap();
      toast.success("已请求全量状态同步");
    } catch (err) {
      toast.error("请求状态同步失败", err);
    }
  }, []);

  // 更新桌面客户端设置
  const updateDesktopSettings = useCallback(
    async (patch: Partial<DesktopSettings>) => {
      const next = { ...desktopSettings, ...patch };
      try {
        await saveSettings(next);
        setDesktopSettings(next);
        toast.success("桌面偏好设置已保存");
      } catch (err) {
        toast.error("保存桌面偏好设置失败", err);
        throw err;
      }
    },
    [desktopSettings]
  );

  // 更新 Agent 业务设置
  const updateAgentSettings = useCallback(async (patch: Partial<AgentSettings>) => {
    try {
      const cid = await newCommandId();
      await agentCall("settings.update", { patch }, cid);
      setAgentSettings((prev) => (prev ? { ...prev, ...patch } : null));
      toast.success("Agent 设置已保存");
    } catch (err) {
      toast.error("保存 Agent 设置失败", err);
      throw err;
    }
  }, []);

  // 账号操作分发
  const updateDraft = useCallback((id: string, patch: AccountPatch) => {
    setAccountsState((prev) => updateAccountDraft(prev, id, patch));
  }, []);

  const discardDraft = useCallback((id: string) => {
    setAccountsState((prev) => discardAccountDraft(prev, id));
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setAccountsState((prev) => toggleAccountSelection(prev, id));
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setAccountsState((prev) => selectAllAccounts(prev, ids));
  }, []);

  const deselectAll = useCallback(() => {
    setAccountsState((prev) => deselectAllAccounts(prev));
  }, []);

  const setFilter = useCallback((filter: Partial<AccountFilter>) => {
    setAccountsState((prev) => setAccountFilter(prev, filter));
  }, []);

  // 保存单个账号草稿修改（行为 2：三路合并保护）
  const saveAccount = useCallback(
    async (id: string, patch: AccountPatch) => {
      setAccountsState((prev) => startAccountSubmit(prev, id, patch));
      try {
        const cid = await newCommandId();
        const updated = await agentCall<Account>("accounts.update", { id, patch }, cid);
        setAccountsState((prev) => finishAccountSubmit(prev, id, patch, updated ? normalizeAccount(updated) : undefined));
        toast.success("账号已更新");
      } catch (err) {
        setAccountsState((prev) => failAccountSubmit(prev, id));
        toast.error("更新账号失败", err);
        throw err;
      }
    },
    []
  );

  // 发起登录（UI_BRIEF：必须开前台进度窗跟随 operation 并处理 waiting_user）
  const startLogin = useCallback(
    async (id: string, force = false) => {
      try {
        const cid = await newCommandId();
        const op = await agentCall<Operation>("browser.startLogin", { accountId: id, force }, cid);
        // 从 setter 里读账号名，而不是闭包捕获 accountsState。捕获会让这个回调的依赖
        // 变成「任何账号的任何变化」，而它被 28 张记忆化卡片共同持有——依赖一变，全部
        // 卡片的 memo 同时失效。这里只是要一个显示用的标签，不值得那个代价。
        setAccountsState((prev) => {
          const acc = prev.accounts[id]?.effective;
          setActiveLogin({
            accountId: id,
            accountEmail: acc?.email,
            accountNote: acc?.note,
            operation: op,
          });
          return prev;
        });
        toast.info("已发起登录流程，正在启动浏览器...");
      } catch (err) {
        toast.error("发起登录失败", err);
      }
    },
    []
  );

  // 新增账号（UI_BRIEF：创建账号后直接拉起登录窗口）
  const createAccount = useCallback(
    async (patch: AccountPatch): Promise<Account> => {
      try {
        const cid = await newCommandId();
        const raw = await agentCall<Account>("accounts.create", patch, cid);
        const created = normalizeAccount(raw);
        setAccountsState((prev) => handleSingleAccountChanged(prev, created));
        toast.success("账号已创建，正在准备登录...");
        // 直接拉起登录
        await startLogin(created.id, false);
        return created;
      } catch (err) {
        toast.error("创建账号失败", err);
        throw err;
      }
    },
    [startLogin]
  );

  // 删除账号
  const removeAccount = useCallback(
    async (id: string, profileAction: "detach" | "archive" | "purge") => {
      try {
        const cid = await newCommandId();
        await agentCall("accounts.remove", { id, profileAction }, cid);
        setAccountsState((prev) => handleSingleAccountRemoved(prev, id));
        toast.success("账号已删除");
      } catch (err) {
        toast.error("删除账号失败", err);
        throw err;
      }
    },
    []
  );

  // 刷新状态
  const refreshAccountStatus = useCallback(async (id: string) => {
    try {
      const cid = await newCommandId();
      await agentCall("accounts.refreshStatus", { id }, cid);
      toast.info("已提交状态刷新任务");
    } catch (err) {
      toast.error("刷新账号状态失败", err);
    }
  }, []);

  // 立即运行
  const runAccountNow = useCallback(async (id: string) => {
    try {
      const cid = await newCommandId();
      await agentCall("accounts.runNow", { id }, cid);
      toast.success("已提交立即运行任务");
    } catch (err) {
      toast.error("执行账号立即运行失败", err);
    }
  }, []);

  // 检查选择器
  const checkAccountSelectors = useCallback(async (id: string, deep = false) => {
    try {
      const cid = await newCommandId();
      await agentCall("accounts.checkSelectors", { id, deep }, cid);
      toast.info("已提交选择器检查任务");
    } catch (err) {
      toast.error("检查选择器失败", err);
    }
  }, []);

  // 打开/关闭网页
  const toggleOpenPage = useCallback(async (id: string, currentlyOpen: boolean) => {
    try {
      const cid = await newCommandId();
      if (currentlyOpen) {
        await agentCall("browser.closePage", { accountId: id }, cid);
        toast.info("正在关闭网页...");
      } else {
        await agentCall("browser.openPage", { accountId: id }, cid);
        toast.info("正在打开网页...");
      }
    } catch (err) {
      toast.error(currentlyOpen ? "关闭网页失败" : "打开网页失败", err);
    }
  }, []);

  // 批量操作
  const bulkEnable = useCallback(
    async (ids: string[], enabled: boolean) => {
      const failures: BulkFailure[] = [];
      for (const id of ids) {
        try {
          const cid = await newCommandId();
          const updated = await agentCall<Account>(
            "accounts.update",
            { id, patch: { enabled } },
            cid
          );
          // 必须用 handleSingleAccountChanged 而不是 handleSingleAccountStatusChanged：
          // 后者只处理巡检状态字段，完全不碰 enabled，于是界面上的开关不会动，用户会
          // 以为没生效再点一次。
          if (updated) {
            const account = normalizeAccount(updated);
            setAccountsState((prev) => handleSingleAccountChanged(prev, account));
          }
        } catch (error) {
          failures.push({ id, error });
        }
      }
      reportBulkOutcome(enabled ? "批量启用" : "批量停用", ids.length, failures);
    },
    []
  );

  const bulkRefreshStatus = useCallback(async (ids: string[]) => {
    const failures: BulkFailure[] = [];
    for (const id of ids) {
      try {
        const cid = await newCommandId();
        await agentCall("accounts.refreshStatus", { id }, cid);
      } catch (error) {
        failures.push({ id, error });
      }
    }
    reportBulkOutcome("批量刷新状态", ids.length, failures);
  }, []);

  // 串行，且必须保持串行：每个 runNow 会拉起一个真实 Chrome，并发提交 28 个账号
  // 等于同时开 28 个浏览器。
  const bulkRunNow = useCallback(async (ids: string[]) => {
    const failures: BulkFailure[] = [];
    for (const id of ids) {
      try {
        const cid = await newCommandId();
        await agentCall("accounts.runNow", { id }, cid);
      } catch (error) {
        failures.push({ id, error });
      }
    }
    reportBulkOutcome("批量立即运行", ids.length, failures);
  }, []);

  const bulkDelete = useCallback(
    async (ids: string[], profileAction: "detach" | "archive" | "purge") => {
      const failures: BulkFailure[] = [];
      for (const id of ids) {
        try {
          const cid = await newCommandId();
          await agentCall("accounts.remove", { id, profileAction }, cid);
          setAccountsState((prev) => handleSingleAccountRemoved(prev, id));
        } catch (error) {
          // 删除失败的账号必须留在列表里。乐观移除会让用户以为删掉了，
          // 下次刷新它又出现。
          failures.push({ id, error });
        }
      }
      reportBulkOutcome("批量删除", ids.length, failures);
    },
    []
  );

  // 关闭窗口弹窗选择处理
  const handleMinimizeToTray = useCallback(
    async (remember: boolean) => {
      setCloseModalOpen(false);
      if (remember) {
        await updateDesktopSettings({ closeBehavior: "minimizeToTray" });
      }
      hideToTray().catch((err) => toast.error("隐藏到托盘失败", err));
    },
    [updateDesktopSettings]
  );

  const handleExitAll = useCallback(
    async (remember: boolean) => {
      setCloseModalOpen(false);
      if (remember) {
        await updateDesktopSettings({ closeBehavior: "exitAll" });
      }
      exitAll().catch((err) => toast.error("退出失败", err));
    },
    [updateDesktopSettings]
  );

  // 这两个原本是 value 字面量里的内联箭头函数。留在那里的话，即使把 value 记忆化，
  // 它们每次渲染仍是新引用，依赖数组会一直变。
  const closeActiveLogin = useCallback(() => setActiveLogin(null), []);
  const closeCloseModal = useCallback(() => setCloseModalOpen(false), []);

  // 必须记忆化。AppContext 被 28 张账号卡片共同消费，而 value 只要是 render 期间新建的
  // 对象，任何一次无关的状态变化（连接状态、任务列表、队列快照）都会让全部卡片重渲染，
  // 下游的 React.memo 也就成了装饰。巡检每 15 分钟推 28 条事件，这个差别是 784 次
  // 卡片渲染 vs 28 次。见 __tests__/accountsRenderCost.test.tsx。
  const value: AppContextValue = useMemo(
    () => ({
      startupInfo,
      isInitializing,
      connection,
      bootstrap,
      desktopSettings,
      updateDesktopSettings,
      agentSettings,
      updateAgentSettings,
      accountsState,
      updateDraft,
      discardDraft,
      toggleSelect,
      selectAll,
      deselectAll,
      setFilter,
      saveAccount,
      createAccount,
      removeAccount,
      refreshAccountStatus,
      runAccountNow,
      checkAccountSelectors,
      startLogin,
      toggleOpenPage,
      bulkEnable,
      bulkRefreshStatus,
      bulkRunNow,
      bulkDelete,
      groups,
      proxies,
      conversations,
      scheduler,
      operations,
      activeOperations,
      historyAccounts,
      browserRuns,
      queueSnapshot,
      profileScan,
      profileScanning,
      requestProfileScan,
      draining,
      activeLogin,
      closeActiveLogin,
      manualRefreshBootstrap,
    startScheduler,
    stopScheduler,
    toggleScheduler,
    updateModalState,
    checkAppUpdate,
    installAppUpdate,
    closeUpdateModal,
    closeModalOpen,
    exitProgress,
    forceExitAll,
    handleMinimizeToTray,
    handleExitAll,
      closeCloseModal,
      activeTab,
      setActiveTab,
    }),
    [
      startupInfo,
      isInitializing,
      connection,
      bootstrap,
      desktopSettings,
      updateDesktopSettings,
      agentSettings,
      updateAgentSettings,
      accountsState,
      updateDraft,
      discardDraft,
      toggleSelect,
      selectAll,
      deselectAll,
      setFilter,
      saveAccount,
      createAccount,
      removeAccount,
      refreshAccountStatus,
      runAccountNow,
      checkAccountSelectors,
      startLogin,
      toggleOpenPage,
      bulkEnable,
      bulkRefreshStatus,
      bulkRunNow,
      bulkDelete,
      groups,
      proxies,
      conversations,
      scheduler,
      operations,
      activeOperations,
      historyAccounts,
      browserRuns,
      queueSnapshot,
      profileScan,
      profileScanning,
      requestProfileScan,
      draining,
      activeLogin,
      closeActiveLogin,
      manualRefreshBootstrap,
      startScheduler,
      stopScheduler,
      toggleScheduler,
      updateModalState,
      checkAppUpdate,
      installAppUpdate,
      closeUpdateModal,
      closeModalOpen,
      exitProgress,
      forceExitAll,
      exitProgress,
      forceExitAll,
      handleMinimizeToTray,
      handleExitAll,
      closeCloseModal,
      activeTab,
    ]
  );

  // 依赖全是 [] 的回调，所以这个对象只在首次渲染时创建一次。
  const accountActions: AccountActions = useMemo(
    () => ({
      updateDraft,
      saveAccount,
      startLogin,
      toggleOpenPage,
      runAccountNow,
      refreshAccountStatus,
      checkAccountSelectors,
    }),
    [
      updateDraft,
      saveAccount,
      startLogin,
      toggleOpenPage,
      runAccountNow,
      refreshAccountStatus,
      checkAccountSelectors,
    ]
  );

  return (
    <AppContext.Provider value={value}>
      <AccountActionsContext.Provider value={accountActions}>
        {children}
      </AccountActionsContext.Provider>
    </AppContext.Provider>
  );
};

export const useApp = (): AppContextValue => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};
