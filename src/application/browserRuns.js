import { randomUUID } from "node:crypto";
import {
  quarantineAccount,
  release as releaseAccountLock,
  releaseQuarantine,
} from "../locks.js";
import { Budget } from "../cancellation.js";
import * as defaultLog from "../logger.js";

/**
 * BrowserRun 注册表（计划 §10 / §11）。
 *
 * 关键不变量：Chrome 容量只在**完整 owned 进程树**被证明消失后释放。Windows 上的
 * 证明是 broker 的 Job 计数归零 + dispose ack；root 退出本身不算——孤立的
 * renderer / GPU 仍可能存活，此时释放槽位就会让实际 Chrome 超上限、Profile 锁残留。
 */

export const RUN_STATES = Object.freeze({
  waiting: "waiting",
  launching: "launching",
  running: "running",
  closing: "closing",
  closed: "closed",
  closeFailed: "close_failed",
});

const ACTIVE_STATES = new Set([
  RUN_STATES.waiting,
  RUN_STATES.launching,
  RUN_STATES.running,
  RUN_STATES.closing,
  // close_failed 留在 active：它仍占着 Chrome 容量与账号锁。
  RUN_STATES.closeFailed,
]);

export const CLOSE_BUDGET_MS = 5_000;
const GRACEFUL_RESERVE_MS = 1_000;
const GRACEFUL_MAX_MS = 4_000;
const GRACEFUL_TREE_DRAIN_MAX_MS = 1_500;
const RECENT_LIMIT = 50;
const RECENT_TTL_MS = 30 * 60 * 1000;
const RECHECK_BASE_MS = 15_000;
const RECHECK_MAX_MS = 60_000;

/** purpose 按最终有效来源映射，而不是入队时的来源。 */
export function purposeFor(workKind, effectiveSource) {
  if (workKind === "account-run") {
    return effectiveSource === "manual" ? "manual-run" : "scheduled-run";
  }
  if (workKind === "status-check") return "status-check";
  if (workKind === "selector-check") return "selector-check";
  return workKind;
}

export class BrowserRunRegistry {
  constructor(options = {}) {
    this._events = options.events ?? null;
    this._log = options.log ?? defaultLog;
    this._broker = options.broker ?? null;
    this._clock = options.clock ?? (() => new Date());
    this._now = options.now ?? (() => Date.now());
    this._setTimeout = options.setTimeout ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
    this._clearTimeout = options.clearTimeout ?? clearTimeout;
    this._budgetMs = options.closeBudgetMs ?? CLOSE_BUDGET_MS;
    this._active = new Map(); // browserRunId -> run
    this._recent = [];
    this._recheckTimers = new Map();
    this._recheckDelays = new Map();
    this._onQuarantineChanged = options.onQuarantineChanged ?? null;
  }

  configureBroker(broker) {
    this._broker = broker;
    return this;
  }

  register(input) {
    const now = this._clock().toISOString();
    const run = {
      browserRunId: input.browserRunId ?? randomUUID(),
      accountId: input.accountId,
      operationId: input.operationId ?? null,
      purpose: input.purpose,
      effectiveSource: input.effectiveSource ?? null,
      workKind: input.workKind ?? null,
      profilePath: input.profilePath ?? null,
      rootPid: null,
      rootStartTime: null,
      debugEndpointFingerprint: null,
      launcherRunToken: input.launcherRunToken ?? null,
      brokerGenerationId: input.brokerGenerationId ?? null,
      startedAt: now,
      state: RUN_STATES.waiting,
      closeReason: null,
      closeError: null,
      // 资源句柄不进公开视图。
      _accountLockHandle: input.accountLockHandle ?? null,
      _chromeSlot: input.chromeSlot ?? null,
      _workSlot: input.workSlot ?? null,
      _closing: null,
      _pendingForget: false,
      _headless: input.headless !== false,
    };
    this._active.set(run.browserRunId, run);
    this._emit(run);
    return run;
  }

  get(browserRunId) {
    return this._active.get(browserRunId) ?? null;
  }

  attachLaunch(browserRunId, details) {
    const run = this._active.get(browserRunId);
    if (!run) return null;
    run.rootPid = details.rootPid ?? run.rootPid;
    run.rootStartTime = details.rootStartTime ?? run.rootStartTime;
    run.launcherRunToken = details.launcherRunToken ?? run.launcherRunToken;
    run.brokerGenerationId = details.brokerGenerationId ?? run.brokerGenerationId;
    run.debugEndpointFingerprint =
      details.debugEndpointFingerprint ?? run.debugEndpointFingerprint;
    run.state = details.state ?? RUN_STATES.launching;
    this._emit(run);
    return run;
  }

  /**
   * 撤回预登记的 token。仅用于「broker 明确未创建任何东西」的同步负响应：那种失败在
   * 返回前已 Dispose 掉 Job，留着 token 只会让关闭序列去 terminate 一个不存在的
   * token 并把结果误判成未能回收。结果不确定的失败绝不能走这里。
   */
  forgetLauncherToken(browserRunId) {
    const run = this._active.get(browserRunId);
    if (!run || run.rootPid) return false;
    run.launcherRunToken = null;
    return true;
  }

  markRunning(browserRunId, context = null) {
    const run = this._active.get(browserRunId);
    if (!run) return null;
    run.state = RUN_STATES.running;
    run._context = context;
    this._emit(run);
    return run;
  }

  /** 更新意图（§4.4.1）。closing 起冻结（§4.4.2）。 */
  updateEffectiveSource(browserRunId, effectiveSource) {
    const run = this._active.get(browserRunId);
    if (!run) return false;
    if (run.state === RUN_STATES.closing
      || run.state === RUN_STATES.closed
      || run.state === RUN_STATES.closeFailed) {
      return false;
    }
    if (run.effectiveSource === effectiveSource) return false;
    run.effectiveSource = effectiveSource;
    run.purpose = purposeFor(run.workKind ?? run.purpose, effectiveSource);
    this._emit(run);
    return true;
  }

  listActive() {
    return [...this._active.values()].map((run) => publicRun(run));
  }

  listRecent() {
    this._pruneRecent();
    return this._recent.map((run) => ({ ...run }));
  }

  /** Chrome 容量占用数 = 活动 run（含 close_failed）。 */
  get chromeOccupancy() {
    return this._active.size;
  }

  countByPurpose() {
    const counts = {};
    for (const run of this._active.values()) {
      counts[run.purpose] = (counts[run.purpose] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * 关闭单个 BrowserRun。幂等：重复请求复用同一个关闭 Promise。
   *
   * 顺序不可交换（计划 §11.2）：控制连接一旦拆除就无法再经 CDP 请求优雅退出，而
   * Windows 上的 child.kill() 是 TerminateProcess、不是优雅退出，用它冒充正常退出
   * 会跳过 Profile 落盘与 exit_type=Normal，反而触发要抑制的会话恢复气泡。
   */
  close(browserRunId, reason = "requested") {
    const run = this._active.get(browserRunId);
    if (!run) return Promise.resolve(null);
    if (run._closing) return run._closing;
    run._closing = this._runCloseSequence(run, reason);
    return run._closing;
  }

  async _runCloseSequence(run, reason) {
    const budget = new Budget(this._budgetMs, this._now);
    run.state = RUN_STATES.closing;
    run.closeReason = reason;
    this._emit(run);

    let closeError = null;
    const hadContext = !!run._context;

    // 子预算 A：优雅退出 + 断开控制连接，必须为 B 留最后 1 秒。
    const gracefulMs = Math.min(GRACEFUL_MAX_MS, budget.sliceLeaving(GRACEFUL_RESERVE_MS));
    if (gracefulMs > 0 && run._context) {
      const graceful = Promise.resolve()
        .then(() => run._context.close())
        .then(
          () => null,
          (error) => error
        );
      const result = await budget.race(graceful, gracefulMs, new Error("优雅关闭超时"));
      if (result) closeError = result;
    }

    // 子预算 B：先允许 Browser.close 后的进程树自然归零；只有仍存活才 terminate，
    // 最后必须取得计数归零 + dispose ack。直接 terminate 会截断 Cookie/Profile 落盘。
    const proof = await this._proveTreeGone(run, budget, hadContext);

    run.closeError = closeError ? String(closeError.message || closeError) : null;
    if (proof.ok) {
      this._finishClosed(run, proof);
      return publicRun(run);
    }
    this._finishCloseFailed(run, proof);
    return publicRun(run);
  }

  /**
   * 证明完整 owned 树消失。Windows：Job 计数归零 + dispose ack + registry entry 删除。
   * 禁止用「进程最终消失」倒推——Chrome 自己的内部 Job 会掩盖我们的失败。
   */
  async _proveTreeGone(run, budget, allowGracefulDrain = false) {
    if (!run.launcherRunToken || !this._broker) {
      // 没有 broker 的路径（POSIX 开发、或从未成功 launch）：无法给出 Windows 级证明。
      // 从未取得 root 的 run 没有任何进程可残留，按 closed 处理。
      if (!run.rootPid) return { ok: true, reason: "never-launched", count: 0 };
      return { ok: false, reason: "no-broker-proof", count: null };
    }
    const token = run.launcherRunToken;
    try {
      let drained = null;
      if (allowGracefulDrain) {
        const gracefulDrainMs = Math.min(
          GRACEFUL_TREE_DRAIN_MAX_MS,
          budget.sliceLeaving(GRACEFUL_RESERVE_MS)
        );
        if (gracefulDrainMs > 0) {
          drained = await this._broker.waitForEmpty(token, gracefulDrainMs);
        }
      }

      if (!drained?.disposed && (!drained?.ok || drained.count !== 0)) {
        await this._broker.terminate(token);
        drained = await this._broker.waitForEmpty(token, Math.max(0, budget.remaining));
      }
      if (drained.disposed) {
        // 命中 tombstone：此前 dispose 已成功但 ack 丢失，直接作为收敛证明。
        run._pendingForget = true;
        return { ok: true, reason: "tombstone", count: 0 };
      }
      if (!drained.ok || drained.count !== 0) {
        return { ok: false, reason: "job-not-empty", count: drained.count };
      }
      const disposed = await this._broker.dispose_(token);
      if (!disposed.ok) {
        return { ok: false, reason: `dispose-failed:${disposed.code ?? "unknown"}`, count: 0 };
      }
      run._pendingForget = true;
      return { ok: true, reason: "disposed", count: 0 };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error), count: null };
    }
  }

  _finishClosed(run, proof) {
    run.state = RUN_STATES.closed;
    run.closeReason = run.closeReason ?? proof.reason;
    // 释放顺序与全序相反：Chrome 槽 → 账号锁 → 工作槽。
    run._chromeSlot?.release?.();
    run._chromeSlot = null;
    if (run._accountLockHandle) {
      releaseAccountLock(run._accountLockHandle);
      run._accountLockHandle = null;
    }
    run._workSlot?.release?.();
    run._workSlot = null;
    run._context = null;
    this._active.delete(run.browserRunId);
    this._recent.unshift(publicRun(run));
    this._pruneRecent();
    this._emit(run);
    this._schedulePendingForget(run);
  }

  _finishCloseFailed(run, proof) {
    run.state = RUN_STATES.closeFailed;
    run.closeReason = `${run.closeReason ?? "close"}:${proof.reason}`;
    // 释放工作槽（否则队列吞吐被僵尸吃掉），但 Chrome 容量与账号锁都不释放。
    run._workSlot?.release?.();
    run._workSlot = null;
    // 账号锁所有权转入 quarantine：只设标志而放掉锁会让 Profile 维护去动一个仍被
    // 僵尸 Chrome 持有文件锁的 Profile。
    quarantineAccount(run.accountId, "chromeReclaimFailed");
    if (run._accountLockHandle) {
      run._accountLockHandle.released = true;
      run._accountLockHandle = null;
    }
    run._context = null;
    this._log.error(
      `账号 ${run.accountId} 的 Chrome 未能确认回收（${proof.reason}）：Chrome 容量与账号锁保持占用，已进入隔离并开始复验`
    );
    this._emit(run);
    this._onQuarantineChanged?.();
    this._scheduleRecheck(run.browserRunId);
  }

  _schedulePendingForget(run) {
    if (!run._pendingForget || !run.launcherRunToken || !this._broker) return;
    const token = run.launcherRunToken;
    // forget 只清 broker 的 tombstone 记账，不持有 OS 资源，也不是 closed 前置。
    // 失败只重试，绝不反向把已证明 closed 的 run 改成 close_failed。
    Promise.resolve()
      .then(() => this._broker.forget(token))
      .then((response) => {
        if (!response?.ok) {
          this._log.warn(`broker forget(${token}) 未确认：${response?.code ?? "unknown"}，将由后续重试清理`);
        }
      })
      .catch((error) => {
        this._log.warn(`broker forget(${token}) 失败：${String(error?.message || error)}`);
      });
  }

  /** close_failed 的自愈复验：15 秒起，指数退避到 60 秒。 */
  _scheduleRecheck(browserRunId) {
    if (this._recheckTimers.has(browserRunId)) return;
    const delay = this._recheckDelays.get(browserRunId) ?? RECHECK_BASE_MS;
    const timer = this._setTimeout(() => {
      this._recheckTimers.delete(browserRunId);
      this._recheckDelays.set(browserRunId, Math.min(RECHECK_MAX_MS, delay * 2));
      this.recheck(browserRunId).catch((error) => {
        this._log.warn(`BrowserRun ${browserRunId} 复验失败：${String(error?.message || error)}`);
      });
    }, delay);
    this._recheckTimers.set(browserRunId, timer);
  }

  /**
   * 对 close_failed 的 run 重试关闭 / 复验。每轮各自享有一份完整预算。
   * 只有计数为 0 且 dispose ack 成功才算收敛（命中 tombstone 同样算）。
   */
  async recheck(browserRunId) {
    const run = this._active.get(browserRunId);
    if (!run || run.state !== RUN_STATES.closeFailed) return null;
    if (!this._broker || !this._broker.running) {
      // broker 已退出属于 Agent 级 fatal，由 broker 客户端的 onFatal 处理。
      // 这里保持 quarantine，不存在 root-only 退化判据或人工旁路。
      this._log.warn(`BrowserRun ${browserRunId} 复验跳过：broker 不在运行`);
      return null;
    }
    const budget = new Budget(this._budgetMs, this._now);
    const proof = await this._proveTreeGone(run, budget);
    if (!proof.ok) {
      this._scheduleRecheck(browserRunId);
      return publicRun(run);
    }
    run.state = RUN_STATES.closed;
    run.closeReason = `${run.closeReason ?? "close_failed"}->recovered:${proof.reason}`;
    run._chromeSlot?.release?.();
    run._chromeSlot = null;
    releaseQuarantine(run.accountId);
    this._active.delete(run.browserRunId);
    this._recent.unshift(publicRun(run));
    this._pruneRecent();
    this._log.info(`账号 ${run.accountId} 的 Chrome 已确认回收，隔离解除`);
    this._emit(run);
    this._onQuarantineChanged?.();
    this._schedulePendingForget(run);
    return publicRun(run);
  }

  /** 关闭全部活动 run（退出流程第 7 步）。 */
  async closeAll(reason = "shutdown") {
    const ids = [...this._active.keys()];
    const results = await Promise.all(
      ids.map((id) =>
        this.close(id, reason).catch((error) => {
          this._log.warn(`关闭 BrowserRun ${id} 失败：${String(error?.message || error)}`);
          return null;
        })
      )
    );
    return results.filter(Boolean).length;
  }

  /** 仍未回收的 run（退出时判定是否可以关库）。 */
  unresolved() {
    return [...this._active.values()]
      .filter((run) => run.state === RUN_STATES.closeFailed || ACTIVE_STATES.has(run.state))
      .map((run) => publicRun(run));
  }

  cancelAllRechecks() {
    for (const [, timer] of this._recheckTimers) this._clearTimeout(timer);
    this._recheckTimers.clear();
  }

  _pruneRecent() {
    const cutoff = this._now() - RECENT_TTL_MS;
    this._recent = this._recent
      .filter((run) => Date.parse(run.startedAt) >= cutoff || this._recent.indexOf(run) < RECENT_LIMIT)
      .slice(0, RECENT_LIMIT);
  }

  _emit(run) {
    this._events?.publish("browserRun.changed", publicRun(run));
  }
}

export function publicRun(run) {
  return {
    browserRunId: run.browserRunId,
    accountId: run.accountId,
    operationId: run.operationId,
    purpose: run.purpose,
    effectiveSource: run.effectiveSource,
    profilePath: run.profilePath,
    rootPid: run.rootPid,
    rootStartTime: run.rootStartTime,
    debugEndpointFingerprint: run.debugEndpointFingerprint,
    launcherRunToken: run.launcherRunToken,
    brokerGenerationId: run.brokerGenerationId,
    startedAt: run.startedAt,
    state: run.state,
    closeReason: run.closeReason,
    closeError: run.closeError,
  };
}
