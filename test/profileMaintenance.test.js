import test from "node:test";
import assert from "node:assert/strict";
import {
  PROFILE_CACHE_LIMIT_BYTES,
  ProfileMaintenanceService,
  runProfileMaintenanceWorker,
} from "../src/profileMaintenance.js";

function serviceFixture({ enabled = true, held = false, shared = false } = {}) {
  const account = { id: "a1", profileDir: "profiles/a1" };
  const accounts = shared
    ? [account, { id: "a2", profileDir: "profiles/a1" }]
    : [account];
  const workerCalls = [];
  let lockCalls = 0;
  const service = new ProfileMaintenanceService({
    getAccount: (id) => (id === account.id ? account : null),
    getAccounts: () => accounts,
    getSettings: () => ({ profileAutoCleanEnabled: enabled }),
    isHeld: () => held,
    withAccountLock: async (_id, fn) => {
      lockCalls++;
      return fn();
    },
    runWorker: async (payload) => {
      workerCalls.push(payload);
      return { status: "cleaned", freedBytes: 200 * 1024 * 1024 };
    },
    now: () => Date.parse("2026-08-04T00:00:00.000Z"),
    log: { info() {}, warn() {} },
  });
  return { account, service, workerCalls, lockCalls: () => lockCalls };
}

test("超过预算的 Profile 在账号锁内交给工作线程处理", async () => {
  const fx = serviceFixture();

  const result = await fx.service.runNow(fx.account.id);

  assert.equal(result.status, "cleaned");
  assert.equal(fx.lockCalls(), 1);
  assert.equal(fx.workerCalls.length, 1);
  assert.equal(fx.workerCalls[0].limitBytes, PROFILE_CACHE_LIMIT_BYTES);
});

test("同一进程内一小时不重复检查同一 Profile", async () => {
  const fx = serviceFixture();

  await fx.service.runNow(fx.account.id);
  const second = await fx.service.runNow(fx.account.id);

  assert.equal(second.status, "recently-checked");
  assert.equal(fx.workerCalls.length, 1);
});

test("关闭自动维护后不启动工作线程", async () => {
  const fx = serviceFixture({ enabled: false });

  const result = await fx.service.runNow(fx.account.id);

  assert.equal(result.status, "disabled");
  assert.equal(fx.lockCalls(), 0);
  assert.equal(fx.workerCalls.length, 0);
});

test("手动窗口打开时跳过，避免阻塞其他账号的维护队列", async () => {
  const fx = serviceFixture({ held: true });

  const result = await fx.service.runNow(fx.account.id);

  assert.equal(result.status, "window-open");
  assert.equal(fx.lockCalls(), 0);
  assert.equal(fx.workerCalls.length, 0);
});

test("多个账号引用同一 Profile 时跳过自动维护", async () => {
  const fx = serviceFixture({ shared: true });

  const result = await fx.service.runNow(fx.account.id);

  assert.equal(result.status, "shared-profile");
  assert.equal(fx.workerCalls.length, 0);
});

test("关窗维护定时器保持进程存活，启动补扫定时器仍可 unref", () => {
  let unrefCalls = 0;
  const timers = [];
  const service = new ProfileMaintenanceService({
    getAccounts: () => [{ id: "startup-account" }],
    setTimeout: (callback) => {
      const timer = {
        callback,
        unref() {
          unrefCalls++;
        },
      };
      timers.push(timer);
      return timer;
    },
  });

  service.schedule("close-account");
  assert.equal(unrefCalls, 0);

  service.start();
  assert.equal(unrefCalls, 1);

  timers[1].callback();
  assert.equal(unrefCalls, 2);
});

test("真实工作线程可以安全识别不存在的 Profile", async () => {
  const result = await runProfileMaintenanceWorker({
    account: {
      id: `missing-profile-${Date.now()}`,
      profileDir: `profiles/__missing_profile_${Date.now()}__`,
    },
    limitBytes: PROFILE_CACHE_LIMIT_BYTES,
  });

  assert.equal(result.status, "missing");
  assert.equal(result.freedBytes, 0);
});
