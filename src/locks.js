// 按账号串行化浏览器操作。同一个 profileDir 不能被两个浏览器实例
// 同时打开，否则会锁冲突。登录/立即跑/检查状态/定时调度都要经过这里。

const queues = new Map(); // accountId -> Promise 链尾

export function withAccountLock(accountId, fn) {
  const prev = queues.get(accountId) ?? Promise.resolve();
  // 无论上一个成功失败，都接着排队
  const run = prev.then(fn, fn);
  // 记录链尾（吞掉错误，避免 unhandled rejection 影响后续排队）
  queues.set(
    accountId,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

export function isBusy(accountId) {
  return queues.has(accountId);
}
