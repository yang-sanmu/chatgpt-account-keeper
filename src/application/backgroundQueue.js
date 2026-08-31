import {
  isHeld,
  onRelease,
  release as releaseAccountLock,
  tryAcquire,
} from "../locks.js";
import { CancelledError } from "../cancellation.js";

/**
 * 统一后台队列（计划 §2 / §4）。
 *
 * 只依赖 locks / operations / events，**不得** import scheduler、statusMonitor 或
 * browser：那条链是 services → scheduler → statusMonitor → loginProvider → browser，
 * 队列一旦反向引用就会成环。执行体由组合根注入。
 */

export const WORK_KINDS = Object.freeze({
  accountRun: "account-run",
  statusCheck: "status-check",
  selectorCheck: "selector-check",
});

export const SOURCES = Object.freeze({
  manual: "manual",
  scheduled: "scheduled",
  background: "background",
});

// 去重维度与取消维度必须是两个独立字段。只用一个 kind 会让「被 runNow 提升的
// scheduled 条目」在 scheduler.stop 时被误取消。
const SOURCE_RANK = Object.freeze({ background: 0, scheduled: 1, manual: 2 });

export const STAGES = Object.freeze({
  queued: "queued",
  waitingWorkSlot: "waiting_work_slot",
  waitingAccount: "waiting_account",
  waitingChrome: "waiting_chrome",
  launching: "launching",
  running: "running",
  closing: "closing",
});

function higherSource(a, b) {
  return (SOURCE_RANK[a] ?? 0) >= (SOURCE_RANK[b] ?? 0) ? a : b;
}

function dedupeKey(accountId, workKind, dedupeParams) {
  const params = dedupeParams && Object.keys(dedupeParams).length
    ? JSON.stringify(Object.entries(dedupeParams).sort())
    : "";
  return `${accountId}\0${workKind}\0${params}`;
}

export class BackgroundQueue {
  constructor(options = {}) {
    this._operations = options.operations;
    this._events = options.events ?? null;
    this._slots = options.slots;
    this._log = options.log ?? console;
    this._now = options.now ?? (() => Date.now());
    if (!this._operations) throw new TypeError("operations registry is required");
    if (!this._slots) throw new TypeError("slot manager is required");

    // workKind -> async ({ entry, signal, accountLockHandle, workSlot }) => result
    this._handlers = new Map();
    this._entries = new Map(); // operationId -> entry
    this._byKey = new Map(); // dedupeKey -> entry
    this._pendingQueue = [];
    this._seq = 0;
    this._configEpoch = 0;
    this._schedulerEpoch = 0;
    this._accountWaiters = new Map(); // accountId -> unsubscribe
    this._draining = false;
    this._revalidate = options.revalidate ?? (() => ({ ok: true }));
    this._schedulerRunning = options.schedulerRunning ?? (() => true);
    this._onSettled = null;
  }

  /**
   * 终态回调。调度状态（lastAt / lastResult）只能在这里落盘：ScheduleClock 只管
   * 「什么时候入队」，跑完是什么结果只有队列知道。
   */
  onSettled(callback) {
    this._onSettled = callback;
    return this;
  }

  /** 终态通知不得影响 Operation 的终态本身。 */
  _notifySettled(entry, outcome) {
    if (!this._onSettled) return;
    try {
      this._onSettled(entry, outcome);
    } catch (error) {
      try {
        this._log.warn?.(
          `任务终态回调失败：${String(error?.message || error)}`
        );
      } catch {
        // 日志失败不能让终态处理再抛
      }
    }
  }

  registerHandler(workKind, handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this._handlers.set(workKind, handler);
    return this;
  }

  configureRevalidate(revalidate) {
    this._revalidate = revalidate;
    return this;
  }

  configureSchedulerRunning(fn) {
    this._schedulerRunning = fn;
    return this;
  }

  get configEpoch() {
    return this._configEpoch;
  }

  get schedulerEpoch() {
    return this._schedulerEpoch;
  }

  /** 计数器变化只触发复验，本身不取消任何东西。 */
  bumpConfigEpoch() {
    this._configEpoch++;
    this._revalidateQueued();
    return this._configEpoch;
  }

  bumpSchedulerEpoch() {
    this._schedulerEpoch++;
    this._revalidateQueued();
    return this._schedulerEpoch;
  }

  stopAdmission() {
    this._draining = true;
  }

  isQueued(accountId) {
    for (const entry of this._entries.values()) {
      if (entry.accountId === accountId && entry.stage !== STAGES.running) return true;
    }
    return false;
  }

  /**
   * 入队。同 key 命中即复用并原子提升 effectiveSource，返回**现有** Operation 的 id；
   * 不同 workKind 一律新建条目，不合并、不存在提升。
   */
  submit(request) {
    const {
      accountId,
      workKind,
      dedupeParams = {},
      source,
      kind,
      blocksUpdate = false,
      message = null,
      metadata = {},
    } = request;
    if (!accountId) throw new TypeError("accountId is required");
    if (!this._handlers.has(workKind)) throw new TypeError(`no handler for workKind ${workKind}`);

    const key = dedupeKey(accountId, workKind, dedupeParams);
    const existing = this._byKey.get(key);
    if (existing && !existing.terminal) {
      this._promote(existing, source);
      return this._operations.get(existing.operationId);
    }

    const operation = this._operations.declare(kind ?? workKind, {
      resourceId: accountId,
      stage: STAGES.queued,
      message,
      // 排队条目不持有任何资源，不能成为更新阻塞项：否则 50–100 个排队条目会让
      // prepareUpdate 永久 ready:false，Desktop 的安全空闲安装永不触发。
      blocksUpdate,
    });

    const entry = {
      operationId: operation.id,
      accountId,
      workKind,
      dedupeParams,
      dedupeKey: key,
      effectiveSource: source,
      priority: SOURCE_RANK[source] ?? 0,
      seq: ++this._seq,
      stage: STAGES.queued,
      terminal: false,
      metadata,
      abort: new AbortController(),
      workSlot: null,
      accountLockHandle: null,
      browserRunId: null,
      snapshot: {
        schedulerEpoch: this._schedulerEpoch,
        configEpochAtEnqueue: this._configEpoch,
      },
    };
    this._entries.set(entry.operationId, entry);
    this._byKey.set(key, entry);
    this._pendingQueue.push(entry);
    this._emitQueue();
    this._pump();
    return this._operations.get(entry.operationId);
  }

  /**
   * 原子提升：同一次操作内同步队列条目、Operation 与已创建的 BrowserRun。
   * 漏掉第三处会让正在跑的 scheduled-run 在队列里变成 manual 而 UI 仍显示 scheduled。
   */
  _promote(entry, source) {
    const next = higherSource(entry.effectiveSource, source);
    if (next === entry.effectiveSource) return false;
    // 已进入 closing 后冻结意图：close_failed 的记录必须保留事故当时的真实来源。
    if (entry.stage === STAGES.closing || entry.terminal) return false;
    entry.effectiveSource = next;
    entry.priority = SOURCE_RANK[next] ?? entry.priority;
    const holdsResources =
      entry.stage === STAGES.waitingChrome
      || entry.stage === STAGES.launching
      || entry.stage === STAGES.running;
    if (!holdsResources) {
      // 重排：分配新的单调 seq 进入新优先级带队尾。沿用旧 seq 会让被提升的条目
      // 插到更早的手动请求之前。
      entry.seq = ++this._seq;
    }
    this._operations.update(entry.operationId, {
      effectiveSource: next,
    });
    this._onPromoted?.(entry);
    this._emitQueue();
    return true;
  }

  onPromoted(callback) {
    this._onPromoted = callback;
    return this;
  }

  /** 逐条按任务语义复验（§7.2）。计数器只是触发器。 */
  _revalidateQueued() {
    for (const entry of [...this._pendingQueue]) {
      const verdict = this._checkEntry(entry);
      if (!verdict.ok) {
        this._cancelEntry(entry, verdict.reason, { settlesRun: verdict.settlesRun === true });
      }
    }
  }

  _checkEntry(entry) {
    const verdict = this._revalidate({
      accountId: entry.accountId,
      workKind: entry.workKind,
      effectiveSource: entry.effectiveSource,
    });
    if (!verdict.ok) return verdict;
    // 仅 effectiveSource === 'scheduled' 的条目受调度状态约束。被提升为 manual 的
    // 条目不因 scheduler.stop 取消，即使它最初是自动入队的。
    if (entry.effectiveSource === SOURCES.scheduled) {
      if (entry.snapshot.schedulerEpoch !== this._schedulerEpoch || !this._schedulerRunning()) {
        // 生命周期事件，不带 settlesRun：不能写成一条自动运行失败。
        return { ok: false, reason: "调度已停止" };
      }
    }
    return { ok: true };
  }

  /**
   * 排队期取消。
   *
   * settlesRun 区分两类取消：语义健康校验失败（代理节点缺失、账号被隔离）是这一轮
   * 自动运行的真实结果，要落进调度状态；而 scheduler.stop、账号停用/删除、Agent
   * 退出属于生命周期，不得污染「上次运行」。默认 false——生命周期路径全部走默认值。
   */
  _cancelEntry(entry, reason, { settlesRun = false } = {}) {
    if (entry.terminal) return;
    entry.terminal = true;
    this._removeEntry(entry);
    // 尚未创建 BrowserRun 的条目可以直接落终态，无需等待任何关闭。
    this._operations.update(entry.operationId, {
      state: "cancelled",
      stage: null,
      message: reason,
      blocksUpdate: false,
    });
    this._emitQueue();
    // terminal 已置位，_execute 不会再对同一条目结算第二次。
    this._notifySettled(entry, {
      state: "cancelled",
      ok: false,
      reason,
      settlesRun,
    });
  }

  cancelQueuedBySource(sources, reason) {
    const targets = this._pendingQueue.filter((entry) => sources.includes(entry.effectiveSource));
    for (const entry of targets) this._cancelEntry(entry, reason);
    return targets.length;
  }

  cancelAllQueued(reason) {
    const targets = [...this._pendingQueue];
    for (const entry of targets) this._cancelEntry(entry, reason);
    return targets.length;
  }

  cancelForAccount(accountId, reason) {
    let count = 0;
    for (const entry of [...this._entries.values()]) {
      if (entry.accountId !== accountId) continue;
      if (this._pendingQueue.includes(entry)) {
        this._cancelEntry(entry, reason);
      } else {
        entry.abort.abort(reason);
      }
      count++;
    }
    return count;
  }

  signalAllActive(reason) {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (this._pendingQueue.includes(entry)) continue;
      entry.abort.abort(reason);
      count++;
    }
    return count;
  }

  _removeEntry(entry) {
    this._entries.delete(entry.operationId);
    if (this._byKey.get(entry.dedupeKey) === entry) this._byKey.delete(entry.dedupeKey);
    const index = this._pendingQueue.indexOf(entry);
    if (index >= 0) this._pendingQueue.splice(index, 1);
  }

  _sortPending() {
    // 固定优先级，同级 FIFO；不因每次轮询重新插队。
    this._pendingQueue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
  }

  _pump() {
    if (this._draining) return;
    this._sortPending();
    for (const entry of [...this._pendingQueue]) {
      if (!this._slots.workSlotsAvailable) return;
      if (entry.stage === STAGES.waitingAccount && entry._awaitingRelease) continue;
      const verdict = this._checkEntry(entry);
      if (!verdict.ok) {
        this._cancelEntry(entry, verdict.reason, { settlesRun: verdict.settlesRun === true });
        continue;
      }
      const workSlot = this._slots.tryAcquireWorkSlot();
      if (!workSlot) return;
      // 取得工作槽即成为更新阻塞项。
      this._operations.update(entry.operationId, {
        stage: STAGES.waitingAccount,
        blocksUpdate: true,
      });
      entry.stage = STAGES.waitingAccount;

      const accountLockHandle = tryAcquire(entry.accountId, { owner: "queue" });
      if (!accountLockHandle) {
        // try-lock 失败：立刻把工作槽还回去，并回落 blocksUpdate。只做单向翻转会让
        // 长期开窗账号的条目每次退回都留下一个不持任何资源的假 blocker。
        workSlot.release();
        this._operations.update(entry.operationId, {
          stage: STAGES.waitingAccount,
          blocksUpdate: false,
          message: "等待账号锁释放",
        });
        this._waitForAccount(entry);
        continue;
      }
      entry.workSlot = workSlot;
      entry.accountLockHandle = accountLockHandle;
      this._removeEntry(entry);
      // 条目仍需可查（去重/取消），只是不再排队。
      this._entries.set(entry.operationId, entry);
      this._byKey.set(entry.dedupeKey, entry);
      void this._execute(entry);
    }
  }

  _waitForAccount(entry) {
    if (entry._awaitingRelease) return;
    entry._awaitingRelease = true;
    // 事件驱动，不轮询、不自旋。onRelease 必须无条件触发，否则会漏掉
    // 被 withAccountLock（登录 / 打开网页 / Profile 维护）释放的那一次唤醒。
    const unsubscribe = onRelease(entry.accountId, () => {
      entry._awaitingRelease = false;
      this._pump();
    });
    this._accountWaiters.set(entry.operationId, unsubscribe);
  }

  async _execute(entry) {
    const handler = this._handlers.get(entry.workKind);
    const unsubscribe = this._accountWaiters.get(entry.operationId);
    if (unsubscribe) {
      unsubscribe();
      this._accountWaiters.delete(entry.operationId);
    }
    this._operations.update(entry.operationId, {
      state: "running",
      stage: STAGES.waitingChrome,
      blocksUpdate: true,
    });
    entry.stage = STAGES.waitingChrome;
    this._emitQueue();

    let result = null;
    let failure = null;
    try {
      result = await handler({
        entry,
        accountId: entry.accountId,
        signal: entry.abort.signal,
        effectiveSource: entry.effectiveSource,
        dedupeParams: entry.dedupeParams,
        metadata: entry.metadata,
        accountLockHandle: entry.accountLockHandle,
        setStage: (stage, message) => {
          entry.stage = stage;
          this._operations.update(entry.operationId, { stage, ...(message ? { message } : {}) });
          this._emitQueue();
        },
        attachBrowserRun: (browserRunId) => {
          entry.browserRunId = browserRunId;
        },
        // §5.5：已创建 BrowserRun 的终态必须带 close.ok。失败与取消路径拿不到 handler
        // 的返回值，所以关闭结论要单独记在条目上。
        attachClose: (close) => {
          entry.closeOutcome = close;
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      entry.terminal = true;
      // 账号锁与工作槽的释放：若 handler 把它们交给了 BrowserRun（正常路径），
      // 由 BrowserRun 的 closed / close_failed 分支释放；否则在这里兜底。
      if (!entry.browserRunId) {
        if (entry.accountLockHandle) {
          releaseAccountLock(entry.accountLockHandle);
          entry.accountLockHandle = null;
        }
        entry.workSlot?.release?.();
        entry.workSlot = null;
      }
      this._removeEntry(entry);
      this._emitQueue();
      this._pump();
    }

    // 失败与取消同样要带 close：`cancelled` 且 close.ok === false 必须能被读成
    // 「任务已取消，但 Chrome 未能回收」，不得解释为资源已释放。
    const closeResult = entry.closeOutcome
      ? { close: entry.closeOutcome }
      : null;
    if (failure) {
      const cancelled = failure instanceof CancelledError || failure?.code === "CANCELLED";
      const details = failure?.details ?? null;
      this._operations.update(entry.operationId, {
        state: cancelled ? "cancelled" : "failed",
        stage: null,
        message: String(failure?.message || failure),
        blocksUpdate: false,
        ...(details || closeResult
          ? { result: { ...(details?.result ? { ...details.result } : {}), ...closeResult } }
          : {}),
      });
      this._notifySettled(entry, {
        state: cancelled ? "cancelled" : "failed",
        ok: false,
        reason: String(failure?.message || failure),
        // 真跑过才算结果。取消来自 abort（stop / 停用 / Agent 退出）：那是生命周期，
        // 不写 lastResult。
        settlesRun: !cancelled,
      });
      return;
    }
    const closeFailed = entry.closeOutcome?.ok === false;
    const completionMessage = entry.stage === STAGES.closing ? "任务已完成" : null;
    this._operations.update(entry.operationId, {
      // 业务成功不等于资源已释放；完整 Chrome 树无法确认回收时必须降级。
      state: closeFailed ? "failed" : "succeeded",
      stage: null,
      ...(closeFailed
        ? { message: `Chrome 未能确认回收：${entry.closeOutcome.reason ?? "unknown"}` }
        : completionMessage ? { message: completionMessage } : {}),
      progress: 1,
      result: result ?? closeResult ?? null,
      blocksUpdate: false,
    });
    this._notifySettled(entry, {
      state: closeFailed ? "failed" : "succeeded",
      ok: !closeFailed,
      reason: closeFailed ? entry.closeOutcome?.reason ?? null : null,
      settlesRun: true,
    });
  }

  snapshot() {
    const stages = {};
    for (const entry of this._entries.values()) {
      stages[entry.stage] = (stages[entry.stage] ?? 0) + 1;
    }
    const bySource = {};
    const byKind = {};
    for (const entry of this._entries.values()) {
      bySource[entry.effectiveSource] = (bySource[entry.effectiveSource] ?? 0) + 1;
      byKind[entry.workKind] = (byKind[entry.workKind] ?? 0) + 1;
    }
    const slots = this._slots.snapshot();
    return {
      queuedTotal: this._pendingQueue.length,
      waiting: {
        queued: stages[STAGES.queued] ?? 0,
        workSlot: stages[STAGES.waitingWorkSlot] ?? 0,
        account: stages[STAGES.waitingAccount] ?? 0,
        chrome: stages[STAGES.waitingChrome] ?? 0,
      },
      running: (stages[STAGES.launching] ?? 0) + (stages[STAGES.running] ?? 0),
      closing: stages[STAGES.closing] ?? 0,
      workSlots: slots.workSlots,
      chromeSlots: slots.chromeSlots,
      bySource,
      byWorkKind: byKind,
      admissionPaused: slots.admissionPaused,
    };
  }

  _emitQueue() {
    this._events?.publish("queue.changed", this.snapshot());
  }

  /** 仅供测试与退出流程：当前活动（已准入）条目数。 */
  activeCount() {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (!this._pendingQueue.includes(entry)) count++;
    }
    return count;
  }
}
