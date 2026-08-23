/**
 * 三类资源的唯一持有者（计划 §3）。
 *
 * 资源类别上的全序是 **工作槽 < 账号锁 < Chrome 槽**，释放顺序相反。各参与方只取
 * 自己需要的子集，相对顺序一致即不成环：
 *   后台任务   工作槽 → 账号锁 → Chrome 槽
 *   登录/开页  账号锁 → Chrome 槽（不取工作槽）
 *   Profile 维护  仅账号锁
 *
 * 交互路径必须与全序一致（account → chrome）。若反过来让交互先取 Chrome 槽，就会
 * 出现后台持 account 等 chrome、交互持 chrome 等 account 的死锁环。
 */

export const DEFAULT_WORK_SLOTS = 4;
export const DEFAULT_CHROME_SLOTS = 4;
export const DEFAULT_LAUNCH_INTERVAL_MS = 1_000;

export class SlotManager {
  constructor(options = {}) {
    this._workLimit = options.workSlots ?? DEFAULT_WORK_SLOTS;
    this._chromeLimit = options.chromeSlots ?? DEFAULT_CHROME_SLOTS;
    this._launchIntervalMs = options.launchIntervalMs ?? DEFAULT_LAUNCH_INTERVAL_MS;
    this._now = options.now ?? (() => Date.now());
    this._sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }));
    this._workUsed = 0;
    this._chromeHolders = new Set();
    // 交互请求（login / open-page）的最高优先级 FIFO。任何新释放的 Chrome 槽先给
    // 这个队列，后台不得插队；但不抢占、不取消其他账号正在运行的任务。
    this._interactiveWaiters = [];
    this._backgroundWaiters = [];
    this._lastLaunchAt = 0;
    // 准入暂停：验收 #13 的纯 queued 场景需要能构造「无任何条目持资源」。
    this._admissionPaused = false;
  }

  get workLimit() {
    return this._workLimit;
  }

  get chromeLimit() {
    return this._chromeLimit;
  }

  get admissionPaused() {
    return this._admissionPaused;
  }

  pauseAdmission() {
    this._admissionPaused = true;
  }

  resumeAdmission() {
    this._admissionPaused = false;
  }

  snapshot() {
    return {
      workSlots: { used: this._workUsed, limit: this._workLimit },
      chromeSlots: { used: this._chromeHolders.size, limit: this._chromeLimit },
      interactiveWaiting: this._interactiveWaiters.length,
      backgroundWaiting: this._backgroundWaiters.length,
      admissionPaused: this._admissionPaused,
    };
  }

  // ---------------- 工作槽 ----------------

  tryAcquireWorkSlot() {
    if (this._admissionPaused) return null;
    if (this._workUsed >= this._workLimit) return null;
    this._workUsed++;
    const handle = { kind: "work", released: false };
    handle.release = () => {
      if (handle.released) return false;
      handle.released = true;
      this._workUsed = Math.max(0, this._workUsed - 1);
      return true;
    };
    return handle;
  }

  get workSlotsAvailable() {
    return !this._admissionPaused && this._workUsed < this._workLimit;
  }

  // ---------------- Chrome 槽 ----------------

  /**
   * 申请 Chrome 槽。interactive=true 进入最高优先级队列：此后任何新释放的槽优先
   * 给它，直到该队列为空。优先级规则只保证「不被后台插队」，不承诺延迟上界。
   */
  acquireChromeSlot(options = {}) {
    const interactive = options.interactive === true;
    const signal = options.signal ?? null;
    const label = options.label ?? null;

    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }

    // 后台只有在交互队列为空时才能直接取槽。
    const canTakeNow = interactive
      ? this._chromeHolders.size < this._chromeLimit && this._interactiveWaiters.length === 0
      : this._chromeHolders.size < this._chromeLimit && this._interactiveWaiters.length === 0;

    if (canTakeNow) {
      return Promise.resolve(this._grantChromeSlot(label));
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, interactive, label, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          this._removeWaiter(waiter);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (interactive) this._interactiveWaiters.push(waiter);
      else this._backgroundWaiters.push(waiter);
    });
  }

  _removeWaiter(waiter) {
    const fromInteractive = this._interactiveWaiters.indexOf(waiter);
    if (fromInteractive >= 0) this._interactiveWaiters.splice(fromInteractive, 1);
    const fromBackground = this._backgroundWaiters.indexOf(waiter);
    if (fromBackground >= 0) this._backgroundWaiters.splice(fromBackground, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  _grantChromeSlot(label) {
    const handle = { kind: "chrome", label, released: false };
    this._chromeHolders.add(handle);
    handle.release = () => {
      if (handle.released) return false;
      handle.released = true;
      this._chromeHolders.delete(handle);
      this._pumpChromeWaiters();
      return true;
    };
    return handle;
  }

  _pumpChromeWaiters() {
    while (this._chromeHolders.size < this._chromeLimit) {
      // 交互优先：新释放的槽必须先给交互队列。
      const waiter = this._interactiveWaiters.shift() ?? this._backgroundWaiters.shift();
      if (!waiter) return;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this._grantChromeSlot(waiter.label));
    }
  }

  /**
   * 全局最小启动间隔。启动许可由这里统一发放，调用方不能自行 sleep 绕过。
   */
  async awaitLaunchPermit(signal = null) {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const now = this._now();
      const earliest = this._lastLaunchAt + this._launchIntervalMs;
      if (now >= earliest) {
        this._lastLaunchAt = now;
        return;
      }
      await this._sleep(earliest - now);
    }
  }

  /** 仅供测试：观察 Chrome 槽当前持有者的标签。 */
  chromeHolderLabels() {
    return [...this._chromeHolders].map((handle) => handle.label);
  }
}

function abortError(signal) {
  const error = new Error(
    typeof signal?.reason === "string" ? signal.reason : "操作已取消"
  );
  error.code = "CANCELLED";
  error.cancelled = true;
  return error;
}
