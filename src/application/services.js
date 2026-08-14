import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as storeModule from "../store.js";
import { runOnce as defaultRunOnce, scheduler as defaultScheduler } from "../scheduler.js";
import {
  startLogin as defaultStartLogin,
  getLoginTask as defaultGetLoginTask,
  closeAllLoginTasks as defaultCloseAllLoginTasks,
} from "../loginProvider.js";
import {
  openPageForAccount as defaultOpenPageForAccount,
  closePageForAccount as defaultClosePageForAccount,
  closeAllOpenPages as defaultCloseAllOpenPages,
  getOpenPages as defaultGetOpenPages,
} from "../openPage.js";
import * as proxyModule from "../proxyManager.js";
import { clearRegionCache as defaultClearRegionCache } from "../geo.js";
import {
  getAllCachedStatus as defaultGetAllCachedStatus,
  getCachedStatus as defaultGetCachedStatus,
  deleteCachedStatus as defaultDeleteCachedStatus,
  refreshAccount as defaultRefreshAccount,
  restartStatusMonitor as defaultRestartStatusMonitor,
  stopStatusMonitor as defaultStopStatusMonitor,
} from "../statusMonitor.js";
import {
  recordConversation as defaultRecordConversation,
  readHistory as defaultReadHistory,
  listHistoryAccounts as defaultListHistoryAccounts,
  subscribeHistory as defaultSubscribeHistory,
} from "../logger.js";
import { subscribeOpenPages as defaultSubscribeOpenPages } from "../openPage.js";
import { profileManager as defaultProfileManager } from "../profileManager.js";
import { isBusy as defaultIsBusy, isHeld as defaultIsHeld } from "../locks.js";
import { validateSettingsPatch as defaultValidateSettingsPatch } from "../statusSettings.js";
import { ApplicationEventBus } from "./events.js";
import {
  ApplicationError,
  ERROR_CODES,
  assertInput,
  fail,
  normalizeApplicationError,
} from "./errors.js";
import { OperationRegistry } from "./operations.js";
import { InMemoryReceiptStore, ReceiptCoordinator } from "./receipts.js";

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 1 });

export const MUTATING_METHODS = new Set([
  "system.prepareUpdate",
  "system.shutdown",
  "accounts.create",
  "accounts.update",
  "accounts.remove",
  "accounts.refreshStatus",
  "accounts.runNow",
  "browser.startLogin",
  "browser.openPage",
  "browser.closePage",
  "groups.create",
  "groups.update",
  "groups.remove",
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
  "conversations.upsert",
  "conversations.remove",
  "scheduler.start",
  "scheduler.stop",
  "settings.update",
]);

const DRAIN_ALLOWED_MUTATIONS = new Set([
  "system.prepareUpdate",
  "system.shutdown",
  "browser.closePage",
  "scheduler.stop",
]);

const ACCOUNT_PATCH_FIELDS = new Set([
  "note",
  "groupId",
  "enabled",
  "switchRule",
  "minWindows",
  "maxWindows",
]);

const TERMINAL_LOGIN_STATUSES = new Set(["success", "failed", "timeout"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function packageVersion() {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APPLICATION_VERSION = packageVersion();

export function createDefaultRuntime(overrides = {}) {
  return {
    store: storeModule,
    scheduler: defaultScheduler,
    proxies: proxyModule,
    profileManager: defaultProfileManager,
    runOnce: defaultRunOnce,
    startLogin: defaultStartLogin,
    getLoginTask: defaultGetLoginTask,
    closeAllLoginTasks: defaultCloseAllLoginTasks,
    openPageForAccount: defaultOpenPageForAccount,
    closePageForAccount: defaultClosePageForAccount,
    closeAllOpenPages: defaultCloseAllOpenPages,
    getOpenPages: defaultGetOpenPages,
    clearRegionCache: defaultClearRegionCache,
    getAllCachedStatus: defaultGetAllCachedStatus,
    getCachedStatus: defaultGetCachedStatus,
    deleteCachedStatus: defaultDeleteCachedStatus,
    refreshAccount: defaultRefreshAccount,
    restartStatusMonitor: defaultRestartStatusMonitor,
    stopStatusMonitor: defaultStopStatusMonitor,
    recordConversation: defaultRecordConversation,
    readHistory: defaultReadHistory,
    listHistoryAccounts: defaultListHistoryAccounts,
    subscribeHistory: defaultSubscribeHistory,
    subscribeOpenPages: defaultSubscribeOpenPages,
    isBusy: defaultIsBusy,
    isHeld: defaultIsHeld,
    validateSettingsPatch: defaultValidateSettingsPatch,
    sleep,
    loginPollMs: 250,
    agentVersion: APPLICATION_VERSION,
    build: process.env.GPT_ACCOUNT_KEEPER_BUILD ?? APPLICATION_VERSION,
    schemaVersion: 0,
    dataRoot: process.env.GPT_ACCOUNT_KEEPER_DATA_ROOT ?? null,
    ipcAuthToken: null,
    lifecycle: {},
    reportBackgroundError: (error) => console.error(error?.stack || error),
    ...overrides,
  };
}

function requireObject(value, label = "params") {
  assertInput(
    value == null || (typeof value === "object" && !Array.isArray(value)),
    `${label} 必须是对象`
  );
  return value ?? {};
}

function requireId(params, key = "id") {
  const value = String(params?.[key] ?? "").trim();
  assertInput(value, `${key} 不能为空`);
  return value;
}

function safeLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  assertInput(Number.isInteger(parsed) && parsed >= 1 && parsed <= 500, "limit 必须是 1 到 500 的整数");
  return parsed;
}

/**
 * 账号视图需要调度状态、分组和节点表。列表映射时这三样只应该算一次；
 * 早先每个账号各自去读一遍，26 个账号就是 26 次订阅文件全文解析。
 */
function accountViewContext(runtime) {
  const schedulerStatus = runtime.scheduler.status?.() ?? {};
  return {
    openPages: runtime.getOpenPages(),
    schedules: schedulerStatus.accounts ?? {},
    lastResults: schedulerStatus.lastResults ?? {},
    groups: new Map((runtime.store.getGroups() ?? []).map((group) => [group.id, group])),
    nodes: new Map((runtime.proxies.getNodes() ?? []).map((node) => [node.id, node])),
  };
}

function publicAccount(account, runtime, context = accountViewContext(runtime)) {
  const status = runtime.getCachedStatus(account.id);
  const openPages = context.openPages;
  const schedule = context.schedules[account.id] ?? null;
  const lastResult = context.lastResults[account.id] ?? null;
  const rotation = account.rotation ?? {};
  const group = account.groupId ? context.groups.get(account.groupId) ?? null : null;
  const proxyId = group?.proxyId ?? null;
  const node = proxyId ? context.nodes.get(proxyId) ?? null : null;
  return {
    ...account,
    state: status.state ?? null,
    loggedIn: !!status.loggedIn,
    statusDetail: status.detail ?? null,
    checkedAt: status.checkedAt ?? null,
    stale: !!status.stale,
    lastCheckState: status.lastCheckState ?? null,
    lastCheckDetail: status.lastCheckDetail ?? null,
    confirmedState: status.confirmedState ?? null,
    confirmedAt: status.confirmedAt ?? null,
    consecutiveUnknowns: status.consecutiveUnknowns ?? 0,
    unknownSince: status.unknownSince ?? null,
    pageOpen: !!openPages[account.id],
    // 轮换进度：界面上"当前主题 + 已完成/目标窗口"直接来自这三项。
    rotationCurrentSet: rotation.currentSet ?? null,
    rotationWindowsDone: rotation.windowsDone ?? 0,
    rotationWindowsTarget: rotation.windowsTarget ?? 0,
    // 出口：账号自己不持有代理，出口完全由所属分组决定。
    groupName: group?.name ?? null,
    proxyId,
    proxyName: node?.name ?? null,
    proxyMissing: proxyId ? !node || !!node.missing || node.enabled === false : false,
    // 调度：下次/上次运行时间与上次结果，避免客户端为此单独轮询。
    nextRunAt: schedule?.nextAt ?? null,
    lastRunAt: schedule?.lastAt ?? null,
    running: !!schedule?.busy,
    lastRunOk: lastResult?.ok ?? null,
    lastRunReason: lastResult?.reason ?? null,
  };
}

function publicStatus(account, status) {
  return {
    id: account.id,
    state: status.state ?? null,
    loggedIn: !!status.loggedIn,
    email: status.email ?? account.email ?? null,
    detail: status.detail ?? null,
    checkedAt: status.checkedAt ?? null,
    stale: !!status.stale,
    lastCheckState: status.lastCheckState ?? status.state ?? null,
    lastCheckDetail: status.lastCheckDetail ?? status.detail ?? null,
    confirmedState: status.confirmedState ?? null,
    confirmedAt: status.confirmedAt ?? null,
    consecutiveUnknowns: status.consecutiveUnknowns ?? 0,
    unknownSince: status.unknownSince ?? null,
    skipped: !!status.skipped,
    skipKind: status.skipKind ?? null,
    skipReason: status.skipReason ?? null,
  };
}

function publicSchedulerStatus(runtime) {
  const status = runtime.scheduler.status?.() ?? {};
  return {
    ...status,
    running: !!status.running,
    enabled: status.enabled == null ? !!status.running : !!status.enabled,
    accounts: status.accounts && typeof status.accounts === "object" ? status.accounts : {},
    lastResults: status.lastResults && typeof status.lastResults === "object" ? status.lastResults : {},
  };
}

/**
 * 历史条目统一成 { time, ok, setName, topic, totalRounds, error, rounds:[{q,a,at}] }。
 * 旧 JSONL 与 SQLite payload 都是自由结构，界面不该自己去猜字段，
 * 更不该在取不到时把原始 JSON 铺给用户看。
 */
function publicHistoryEntry(entry) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const rounds = Array.isArray(raw.rounds) ? raw.rounds : [];
  return {
    time: raw.time ?? raw.finishedAt ?? null,
    ok: raw.ok == null ? null : !!raw.ok,
    setName: raw.setName ?? null,
    topic: raw.topic ?? null,
    totalRounds: Number.isFinite(raw.totalRounds) ? raw.totalRounds : rounds.length,
    error: raw.reason ?? raw.error ?? null,
    needReauth: !!raw.needReauth,
    rounds: rounds
      .filter((round) => round && typeof round === "object")
      .map((round) => ({
        question: round.q ?? round.question ?? null,
        answer: round.a ?? round.answer ?? round.reply ?? null,
        at: round.at ?? null,
      })),
  };
}

function validateAccountPatch(input, current = {}) {
  const patch = requireObject(input, "账号更新内容");
  const unknown = Object.keys(patch).find((key) => !ACCOUNT_PATCH_FIELDS.has(key));
  assertInput(!unknown, `不允许更新账号字段：${unknown}`);
  if (Object.hasOwn(patch, "note")) assertInput(typeof patch.note === "string", "note 必须是字符串");
  if (Object.hasOwn(patch, "enabled")) assertInput(typeof patch.enabled === "boolean", "enabled 必须是布尔值");
  if (Object.hasOwn(patch, "switchRule")) {
    assertInput(["random", "sequential"].includes(patch.switchRule), "switchRule 必须是 random 或 sequential");
  }
  for (const key of ["minWindows", "maxWindows"]) {
    if (Object.hasOwn(patch, key)) {
      assertInput(Number.isInteger(patch[key]) && patch[key] >= 1 && patch[key] <= 100, `${key} 必须是 1 到 100 的整数`);
    }
  }
  if (Object.hasOwn(patch, "groupId")) {
    assertInput(patch.groupId === null || typeof patch.groupId === "string", "groupId 必须是字符串或 null");
  }
  const min = patch.minWindows ?? current.minWindows ?? 1;
  const max = patch.maxWindows ?? current.maxWindows ?? 3;
  assertInput(min <= max, "minWindows 不能大于 maxWindows");
  return patch;
}

function loginFailure(task) {
  const code = task?.code === "LOGIN_FORCE_CONFLICT"
    ? ERROR_CODES.LOGIN_FORCE_CONFLICT
    : task?.code === "LOGIN_ACCOUNT_HELD" || task?.code === "LOGIN_ACCOUNT_BUSY"
      ? ERROR_CODES.RESOURCE_BUSY
      : ERROR_CODES.INTERNAL;
  if (code === ERROR_CODES.INTERNAL) {
    const normalized = normalizeApplicationError(
      Object.assign(new Error(task?.message || "登录任务失败"), {
        code: task?.code,
      })
    );
    if (normalized.code !== ERROR_CODES.INTERNAL) return normalized;
  }
  return new ApplicationError(code, task?.message || "登录任务失败", {
    retryable: code === ERROR_CODES.RESOURCE_BUSY,
    details: task?.conflictTaskId ? { conflictTaskId: task.conflictTaskId } : undefined,
  });
}

export class ApplicationServices {
  constructor(options = {}) {
    this.runtime = createDefaultRuntime(options.runtime);
    this.events = options.events ?? new ApplicationEventBus(options.eventOptions);
    this.operations = options.operations ?? new OperationRegistry({
      events: this.events,
      store: options.operationStore ?? null,
    });
    // 恢复上次运行留下的任务历史；未完成的会被标记为已取消，
    // 不会在"活动任务"里伪装成仍在运行。
    this.operations.restore?.();
    this.receipts = options.receipts ?? new ReceiptCoordinator(
      options.receiptStore ?? new InMemoryReceiptStore()
    );
    this.protocol = options.protocol ?? PROTOCOL_VERSION;
    this.draining = false;
    this._methods = this._buildMethods();
    this._subscriptions = this._subscribeRuntime();
  }

  /**
   * 把运行时的真实变化转成事件。少了这一层，管理端只能对每个事件做一次
   * 全量 bootstrap，或者干脆退回定时轮询。
   */
  _subscribeRuntime() {
    const subscriptions = [];
    const openPages = this.runtime.subscribeOpenPages?.((change) => {
      this.events.publish("openPage.changed", {
        accountId: change.accountId,
        open: !!change.open,
        url: change.url ?? null,
        openedAt: change.openedAt ?? null,
      });
    });
    if (typeof openPages === "function") subscriptions.push(openPages);

    const history = this.runtime.subscribeHistory?.((change) => {
      this.events.publish("history.appended", {
        accountId: change.accountId,
        entry: publicHistoryEntry(change.entry),
      });
    });
    if (typeof history === "function") subscriptions.push(history);

    const schedule = this.runtime.scheduler.subscribe?.((change) => {
      if (change.kind === "scheduler") {
        this.events.publish("scheduler.changed", publicSchedulerStatus(this.runtime));
        return;
      }
      this.events.publish("scheduler.accountChanged", {
        accountId: change.accountId,
        nextAt: change.nextAt ?? null,
        lastAt: change.lastAt ?? null,
        busy: !!change.busy,
        lastResultState: change.lastResultState ?? null,
        lastResult: change.lastResult ?? null,
      });
    });
    if (typeof schedule === "function") subscriptions.push(schedule);
    return subscriptions;
  }

  /** 停止转发运行时事件。测试与 Agent 关闭时调用，避免观察者泄漏。 */
  dispose() {
    for (const unsubscribe of this._subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 取消订阅失败不应阻塞关闭流程
      }
    }
  }

  async execute(request) {
    const method = String(request?.method ?? "");
    assertInput(method, "method 不能为空");
    const mutating = MUTATING_METHODS.has(method);
    if (mutating) {
      const commandId = String(request?.commandId ?? "").trim();
      if (!commandId) {
        fail(ERROR_CODES.VALIDATION_FAILED, "修改命令必须提供 commandId");
      }
      assertInput(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId),
        "commandId 必须是 UUID"
      );
      if (this.draining && !DRAIN_ALLOWED_MUTATIONS.has(method)) {
        fail(ERROR_CODES.AGENT_DRAINING, "Agent 正在为更新或退出做准备", { retryable: true });
      }
      try {
        const receipt = await this.receipts.execute(
          commandId,
          () => this.invoke(method, request?.params),
          method
        );
        return receipt.value;
      } catch (error) {
        throw normalizeApplicationError(error);
      }
    }
    return this.invoke(method, request?.params);
  }

  async invoke(method, params = {}) {
    const handler = this._methods.get(method);
    if (!handler) fail(ERROR_CODES.VALIDATION_FAILED, `未知方法：${method}`);
    try {
      return await handler(requireObject(params));
    } catch (error) {
      throw normalizeApplicationError(error);
    }
  }

  _buildMethods() {
    const methods = new Map();
    const add = (name, fn) => methods.set(name, fn.bind(this));

    add("system.hello", this._hello);
    add("system.bootstrap", this._bootstrap);
    add("system.getActivity", this._getActivity);
    add("system.prepareUpdate", this._prepareUpdate);
    add("system.shutdown", this._shutdown);
    add("accounts.list", this._accountsList);
    add("accounts.create", this._accountsCreate);
    add("accounts.update", this._accountsUpdate);
    add("accounts.remove", this._accountsRemove);
    add("accounts.getStatus", this._accountsGetStatus);
    add("accounts.refreshStatus", this._accountsRefreshStatus);
    add("accounts.runNow", this._accountsRunNow);
    add("accounts.history", this._historyQuery);
    add("history.query", this._historyQuery);
    add("history.listAccounts", this._historyListAccounts);
    add("browser.startLogin", this._browserStartLogin);
    add("browser.getTask", this._browserGetTask);
    add("browser.openPage", this._browserOpenPage);
    add("browser.closePage", this._browserClosePage);
    add("browser.listOpenPages", this._browserListOpenPages);
    add("groups.list", this._groupsList);
    add("groups.create", this._groupsCreate);
    add("groups.update", this._groupsUpdate);
    add("groups.remove", this._groupsRemove);
    add("proxies.getState", this._proxiesGetState);
    add("proxies.importSubscription", this._proxiesImport);
    add("proxies.refreshSubscription", this._proxiesRefresh);
    add("proxies.setRuntimeDirectory", this._proxiesSetDirectory);
    add("proxies.setNodeEnabled", this._proxiesSetNodeEnabled);
    add("proxies.testNode", this._proxiesTestNode);
    add("proxies.testAll", this._proxiesTestAll);
    add("profiles.scan", this._profilesScan);
    add("profiles.cleanCache", this._profilesCleanCache);
    add("profiles.archiveOrphan", this._profilesArchiveOrphan);
    add("profiles.purgeOrphan", this._profilesPurgeOrphan);
    add("conversations.list", this._conversationsList);
    add("conversations.upsert", this._conversationsUpsert);
    add("conversations.remove", this._conversationsRemove);
    add("scheduler.getState", this._schedulerGetState);
    add("scheduler.start", this._schedulerStart);
    add("scheduler.stop", this._schedulerStop);
    add("settings.get", this._settingsGet);
    add("settings.update", this._settingsUpdate);
    add("operations.get", this._operationsGet);
    add("operations.listActive", this._operationsListActive);
    add("operations.list", this._operationsList);
    return methods;
  }

  _hello(params) {
    if (this.runtime.ipcAuthToken) {
      const expected = Buffer.from(this.runtime.ipcAuthToken);
      const actual = Buffer.from(String(params.authToken ?? ""));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        fail(ERROR_CODES.PROTOCOL_MISMATCH, "IPC 客户端身份验证失败");
      }
    }
    const requested = params.protocol ?? params.protocolVersion ?? {};
    assertInput(
      typeof params.clientVersion === "string" && params.clientVersion.trim(),
      "clientVersion 不能为空"
    );
    assertInput(Array.isArray(params.capabilities), "capabilities 必须是数组");
    assertInput(
      params.capabilities.every((item) => typeof item === "string"),
      "capabilities 只能包含字符串"
    );
    const major = Number(requested.major);
    const minor = Number(requested.minor);
    if (major !== this.protocol.major) {
      fail(
        ERROR_CODES.PROTOCOL_MISMATCH,
        `协议主版本不兼容：客户端 ${Number.isFinite(major) ? major : "未知"}，Agent ${this.protocol.major}`,
        { details: { requested, supported: this.protocol } }
      );
    }
    if (!Number.isInteger(minor) || minor < 0 || minor > this.protocol.minor) {
      fail(
        ERROR_CODES.PROTOCOL_MISMATCH,
        `协议次版本不兼容：客户端 ${Number.isFinite(minor) ? minor : "未知"}，Agent 支持 0-${this.protocol.minor}`,
        { details: { requested, supported: this.protocol } }
      );
    }
    if (params.dataRoot !== undefined) {
      assertInput(typeof params.dataRoot === "string" && params.dataRoot.trim(), "dataRoot 不能为空");
      if (this.runtime.dataRoot) {
        const normalize = (value) => {
          const resolved = path.resolve(value);
          return process.platform === "win32" ? resolved.toUpperCase() : resolved;
        };
        if (normalize(params.dataRoot) !== normalize(this.runtime.dataRoot)) {
          fail(ERROR_CODES.PROTOCOL_MISMATCH, "Desktop 与 Agent 数据目录不一致", {
            details: { requestedDataRoot: params.dataRoot, agentDataRoot: this.runtime.dataRoot },
          });
        }
      }
    }
    return {
      protocol: {
        major: this.protocol.major,
        minMinor: 0,
        maxMinor: this.protocol.minor,
      },
      agentVersion: this.runtime.agentVersion,
      buildId: this.runtime.build,
      dataSchemaVersion: this.runtime.schemaVersion,
      instanceId: this.events.instanceId,
      dataRoot: this.runtime.dataRoot,
      capabilities: [
        "operations",
        "events",
        "command-receipts",
        "real-chrome",
        process.platform === "win32" ? "named-pipe" : "unix-socket",
      ],
    };
  }

  _bootstrap() {
    const context = accountViewContext(this.runtime);
    return {
      instanceId: this.events.instanceId,
      revision: this.events.revision,
      accounts: this.runtime.store.getAccounts()
        .map((account) => publicAccount(account, this.runtime, context)),
      statuses: this.runtime.getAllCachedStatus(),
      openPages: this.runtime.getOpenPages(),
      groups: this.runtime.store.getGroups(),
      proxies: this._proxiesGetState(),
      conversations: this.runtime.store.getConversations(),
      scheduler: publicSchedulerStatus(this.runtime),
      settings: this.runtime.store.getSettings(),
      // 带上最近的已结束任务：重连或重启后错误详情不该消失。
      operations: this.operations.list({ limit: 100, includeTerminal: true }),
      activeOperations: this.operations.listActive(),
      historyAccounts: this.runtime.listHistoryAccounts?.() ?? [],
      draining: this.draining,
    };
  }

  _getActivity() {
    const openPages = this.runtime.getOpenPages();
    const operations = this.operations.listActive();
    const resourceLocks = this.runtime.store.getAccounts()
      .filter((account) => this.runtime.isBusy(account.id) || this.runtime.isHeld(account.id))
      .filter((account) => !openPages[account.id])
      .map((account) => ({
        kind: "account-busy",
        resourceId: account.id,
        detail: { note: account.note ?? null },
      }));
    return {
      draining: this.draining,
      scheduler: publicSchedulerStatus(this.runtime),
      openPages,
      operations,
      blockers: [
        ...Object.entries(openPages).map(([accountId, page]) => ({
          kind: "open-page",
          resourceId: accountId,
          detail: page,
        })),
        ...operations
          .filter((operation) => operation.blocksUpdate)
          .map((operation) => ({ kind: "operation", resourceId: operation.id, detail: operation })),
        ...resourceLocks,
      ],
    };
  }

  async _prepareUpdate(params) {
    const activity = this._getActivity();
    if (activity.blockers.length) return { ready: false, ...activity };
    if (params.commit !== true) return { ready: true, committed: false, ...activity };
    const schedulerWasRunning = publicSchedulerStatus(this.runtime).running === true;
    let schedulerDrained = !schedulerWasRunning;
    this.draining = true;
    this.events.publish("agent.draining", { reason: params.reason ?? "update" });
    let monitorStopped = false;
    try {
      this.runtime.stopStatusMonitor?.();
      monitorStopped = true;
      if (typeof this.runtime.scheduler.drain === "function") {
        const drained = await this.runtime.scheduler.drain({ timeoutMs: 60_000, preserveEnabled: true });
        schedulerDrained = drained?.drained === true;
        if (!drained?.drained) {
          fail(ERROR_CODES.RESOURCE_BUSY, "调度任务未能在限定时间内安全结束", { retryable: true });
        }
      } else {
        await this.runtime.scheduler.stop();
        schedulerDrained = true;
      }
      await this.runtime.lifecycle?.checkpoint?.();
      this.events.publish("agent.readyForUpdate", {});
      return { ready: true, committed: true, ...this._getActivity() };
    } catch (error) {
      // 准备更新是事务式状态切换：备份、checkpoint 或 drain 任一步失败，都不能
      // 把 Agent 留在“拒绝写入但又不会安装”的半停机状态。
      const recoveryErrors = [];
      if (monitorStopped) {
        try {
          this.runtime.restartStatusMonitor?.();
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (schedulerWasRunning && schedulerDrained) {
        try {
          await this.runtime.scheduler.start();
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      this.draining = false;
      if (recoveryErrors.length && error && typeof error === "object") {
        error.recoveryError = new AggregateError(recoveryErrors, "恢复更新前运行状态失败");
      }
      throw error;
    }
  }

  _shutdown(params) {
    const activity = this._getActivity();
    if (activity.blockers.length && params.force !== true) {
      fail(ERROR_CODES.RESOURCE_BUSY, "仍有 Chrome 窗口或关键任务正在运行，不能退出全部", {
        retryable: true,
        details: { blockers: activity.blockers },
      });
    }
    this.draining = true;
    this.events.publish("agent.draining", { reason: params.reason ?? "shutdown" });
    setTimeout(() => {
      Promise.resolve(this.runtime.lifecycle?.shutdown?.({ reason: params.reason ?? "shutdown" }))
        .catch((error) => this.runtime.reportBackgroundError?.(error));
    }, 25).unref?.();
    return { accepted: true };
  }

  _accountsList() {
    const context = accountViewContext(this.runtime);
    return this.runtime.store.getAccounts()
      .map((account) => publicAccount(account, this.runtime, context));
  }

  async _validatedGroup(groupId) {
    if (!groupId) return null;
    const group = this.runtime.store.getGroup(groupId);
    if (!group) fail(ERROR_CODES.VALIDATION_FAILED, "分组不存在，请重新选择");
    if (!group.proxyId) return group;
    const node = this.runtime.proxies.getNodes().find((item) => item.id === group.proxyId);
    if (!node || node.missing || !node.enabled) {
      fail(ERROR_CODES.PROXY_UNAVAILABLE, "分组绑定的代理节点不存在、失效或已停用");
    }
    return group;
  }

  async _accountsCreate(params) {
    const patch = validateAccountPatch(params, {});
    const groupId = patch.groupId || null;
    const selected = await this._validatedGroup(groupId);
    const selectedProxyId = selected?.proxyId ?? null;
    if (selectedProxyId) {
      let ready;
      try {
        ready = await this.runtime.proxies.ensureRunning();
      } catch (error) {
        throw new ApplicationError(ERROR_CODES.PROXY_UNAVAILABLE, `分组代理无法启动：${error.message || error}`, {
          cause: error,
        });
      }
      if (!ready?.running) fail(ERROR_CODES.PROXY_UNAVAILABLE, "分组代理未能启动");
      const latest = await this._validatedGroup(groupId);
      if (latest.proxyId !== selectedProxyId) {
        fail(ERROR_CODES.PROXY_UNAVAILABLE, "分组代理在创建过程中发生变化，请重试");
      }
    }
    const account = await this.runtime.store.addAccount({ ...patch, groupId });
    const result = publicAccount(account, this.runtime);
    this.events.publish("account.changed", result);
    return result;
  }

  async _accountsUpdate(params) {
    const id = requireId(params);
    const current = this.runtime.store.getAccount(id);
    if (!current) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    const patch = validateAccountPatch(params.patch ?? params, current);
    delete patch.id;
    if (Object.hasOwn(patch, "groupId")) await this._validatedGroup(patch.groupId);
    const updated = this.runtime.store.updateAccount(id, patch);
    const result = publicAccount(updated, this.runtime);
    this.events.publish("account.changed", result);
    return result;
  }

  _accountsRemove(params) {
    const id = requireId(params);
    const account = this.runtime.store.getAccount(id);
    if (!account) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    if (this.runtime.isBusy(id) || this.runtime.isHeld(id)) {
      fail(ERROR_CODES.RESOURCE_BUSY, "账号正在使用中，请先关闭窗口或等待任务结束", { retryable: true });
    }
    const profileAction = String(params.profileAction ?? params.profile ?? "detach");
    assertInput(["detach", "archive", "purge"].includes(profileAction), "profileAction 必须是 detach、archive 或 purge");
    const profile = this.runtime.profileManager.removeAccountWithProfile(
      account,
      profileAction,
      () => {
        const removed = this.runtime.store.removeAccount(id);
        if (removed) this.runtime.deleteCachedStatus(id);
        return removed;
      },
      this.runtime.store.getAccounts()
    );
    this.events.publish("account.removed", { id, profile });
    return { ok: true, profile };
  }

  _accountsGetStatus(params) {
    const id = requireId(params);
    const account = this.runtime.store.getAccount(id);
    if (!account) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    return publicStatus(account, this.runtime.getCachedStatus(id));
  }

  _accountsRefreshStatus(params) {
    const id = requireId(params);
    const account = this.runtime.store.getAccount(id);
    if (!account) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    return this.operations.create(
      "account-status-refresh",
      async () => {
        const result = await this.runtime.refreshAccount(account);
        const value = publicStatus(this.runtime.store.getAccount(id) ?? account, result);
        this.events.publish("accountStatus.changed", value);
        return value;
      },
      { resourceId: id }
    );
  }

  _accountsRunNow(params) {
    const id = requireId(params);
    const account = this.runtime.store.getAccount(id);
    if (!account) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    if (this.runtime.isBusy(id) || this.runtime.isHeld(id)) {
      fail(ERROR_CODES.RESOURCE_BUSY, "账号正在执行其他浏览器操作", { retryable: true });
    }
    return this.operations.create(
      "account-run",
      async ({ update }) => {
        update({ stage: "browser", message: "正在启动 Chrome 并检查会话" });
        const result = await this.runtime.runOnce(account, {
          headless: this.runtime.store.getSettings().headless,
        });
        update({ stage: "record", message: "正在写入运行记录" });
        this.runtime.recordConversation(id, result);
        this.events.publish("account.changed", publicAccount(
          this.runtime.store.getAccount(id) ?? account,
          this.runtime
        ));
        if (!result?.ok) {
          const normalized = normalizeApplicationError(
            Object.assign(new Error(result?.reason || "自动对话执行失败"), {
              code: result?.code,
            })
          );
          normalized.details = { ...(normalized.details ?? {}), result };
          throw normalized;
        }
        return result;
      },
      { resourceId: id }
    );
  }

  _historyQuery(params) {
    const accountId = requireId(params, "accountId");
    const entries = this.runtime.readHistory(accountId, safeLimit(params.limit));
    return (Array.isArray(entries) ? entries : []).map(publicHistoryEntry);
  }

  _historyListAccounts() {
    return this.runtime.listHistoryAccounts?.() ?? [];
  }

  _browserStartLogin(params) {
    const accountId = requireId(params, "accountId");
    const account = this.runtime.store.getAccount(accountId);
    if (!account) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    assertInput(params.force === undefined || typeof params.force === "boolean", "force 必须是布尔值");
    return this.operations.create(
      "account-login",
      async ({ update }) => {
        const started = await this.runtime.startLogin(account, { force: params.force === true });
        if (started.status === "failed") throw loginFailure(started);
        let task = this.runtime.getLoginTask(started.taskId) ?? started;
        while (task && !TERMINAL_LOGIN_STATUSES.has(task.status)) {
          update({
            state: task.status === "waiting" ? "waiting_user" : "running",
            stage: task.status,
            message: task.message ?? null,
          });
          await this.runtime.sleep(this.runtime.loginPollMs);
          task = this.runtime.getLoginTask(started.taskId);
        }
        if (!task) fail(ERROR_CODES.NOT_FOUND, "登录任务不存在");
        if (task.status === "success") {
          // 必须发完整的账号视图：直接发 store 里的原始记录会让管理端收到一个
          // 没有状态、出口和轮换字段的账号，界面上刚登录成功的账号反而变空。
          const latest = this.runtime.store.getAccount(accountId);
          if (latest) this.events.publish("account.changed", publicAccount(latest, this.runtime));
          return task;
        }
        if (task.status === "timeout") {
          update({ state: "timed_out", message: task.message ?? "登录超时", result: task });
          return task;
        }
        throw loginFailure(task);
      },
      { resourceId: accountId }
    );
  }

  _browserGetTask(params) {
    const taskId = requireId(params, "taskId");
    const task = this.runtime.getLoginTask(taskId);
    if (!task) fail(ERROR_CODES.NOT_FOUND, "登录任务不存在");
    return task;
  }

  _browserOpenPage(params) {
    const accountId = requireId(params, "accountId");
    const account = this.runtime.store.getAccount(accountId);
    if (!account) fail(ERROR_CODES.NOT_FOUND, "账号不存在");
    return this.operations.create(
      "open-page-start",
      async () => {
        const result = await this.runtime.openPageForAccount(account, params.url);
        if (!result?.ok) {
          if (result?.alreadyOpen) {
            throw new ApplicationError(
              ERROR_CODES.ALREADY_OPEN,
              result?.message || "该账号已有打开的窗口"
            );
          }
          throw normalizeApplicationError(
            Object.assign(new Error(result?.message || "网页打开失败"), {
              code: result?.code,
            })
          );
        }
        // 打开与关闭都由 openPage 的观察者发事件（见 _subscribeRuntime），
        // 这里不再自己轮询 getOpenPages 猜测窗口何时被用户关掉。
        return { accountId, ...result };
      },
      { resourceId: accountId }
    );
  }

  async _browserClosePage(params) {
    const accountId = requireId(params, "accountId");
    const ok = await this.runtime.closePageForAccount(accountId);
    return { ok };
  }

  _browserListOpenPages() {
    return this.runtime.getOpenPages();
  }

  _groupsList() {
    return this.runtime.store.getGroups();
  }

  async _groupsCreate(params) {
    await this._validatedProxyId(params.proxyId);
    const group = this.runtime.store.addGroup(params.name, params.proxyId, {
      timezone: params.timezone,
      locale: params.locale,
    });
    if (group.proxyId) await this.runtime.proxies.reconcile();
    this.events.publish("group.changed", group);
    return group;
  }

  async _groupsUpdate(params) {
    const id = requireId(params);
    const previous = this.runtime.store.getGroup(id);
    if (!previous) fail(ERROR_CODES.NOT_FOUND, "分组不存在");
    const patch = requireObject(params.patch ?? {});
    const allowed = new Set(["name", "proxyId", "timezone", "locale"]);
    const unknown = Object.keys(patch).find((key) => !allowed.has(key));
    assertInput(!unknown, `不允许更新分组字段：${unknown}`);
    if (Object.hasOwn(patch, "proxyId")) await this._validatedProxyId(patch.proxyId);
    const group = this.runtime.store.updateGroup(id, patch);
    if (Object.hasOwn(patch, "proxyId") && previous.proxyId !== group.proxyId) {
      await this.runtime.proxies.reconcile();
    }
    this.events.publish("group.changed", group);
    return group;
  }

  async _validatedProxyId(proxyId) {
    if (!proxyId) return null;
    const node = this.runtime.proxies.getNodes().find((item) => item.id === proxyId);
    if (!node || node.missing || !node.enabled) {
      fail(ERROR_CODES.PROXY_UNAVAILABLE, "代理节点不存在、失效或已停用");
    }
    return node;
  }

  async _groupsRemove(params) {
    const id = requireId(params);
    const previous = this.runtime.store.getGroup(id);
    if (!previous) fail(ERROR_CODES.NOT_FOUND, "分组不存在");
    this.runtime.store.removeGroup(id);
    if (previous.proxyId) await this.runtime.proxies.reconcile();
    this.events.publish("group.changed", { id, removed: true });
    return { ok: true };
  }

  _proxiesGetState() {
    return {
      nodes: this.runtime.proxies.getNodes(),
      status: this.runtime.proxies.status(),
      subscription: this.runtime.proxies.getSubscriptionInfo?.() ?? null,
      runtime: this.runtime.proxies.getMihomoInfo?.() ?? null,
    };
  }

  _proxyOperation(kind, resourceId, action, options = {}) {
    return this.operations.create(
      kind,
      async (controls) => {
        const result = await action(controls);
        this.events.publish("proxyState.changed", this._proxiesGetState());
        return result;
      },
      { resourceId, ...options }
    );
  }

  _proxiesImport(params) {
    assertInput(typeof params.url === "string" && params.url.trim(), "订阅地址不能为空");
    return this._proxyOperation(
      "proxy-import",
      null,
      async ({ update }) => {
        update({ stage: "download", message: "正在下载并解析订阅", progress: 0.1 });
        const result = await this.runtime.proxies.importSubscription(params.url);
        update({ stage: "reconcile", message: "正在应用新的节点列表", progress: 0.8 });
        this.runtime.clearRegionCache();
        return result;
      },
      { stage: "queued", message: "等待导入订阅" }
    );
  }

  _proxiesRefresh() {
    return this._proxyOperation(
      "proxy-refresh",
      null,
      async ({ update }) => {
        update({ stage: "download", message: "正在刷新订阅", progress: 0.1 });
        const result = await this.runtime.proxies.refreshSubscription();
        update({ stage: "reconcile", message: "正在应用新的节点列表", progress: 0.8 });
        this.runtime.clearRegionCache();
        return result;
      },
      { stage: "queued", message: "等待刷新订阅" }
    );
  }

  _proxiesSetDirectory(params) {
    return this._proxyOperation("proxy-runtime-directory", null, () =>
      this.runtime.proxies.setClashVergeDirectory(params.directory ?? params.clashVergeDir)
    );
  }

  _proxiesSetNodeEnabled(params) {
    const id = requireId(params);
    assertInput(typeof params.enabled === "boolean", "enabled 必须是布尔值");
    return this._proxyOperation("proxy-node-toggle", id, async () => {
      const node = await this.runtime.proxies.setNodeEnabled(id, params.enabled);
      if (!node) fail(ERROR_CODES.NOT_FOUND, "代理节点不存在");
      return node;
    });
  }

  _proxiesTestNode(params) {
    const id = requireId(params);
    return this._proxyOperation(
      "proxy-node-test",
      id,
      async () => {
        const result = await this.runtime.proxies.testNode(id);
        this.events.publish("proxyNode.tested", { id, ...result });
        return result;
      },
      { stage: "measure", message: "正在启动独立内核测速" }
    );
  }

  _proxiesTestAll() {
    return this._proxyOperation(
      "proxy-test-all",
      null,
      ({ update }) => this.runtime.proxies.testAllNodes({
        onProgress: ({ done, total, node, result }) => {
          update({
            stage: "measure",
            message: `已测 ${done}/${total} 个节点：${node.name}`,
            progress: total > 0 ? done / total : null,
          });
          this.events.publish("proxyNode.tested", { id: node.id, ...result });
        },
      }),
      { stage: "queued", message: "等待启动独立内核测速" }
    );
  }

  _profileOperation(kind, name, action, options = {}) {
    return this.operations.create(
      kind,
      async (controls) => {
        const result = await action(controls);
        this.events.publish("profile.changed", { kind, name: name ?? null, result });
        return result;
      },
      { resourceId: name ?? null, ...options }
    );
  }

  _profilesScan() {
    return this._profileOperation(
      "profile-scan",
      null,
      ({ update }) => {
        update({ stage: "measure", message: "正在统计 Profile 目录大小", progress: 0.2 });
        return this.runtime.profileManager.scan(this.runtime.store.getAccounts());
      },
      { stage: "queued", message: "等待扫描 Profile" }
    );
  }

  _profilesCleanCache(params) {
    const scope = String(params.scope ?? "all");
    assertInput(["all", "linked", "orphan"].includes(scope), "scope 必须是 all、linked 或 orphan");
    return this._profileOperation(
      "profile-cache-clean",
      params.name,
      ({ update }) => {
        update({
          stage: "clean",
          message: params.name ? `正在清理 ${params.name} 的可重建缓存` : "正在清理可重建缓存",
          progress: 0.2,
        });
        return this.runtime.profileManager.cleanCaches(this.runtime.store.getAccounts(), {
          scope,
          name: params.name ? String(params.name) : null,
        });
      },
      { stage: "queued", message: "等待清理 Profile 缓存" }
    );
  }

  _profilesArchiveOrphan(params) {
    const name = requireId(params, "name");
    return this._profileOperation("profile-orphan-archive", name, () =>
      this.runtime.profileManager.archiveOrphan(name, this.runtime.store.getAccounts())
    );
  }

  _profilesPurgeOrphan(params) {
    const name = requireId(params, "name");
    return this._profileOperation("profile-orphan-purge", name, () =>
      this.runtime.profileManager.purgeOrphan(name, this.runtime.store.getAccounts())
    );
  }

  _conversationsList() {
    return this.runtime.store.getConversations();
  }

  _conversationsUpsert(params) {
    const name = requireId(params, "name");
    const set = requireObject(params.set ?? {});
    const result = this.runtime.store.saveConversationSet(name, set);
    this.events.publish("conversation.changed", { name, set: result });
    return result;
  }

  _conversationsRemove(params) {
    const name = requireId(params, "name");
    if (!this.runtime.store.removeConversationSet(name)) fail(ERROR_CODES.NOT_FOUND, "会话集不存在");
    this.events.publish("conversation.changed", { name, removed: true });
    return { ok: true };
  }

  _schedulerGetState() {
    return publicSchedulerStatus(this.runtime);
  }

  _schedulerStart() {
    const result = this.runtime.scheduler.start();
    const status = publicSchedulerStatus(this.runtime);
    // 支持订阅的调度器已经通过观察者发过 scheduler.changed；只有不支持
    // subscribe 的实现（旧测试替身）才需要在这里补发，否则会重复。
    if (typeof this.runtime.scheduler.subscribe !== "function") {
      this.events.publish("scheduler.changed", status);
    }
    return { ...status, message: result?.message ?? "调度器已启动" };
  }

  async _schedulerStop() {
    const result = await this.runtime.scheduler.stop();
    const status = publicSchedulerStatus(this.runtime);
    if (typeof this.runtime.scheduler.subscribe !== "function") {
      this.events.publish("scheduler.changed", status);
    }
    return { ...status, message: result?.message ?? "调度器已停止" };
  }

  _settingsGet() {
    return this.runtime.store.getSettings();
  }

  _settingsUpdate(params) {
    const patch = params.patch ?? params;
    const validationError = this.runtime.validateSettingsPatch(patch);
    if (validationError) fail(ERROR_CODES.VALIDATION_FAILED, validationError);
    const settings = this.runtime.store.saveSettings(patch);
    this.runtime.restartStatusMonitor();
    this.events.publish("settings.changed", settings);
    return settings;
  }

  _operationsGet(params) {
    const id = requireId(params);
    const operation = this.operations.get(id);
    if (!operation) fail(ERROR_CODES.NOT_FOUND, "操作不存在");
    return operation;
  }

  _operationsListActive() {
    return this.operations.listActive();
  }

  /** 含已结束任务的列表：错误中心要能回看最近的失败，而不只有正在跑的。 */
  _operationsList(params = {}) {
    return this.operations.list({
      limit: safeLimit(params.limit, 200),
      includeTerminal: params.includeTerminal !== false,
    });
  }
}

export function createApplicationServices(options = {}) {
  return new ApplicationServices(options);
}
