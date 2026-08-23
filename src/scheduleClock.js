/**
 * 单一 next-due 定时器 + 有序到期表（计划 §2）。
 *
 * 替换原来的「每账号一条独立循环」：100 个启用账号会产生 100 条并发循环，每条以
 * 3 秒粒度分段睡眠，管理循环每 15 秒再全量扫一遍——约每秒 33 次定时器唤醒，这本身
 * 就是「账号增多后卡顿」的一部分。
 *
 * 执行完全交给统一队列：本模块只负责「什么时候该把哪个账号入队」。
 */

export class ScheduleClock {
  constructor(options = {}) {
    this._now = options.now ?? (() => Date.now());
    this._setTimeout = options.setTimeout ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
    this._clearTimeout = options.clearTimeout ?? clearTimeout;
    this._onDue = options.onDue ?? (() => {});
    this._log = options.log ?? console;
    this._due = new Map(); // accountId -> dueAt (ms)
    this._timer = null;
    this._timerFiresAt = null;
    this._running = false;
  }

  get running() {
    return this._running;
  }

  start() {
    this._running = true;
    this._reschedule();
  }

  stop() {
    this._running = false;
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
      this._timerFiresAt = null;
    }
  }

  /** 设置某账号的下次到期时间。 */
  schedule(accountId, dueAt) {
    this._due.set(accountId, dueAt);
    this._reschedule();
  }

  unschedule(accountId) {
    if (this._due.delete(accountId)) this._reschedule();
  }

  /** 只保留给定账号集合，返回被移除的账号。 */
  retainOnly(accountIds) {
    const keep = new Set(accountIds);
    const removed = [];
    for (const accountId of [...this._due.keys()]) {
      if (!keep.has(accountId)) {
        this._due.delete(accountId);
        removed.push(accountId);
      }
    }
    if (removed.length) this._reschedule();
    return removed;
  }

  dueAt(accountId) {
    return this._due.get(accountId) ?? null;
  }

  snapshot() {
    return Object.fromEntries(this._due);
  }

  /** 按到期时间从早到晚返回。逾期恢复据此按原始 nextAt 顺序入队。 */
  orderedDue() {
    return [...this._due.entries()].sort((a, b) => a[1] - b[1]);
  }

  _reschedule() {
    if (!this._running) return;
    const next = this.orderedDue()[0];
    if (!next) {
      if (this._timer !== null) {
        this._clearTimeout(this._timer);
        this._timer = null;
        this._timerFiresAt = null;
      }
      return;
    }
    const firesAt = next[1];
    // 已有定时器且不晚于新的最早到期时间：无需重排，避免频繁重建定时器。
    if (this._timer !== null && this._timerFiresAt !== null && this._timerFiresAt <= firesAt) {
      return;
    }
    if (this._timer !== null) this._clearTimeout(this._timer);
    const delay = Math.max(0, firesAt - this._now());
    this._timerFiresAt = firesAt;
    this._timer = this._setTimeout(() => {
      this._timer = null;
      this._timerFiresAt = null;
      this._fire();
    }, delay);
  }

  _fire() {
    if (!this._running) return;
    const now = this._now();
    // 同一时刻到期的账号按 FIFO（到期时间升序）交给队列，由并发上限、Chrome 上限
    // 与 1 秒启动间隔自然消化积压，而不是集中塞进一个 5 分钟窗口。
    const due = this.orderedDue().filter(([, dueAt]) => dueAt <= now);
    for (const [accountId] of due) {
      this._due.delete(accountId);
      try {
        this._onDue(accountId);
      } catch (error) {
        try {
          this._log.warn?.(`账号 ${accountId} 到期处理失败：${String(error?.message || error)}`);
        } catch {
          // 日志失败不影响其余账号
        }
      }
    }
    this._reschedule();
  }
}

/**
 * 逾期恢复：按持久化的原始 nextAt 从早到晚恢复，每账号最多一个补跑任务，
 * 不连续追赶多个历史周期。
 */
export function planOverdueRecovery(persistedAccounts, now) {
  const entries = Object.entries(persistedAccounts ?? {})
    .map(([accountId, state]) => {
      const parsed = state?.nextAt ? Date.parse(state.nextAt) : NaN;
      return { accountId, nextAt: Number.isFinite(parsed) ? parsed : null };
    })
    .filter((entry) => entry.nextAt !== null);
  const overdue = entries
    .filter((entry) => entry.nextAt <= now)
    .sort((a, b) => a.nextAt - b.nextAt);
  const future = entries.filter((entry) => entry.nextAt > now);
  return { overdue, future };
}
