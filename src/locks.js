// 按账号串行化浏览器操作。同一个 profileDir 不能被两个浏览器实例
// 同时打开，否则会锁冲突。登录/立即跑/检查状态/定时调度都要经过这里。

const queues = new Map(); // accountId -> Promise 链尾
const pendingCounts = new Map(); // accountId -> 正在运行或排队的任务数

export function withAccountLock(accountId, fn) {
  const prev = queues.get(accountId) ?? Promise.resolve();
  pendingCounts.set(accountId, (pendingCounts.get(accountId) ?? 0) + 1);
  // 无论上一个成功失败，都接着排队。排在自己前面的除了本链，还有非阻塞锁的持有者
  // 与 quarantine：只串 queues 会让 Profile 维护在队列持锁期间进入同一个 Profile。
  const run = prev.then(
    () => awaitExclusiveClear(accountId).then(fn),
    () => awaitExclusiveClear(accountId).then(fn)
  );
  // 记录链尾（吞掉错误，避免 unhandled rejection 影响后续排队）
  const tail = run.then(
    () => {},
    () => {}
  );
  queues.set(accountId, tail);
  tail.then(() => {
    const left = (pendingCounts.get(accountId) ?? 1) - 1;
    if (left > 0) pendingCounts.set(accountId, left);
    else pendingCounts.delete(accountId);
    // 只清理自己对应的链尾；期间若又排进了新任务，保留新的链尾。
    if (queues.get(accountId) === tail) queues.delete(accountId);
    notifyRelease(accountId);
  });
  return run;
}

// exclusive/quarantine 的专用变化通知。**不能**复用公开的 onRelease：后者表示
// "账号完全空闲"并受 isBusy 门控，而 withAccountLock 在等待前已把自己的
// pendingCounts +1，isBusy 恒为真，用 onRelease 等待会永久悬挂。
const exclusiveChangeWaiters = new Map(); // accountId -> Set<callback>

function notifyExclusiveChange(accountId) {
  const waiters = exclusiveChangeWaiters.get(accountId);
  if (!waiters || waiters.size === 0) return;
  // 逐个回调自行判定谓词；不满足的必须保留注册，否则一次"仍被持有"的通知会把
  // 等待者清空、之后正确的释放也唤不醒它。
  for (const callback of [...waiters]) {
    try {
      callback(accountId);
    } catch {
      // 等待者异常不能影响锁本身
    }
  }
}

/** 等到 tryAcquire 的持有者与 quarantine 都清空。 */
function awaitExclusiveClear(accountId) {
  if (!exclusiveHolders.has(accountId) && !quarantined.has(accountId)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiters = exclusiveChangeWaiters.get(accountId) ?? new Set();
    const callback = () => {
      if (exclusiveHolders.has(accountId) || quarantined.has(accountId)) return;
      waiters.delete(callback);
      if (waiters.size === 0) exclusiveChangeWaiters.delete(accountId);
      resolve();
    };
    waiters.add(callback);
    exclusiveChangeWaiters.set(accountId, waiters);
  });
}

export function isBusy(accountId) {
  return (
    (pendingCounts.get(accountId) ?? 0) > 0 ||
    exclusiveHolders.has(accountId) ||
    quarantined.has(accountId)
  );
}

/**
 * 「长期占用」标记：用户手动开着浏览器窗口时打上，关窗后清除。
 *
 * 放在这里而不是 openPage.js，是为了避免 statusMonitor ←→ openPage 循环导入
 * （openPage 本来就要 import statusMonitor 写状态缓存）。
 * 状态巡检据此跳过这些账号——它们的锁会被长期持有，排队等它没有意义。
 */
const heldAccounts = new Set();

export function markHeld(accountId) {
  heldAccounts.add(accountId);
}

export function releaseHeld(accountId) {
  heldAccounts.delete(accountId);
}

export function isHeld(accountId) {
  return heldAccounts.has(accountId);
}

// ---------------- 非阻塞账号锁（计划 §3.2） ----------------
//
// 队列条目取得工作槽后必须用 try-lock 取账号锁：拿不到就立刻把工作槽还回去，
// 否则少数长期开窗的账号会把 4 个工作槽全占死，整个后台停摆。
//
// 与 withAccountLock 是同一把锁，双向互斥：tryAcquire 经 isBusy 看到 withAccountLock
// 的排队，withAccountLock 则经 awaitExclusiveClear 等 exclusiveHolders/quarantine
// 清空。单向兼容会让 Profile 维护在队列持锁期间进入同一个 Profile。
// 释放侧同时发两种通知：exclusive-change 唤醒 withAccountLock，onRelease 唤醒队列。

const exclusiveHolders = new Map(); // accountId -> handle
const releaseWaiters = new Map(); // accountId -> Set<callback>
// close_failed 的隔离态：账号锁所有权留在 quarantine 里，不 release。
// 只设标志而放掉锁会让 Profile 维护去清理一个仍被僵尸 Chrome 占着文件锁的目录，
// 也会让 accounts.remove 放行删除一个 Profile 仍在使用的账号。
const quarantined = new Map(); // accountId -> reason

/**
 * 尝试立即取得账号锁。成功返回 handle，失败返回 null（不排队、不等待）。
 */
export function tryAcquire(accountId, options = {}) {
  if (!accountId) throw new TypeError("accountId is required");
  if (isBusy(accountId) || isHeld(accountId)) return null;
  const handle = {
    accountId,
    owner: options.owner ?? "queue",
    acquiredAt: Date.now(),
    released: false,
  };
  exclusiveHolders.set(accountId, handle);
  return handle;
}

/** 释放 tryAcquire 取得的锁。幂等。 */
export function release(handle) {
  if (!handle || handle.released) return false;
  handle.released = true;
  const accountId = handle.accountId;
  if (exclusiveHolders.get(accountId) === handle) {
    exclusiveHolders.delete(accountId);
  }
  // quarantine 期间不放行等待者：锁的所有权仍在隔离态手上。
  if (!quarantined.has(accountId)) {
    notifyExclusiveChange(accountId);
    notifyRelease(accountId);
  }
  return true;
}

/**
 * 把某个账号锁转入 quarantine。close_failed 时调用：不释放锁，但换一个持有者，
 * 这样 6 个既有 isBusy / isHeld 消费者自动全部拒绝该账号，无需逐个改判定。
 */
export function quarantineAccount(accountId, reason = "chromeReclaimFailed") {
  quarantined.set(accountId, reason);
  const handle = exclusiveHolders.get(accountId);
  if (handle) {
    handle.released = true;
    exclusiveHolders.delete(accountId);
  }
  return true;
}

/** 完整 owned 树确认消失后解除隔离，并唤醒等待者。 */
export function releaseQuarantine(accountId) {
  if (!quarantined.delete(accountId)) return false;
  notifyExclusiveChange(accountId);
  notifyRelease(accountId);
  return true;
}

export function isQuarantined(accountId) {
  return quarantined.has(accountId);
}

export function quarantineReason(accountId) {
  return quarantined.get(accountId) ?? null;
}

export function listQuarantined() {
  return [...quarantined.entries()].map(([accountId, reason]) => ({ accountId, reason }));
}

/**
 * 订阅某账号锁「完全释放」。必须无条件触发，不区分上一个持有者是队列、登录、
 * 打开网页还是 Profile 维护——否则队列会漏掉被 withAccountLock 释放的那一次唤醒。
 */
export function onRelease(accountId, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const waiters = releaseWaiters.get(accountId) ?? new Set();
  waiters.add(callback);
  releaseWaiters.set(accountId, waiters);
  return () => {
    const current = releaseWaiters.get(accountId);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) releaseWaiters.delete(accountId);
  };
}

function notifyRelease(accountId) {
  if (isBusy(accountId) || isHeld(accountId)) return;
  const waiters = releaseWaiters.get(accountId);
  if (!waiters || waiters.size === 0) return;
  // 复制后清空：回调通常会立刻重新 try-lock，避免在迭代中被修改。
  const callbacks = [...waiters];
  releaseWaiters.delete(accountId);
  for (const callback of callbacks) {
    try {
      callback(accountId);
    } catch {
      // 等待者异常不能影响锁本身
    }
  }
}

/** 仅供测试：清空全部锁状态。 */
export function resetLocksForTest() {
  queues.clear();
  pendingCounts.clear();
  heldAccounts.clear();
  exclusiveHolders.clear();
  releaseWaiters.clear();
  exclusiveChangeWaiters.clear();
  quarantined.clear();
}
