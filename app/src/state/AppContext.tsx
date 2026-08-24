// 全局应用状态上下文
// 汇聚 IPC 事件流、全量快照同步、账号草稿合并与跨页面协同

import React, { createContext, useContext, useEffect, useState, useCallback, useTransition } from "react";
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
  Group,
  HistoryAccount,
  Operation,
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

interface AppContextValue {
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
  const [draining, setDraining] = useState(false);

  const [activeLogin, setActiveLogin] = useState<ActiveLoginState | null>(null);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
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
        // 将测试延迟直接回填到该节点的行内
        const nodeId = String(p.nodeId || p.id || "");
        const latencyMs = typeof p.latencyMs === "number" ? p.latencyMs : null;
        const error = typeof p.error === "string" ? p.error : null;
        const lastTestedAt = typeof p.testedAt === "string" ? p.testedAt : new Date().toISOString();

        if (nodeId) {
          setProxies((prev) => ({
            ...prev,
            nodes: prev.nodes.map((node) =>
              node.id === nodeId
                ? { ...node, latencyMs, error, lastTestedAt }
                : node
            ),
          }));
        }
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

          if (info.settings.autoStartScheduler) {
            agentCall("scheduler.start", {}, await newCommandId()).catch(() => {});
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
    }).then((un) => {
      unlisteners = un;
    });

    initialize();

    return () => {
      for (const un of unlisteners) un();
    };
  }, [handleBootstrapPayload, handleAgentEvent, handleTrayAction, handleCloseRequested]);

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
        const acc = accountsState.accounts[id]?.effective;
        setActiveLogin({
          accountId: id,
          accountEmail: acc?.email,
          accountNote: acc?.note,
          operation: op,
        });
        toast.info("已发起登录流程，正在启动浏览器...");
      } catch (err) {
        toast.error("发起登录失败", err);
      }
    },
    [accountsState.accounts]
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
      let succeeded = 0;
      for (const id of ids) {
        try {
          const cid = await newCommandId();
          await agentCall("accounts.update", { id, patch: { enabled } }, cid);
          setAccountsState((prev) =>
            handleSingleAccountStatusChanged(prev, { id })
          );
          succeeded++;
        } catch {
          // 批量操作容忍单项失败并汇总
        }
      }
      toast.success(`批量${enabled ? "启用" : "停用"}完成 (${succeeded}/${ids.length})`);
    },
    []
  );

  const bulkRefreshStatus = useCallback(async (ids: string[]) => {
    let count = 0;
    for (const id of ids) {
      try {
        const cid = await newCommandId();
        await agentCall("accounts.refreshStatus", { id }, cid);
        count++;
      } catch {}
    }
    toast.success(`已提交 ${count} 个账号的状态刷新任务`);
  }, []);

  const bulkRunNow = useCallback(async (ids: string[]) => {
    let count = 0;
    for (const id of ids) {
      try {
        const cid = await newCommandId();
        await agentCall("accounts.runNow", { id }, cid);
        count++;
      } catch {}
    }
    toast.success(`已提交 ${count} 个账号的运行任务`);
  }, []);

  const bulkDelete = useCallback(
    async (ids: string[], profileAction: "detach" | "archive" | "purge") => {
      let count = 0;
      for (const id of ids) {
        try {
          const cid = await newCommandId();
          await agentCall("accounts.remove", { id, profileAction }, cid);
          setAccountsState((prev) => handleSingleAccountRemoved(prev, id));
          count++;
        } catch {}
      }
      toast.success(`批量删除完成，共移除 ${count} 个账号`);
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

  const value: AppContextValue = {
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
    draining,
    activeLogin,
    closeActiveLogin: () => setActiveLogin(null),
    manualRefreshBootstrap,
    startScheduler,
    stopScheduler,
    toggleScheduler,
    updateModalState,
    checkAppUpdate,
    installAppUpdate,
    closeUpdateModal,
    closeModalOpen,
    handleMinimizeToTray,
    handleExitAll,
    closeCloseModal: () => setCloseModalOpen(false),
    activeTab,
    setActiveTab,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppContextValue => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};
