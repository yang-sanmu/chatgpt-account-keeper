import test from "node:test";
import assert from "node:assert/strict";
import {
  isBusy,
  withAccountLock,
  tryAcquire,
  release as releaseExclusive,
  quarantineAccount,
  releaseQuarantine,
  resetLocksForTest,
} from "../src/locks.js";

test("account lock reports pending work and releases its queue state after completion", async () => {
  const accountId = "lock_cleanup_test";
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const running = withAccountLock(accountId, () => gate);
  assert.equal(isBusy(accountId), true);

  release();
  await running;
  await Promise.resolve();
  assert.equal(isBusy(accountId), false);
});

// ---- withAccountLock 与非阻塞锁的双向互斥 ----
//
// 三条都用有界 race 断言「没有发生」，绝不 await 只在正确行为下才 resolve 的
// Promise：一旦互斥失效，测试必须是失败而不是悬挂。

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test("withAccountLock 必须等 tryAcquire 的持有者释放", async () => {
  resetLocksForTest();
  const accountId = "exclusive_blocks_queue_lock";
  const handle = tryAcquire(accountId, { owner: "queue" });
  assert.ok(handle);

  let ran = false;
  const running = withAccountLock(accountId, () => {
    ran = true;
  });

  await settled();
  // 队列已持锁期间，Profile 维护等 withAccountLock 调用方不得进入同一个 Profile。
  assert.equal(ran, false, "exclusive 持有期间 withAccountLock 不得执行");

  releaseExclusive(handle);
  await running;
  assert.equal(ran, true);
});

test("withAccountLock 必须等 quarantine 解除", async () => {
  resetLocksForTest();
  const accountId = "quarantine_blocks_queue_lock";
  quarantineAccount(accountId, "chromeReclaimFailed");

  let ran = false;
  const running = withAccountLock(accountId, () => {
    ran = true;
  });

  await settled();
  // 隔离期间 Profile 仍可能被僵尸 Chrome 持有文件锁。
  assert.equal(ran, false, "quarantine 期间 withAccountLock 不得执行");

  releaseQuarantine(accountId);
  await running;
  assert.equal(ran, true);
});

test("等待 exclusive 释放不会自锁悬挂", async () => {
  resetLocksForTest();
  const accountId = "exclusive_wait_no_deadlock";
  const handle = tryAcquire(accountId, { owner: "queue" });

  let ran = false;
  const running = withAccountLock(accountId, () => {
    ran = true;
  });
  // withAccountLock 在等待前已把自己的 pendingCounts +1，isBusy 恒为真。若唤醒走
  // 受 isBusy 门控的公开 onRelease，这里会永久悬挂。
  releaseExclusive(handle);

  const woke = await Promise.race([
    running.then(() => true),
    settled().then(() => false),
  ]);
  assert.equal(woke, true, "release 后必须在有界时间内醒来");
  assert.equal(ran, true);
});
