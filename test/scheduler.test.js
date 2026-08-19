import test from "node:test";
import assert from "node:assert/strict";
import {
  SchedulerService,
  runWithBrowserLifecycle,
} from "../src/scheduler.js";

test("浏览器启动失败会转换为 runOnce 失败结果", async () => {
  const result = await runWithBrowserLifecycle(
    async () => {
      throw new Error("launch failed");
    },
    async () => ({ ok: true })
  );

  assert.deepEqual(result, { ok: false, reason: "launch failed" });
});

test("浏览器关闭失败不会覆盖已经得到的主结果", async () => {
  const expected = { ok: true, totalRounds: 2 };
  let closeCalls = 0;
  let reportedError = null;

  const result = await runWithBrowserLifecycle(
    async () => ({
      context: {
        close: async () => {
          closeCalls++;
          throw new Error("close failed");
        },
      },
      page: {},
    }),
    async () => expected,
    {
      reportCloseError: (error) => {
        reportedError = error;
      },
    }
  );

  assert.equal(result, expected);
  assert.equal(closeCalls, 1);
  assert.match(reportedError?.message ?? "", /close failed/);
});

test("浏览器关闭失败也不会覆盖运行阶段的主错误", async () => {
  const result = await runWithBrowserLifecycle(
    async () => ({
      context: {
        close: async () => {
          throw new Error("secondary close failure");
        },
      },
      page: {},
    }),
    async () => {
      throw new Error("primary operation failure");
    },
    { reportCloseError: () => {} }
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "primary operation failure",
  });
});

test("账号循环捕获运行异常并复位、记录、安排下一轮后安全退出", async () => {
  const accountId = "scheduler_failure_account";
  const account = { id: accountId, enabled: true, note: "Test" };
  const recorded = [];
  const messages = [];
  let service;

  service = new SchedulerService({
    runOnce: async () => {
      service._stopRequested = true;
      throw new Error("transient run failure");
    },
    getAccount: () => account,
    getAccounts: () => [account],
    getSettings: () => ({
      headless: true,
      intervalMinutes: 0,
      jitterMinutes: 0,
    }),
    recordConversation: (id, result) => recorded.push({ id, result }),
    sleep: async () => {},
    secureRandom: () => 0,
    log: {
      info: (message) => messages.push(["info", message]),
      warn: (message) => messages.push(["warn", message]),
      error: (message) => messages.push(["error", message]),
    },
  });

  const state = { nextAt: 0, lastAt: null, busy: false, promise: null };
  service._accountLoops.set(accountId, state);
  state.promise = service._runAccountLoop(accountId);

  await assert.doesNotReject(() => state.promise);

  assert.equal(state.busy, false);
  assert.equal(typeof state.lastAt, "number");
  assert.ok(state.nextAt >= state.lastAt + 59_000);
  assert.equal(service._accountLoops.has(accountId), false);
  assert.equal(service.lastResults[accountId].ok, false);
  assert.match(service.lastResults[accountId].reason, /transient run failure/);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].id, accountId);
  assert.match(recorded[0].result.reason, /transient run failure/);
  assert.ok(messages.some(([level]) => level === "warn"));
});

test("管理循环为意外拒绝的账号 Promise 安装最终兜底", async () => {
  const account = { id: "scheduler_rejection_account", enabled: true };
  const errors = [];
  let service;

  service = new SchedulerService({
    getAccounts: () => [account],
    sleep: async () => {
      service._stopRequested = true;
    },
    log: {
      info: () => {},
      warn: () => {},
      error: (message) => errors.push(message),
    },
  });
  service.running = true;
  service._runAccountLoop = async () => {
    throw new Error("unexpected loop rejection");
  };

  await assert.doesNotReject(() => service._runManager());

  assert.equal(service._accountLoops.has(account.id), false);
  assert.ok(errors.some((message) => /unexpected loop rejection/.test(message)));
});

test("start 为管理循环本身安装最终兜底并复位运行状态", async () => {
  const errors = [];
  const service = new SchedulerService({
    getSettings: () => ({ intervalMinutes: 10, jitterMinutes: 0 }),
    log: {
      info: () => {},
      warn: () => {},
      error: (message) => errors.push(message),
    },
  });
  service._runManager = async () => {
    throw new Error("manager crashed");
  };

  assert.equal(service.start().running, true);
  await service._manager;

  assert.equal(service.running, false);
  assert.equal(service._stopRequested, true);
  assert.ok(errors.some((message) => /manager crashed/.test(message)));
});

test("调度器恢复持久化 nextAt、上次结果并持久化启停开关", async () => {
  const accountId = "persistent-account";
  const nextAt = new Date(Date.now() + 60_000).toISOString();
  const enabled = [];
  const saved = [];
  let service;
  service = new SchedulerService({
    getAccount: () => ({ id: accountId, enabled: true }),
    getAccounts: () => [],
    getSettings: () => ({ intervalMinutes: 180, jitterMinutes: 0, headless: true }),
    sleep: async () => {
      service._stopRequested = true;
    },
    persistence: {
      load: () => ({
        enabled: true,
        accounts: {
          [accountId]: {
            nextAt,
            lastResult: { ok: false, reason: "上次失败", time: "2026-08-14T00:00:00.000Z" },
          },
        },
      }),
      setEnabled: (value) => enabled.push(value),
      saveAccount: (id, state) => saved.push({ id, state }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const state = { nextAt: 0, lastAt: null, busy: false, promise: null };
  service._accountLoops.set(accountId, state);
  await service._runAccountLoop(accountId);
  assert.equal(saved[0].id, accountId);
  assert.ok(Math.abs(Date.parse(saved[0].state.nextAt) - Date.parse(nextAt)) < 100);
  assert.deepEqual(service.lastResults[accountId], {
    ok: false,
    reason: "上次失败",
    time: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(saved[0].state.lastResult.reason, "上次失败");

  service._runManager = async () => {};
  service.start();
  await service.stop();
  assert.deepEqual(enabled.slice(-2), [true, false]);
});

test("调度器停止时仍向客户端返回持久化的上次运行结果", () => {
  const service = new SchedulerService({
    persistence: {
      load: () => ({
        enabled: false,
        accounts: {
          failed: {
            nextAt: "2026-08-20T01:00:00.000Z",
            lastAt: "2026-08-19T01:00:00.000Z",
            lastResultState: "failed",
            lastResult: { ok: false, reason: "会话已失效" },
          },
        },
      }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  assert.deepEqual(service.status(), {
    running: false,
    enabled: false,
    accounts: {
      failed: {
        nextAt: "2026-08-20T01:00:00.000Z",
        lastAt: "2026-08-19T01:00:00.000Z",
        busy: false,
      },
    },
    lastResults: {
      failed: { ok: false, reason: "会话已失效" },
    },
  });
});

test("scheduler drain waits for the manager and account work to settle", async () => {
  let releaseAccount;
  const accountWork = new Promise((resolve) => {
    releaseAccount = resolve;
  });
  let releaseManager;
  const manager = new Promise((resolve) => {
    releaseManager = resolve;
  });
  const service = new SchedulerService({
    persistence: { load: () => ({ enabled: false, accounts: {} }), setEnabled: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  service.running = true;
  service._manager = manager;
  service._accountLoops.set("account", {
    nextAt: 0,
    lastAt: null,
    busy: true,
    promise: accountWork,
  });

  let completed = false;
  const draining = service.drain({ timeoutMs: 1_000 }).then((result) => {
    completed = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  releaseAccount();
  releaseManager();
  assert.equal((await draining).drained, true);
});

test("update drain preserves the persisted scheduler switch across repeated drain calls", async () => {
  let persistedEnabled = true;
  const writes = [];
  const service = new SchedulerService({
    persistence: {
      load: () => ({ enabled: persistedEnabled, accounts: {} }),
      setEnabled: (value) => {
        persistedEnabled = value;
        writes.push(value);
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  service.running = true;

  assert.equal((await service.drain({ preserveEnabled: true })).drained, true);
  assert.equal(persistedEnabled, true);
  assert.equal((await service.drain({ preserveEnabled: true })).drained, true);
  assert.equal(persistedEnabled, true);
  assert.deepEqual(writes, [false, true, false, true]);
});

test("update drain restores the persisted switch after manager shutdown finishes", async () => {
  let persistedEnabled = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = new SchedulerService({
    persistence: {
      load: () => ({ enabled: persistedEnabled, accounts: {} }),
      setEnabled: (value) => {
        persistedEnabled = value;
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  service.running = true;
  service._manager = (async () => {
    await gate;
    service._setRunning(false);
  })();

  const draining = service.drain({ timeoutMs: 1_000, preserveEnabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistedEnabled, false);
  release();
  assert.equal((await draining).drained, true);
  assert.equal(persistedEnabled, true);
});

test("timed-out drain does not restore the persisted switch before work settles", async () => {
  let persistedEnabled = true;
  let release;
  const manager = new Promise((resolve) => {
    release = resolve;
  });
  const service = new SchedulerService({
    persistence: {
      load: () => ({ enabled: persistedEnabled, accounts: {} }),
      setEnabled: (value) => {
        persistedEnabled = value;
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  service.running = true;
  service._manager = manager;

  assert.equal((await service.drain({ timeoutMs: 1, preserveEnabled: true })).drained, false);
  assert.equal(persistedEnabled, false);
  release();
  await manager;
});

test("running 与持久化开关始终一起变化，崩溃不会留下假的运行中状态", async () => {
  // 早先 start() 先写 enabled=true，管理循环失败后才写回 false；中间被杀进程会
  // 留下 enabled=true 但没有在跑的状态，重启后界面显示“运行中”而实际已停。
  const writes = [];
  let persisted = false;
  const service = new SchedulerService({
    persistence: {
      load: () => ({ enabled: persisted, accounts: {} }),
      setEnabled: (value) => {
        persisted = value;
        writes.push(value);
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  service._runManager = async () => {
    throw new Error("管理循环失败");
  };

  service.start();
  assert.equal(service.running, true);
  assert.equal(persisted, true);
  await service._manager;
  assert.equal(service.running, false, "管理循环失败后 running 必须复位");
  assert.equal(persisted, false, "running 与 enabled 不能分叉");
  assert.deepEqual(writes, [true, false]);
});

test("每次持久化账号调度状态都会通知订阅者", async () => {
  const accountId = "watched-account";
  const nextAt = new Date(Date.now() + 60_000).toISOString();
  const changes = [];
  let service;
  service = new SchedulerService({
    getAccount: () => ({ id: accountId, enabled: true }),
    getAccounts: () => [],
    getSettings: () => ({ intervalMinutes: 180, jitterMinutes: 0, headless: true }),
    sleep: async () => {
      service._stopRequested = true;
    },
    persistence: {
      load: () => ({ enabled: true, accounts: { [accountId]: { nextAt } } }),
      setEnabled: () => {},
      saveAccount: () => {},
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const unsubscribe = service.subscribe((change) => changes.push(change));

  const state = { nextAt: 0, lastAt: null, busy: false, promise: null };
  service._accountLoops.set(accountId, state);
  await service._runAccountLoop(accountId);

  const accountChange = changes.find((change) => change.kind === "account");
  assert.ok(accountChange, "账号调度变化必须通知订阅者，否则界面只能轮询");
  assert.equal(accountChange.accountId, accountId);
  assert.ok(Math.abs(Date.parse(accountChange.nextAt) - Date.parse(nextAt)) < 100);

  unsubscribe();
  changes.length = 0;
  service._persistAccount(accountId, state);
  assert.deepEqual(changes, [], "取消订阅后不应再收到通知");
});

test("订阅者抛错不会影响调度自身", async () => {
  const service = new SchedulerService({
    persistence: { load: () => ({ enabled: false, accounts: {} }), setEnabled: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  service.subscribe(() => {
    throw new Error("订阅者炸了");
  });
  service._runManager = async () => {};
  assert.doesNotThrow(() => service.start());
  assert.equal(service.running, true);
  await service.stop();
  assert.equal(service.running, false);
});
