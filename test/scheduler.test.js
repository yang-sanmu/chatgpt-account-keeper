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
