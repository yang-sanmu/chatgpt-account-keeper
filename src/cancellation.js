/**
 * 可取消的等待（计划 §8.1）。
 *
 * 取消的硬保证来自关闭 BrowserRun——上下文与进程关闭会让所有在飞的页面调用立刻
 * 失败。AbortSignal 只是让干净路径尽快收敛。可取消路径中禁止直接使用
 * page.waitForTimeout 与裸 setTimeout sleep：前者不接受 signal，一次等待最长可达
 * 180 秒，会让「250 毫秒内进入 closing」变成空话。
 */

export class CancelledError extends Error {
  constructor(message = "操作已取消") {
    super(message);
    this.name = "CancelledError";
    this.code = "CANCELLED";
    this.cancelled = true;
  }
}

export function isCancellation(error) {
  return error?.code === "CANCELLED" || error?.name === "AbortError" || error?.cancelled === true;
}

function reasonOf(signal) {
  const reason = signal?.reason;
  if (typeof reason === "string" && reason) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "操作已取消";
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new CancelledError(reasonOf(signal));
}

/** 可被 signal 立刻打断的 sleep。 */
export function cancellableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new CancelledError(reasonOf(signal)));
  return new Promise((resolve, reject) => {
    let onAbort;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(new CancelledError(reasonOf(signal)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 让一个不可取消的 promise 在 signal 触发时立刻把控制权交回调用方。
 *
 * 注意：底层操作本身仍在跑（Playwright 的等待无法中断），真正让它失败的是随后的
 * BrowserRun 关闭。这里只负责不再阻塞取消路径。
 */
export function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError(reasonOf(signal)));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new CancelledError(reasonOf(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * 有界预算。关闭序列用它保证「从进入 closing 起 5 秒总预算」不被任何子步骤突破。
 */
export class Budget {
  constructor(totalMs, now = () => Date.now()) {
    this._now = now;
    this._deadline = now() + totalMs;
  }

  get remaining() {
    return Math.max(0, this._deadline - this._now());
  }

  get expired() {
    return this._now() >= this._deadline;
  }

  /** 为后续阶段保留 reserveMs，返回本阶段可用时长。 */
  sliceLeaving(reserveMs) {
    return Math.max(0, this.remaining - reserveMs);
  }

  /** 让一个 promise 与预算竞速；超时返回 fallback 而不是抛错。 */
  async race(promise, ms, fallback) {
    const limit = Math.min(ms, this.remaining);
    if (limit <= 0) return fallback;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), limit);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
