import test from "node:test";
import assert from "node:assert/strict";
import { composeBackground } from "../src/agent/composition.js";
import { OperationRegistry } from "../src/application/operations.js";
import { createApplicationServices } from "../src/application/services.js";
import { SchedulerService } from "../src/scheduler.js";
import { resetLocksForTest, isQuarantined } from "../src/locks.js";

/**
 * 第 2 轮 GPT Review 的三条结论，一条一个测试：
 *  1. 业务失败仍是 failed 且保留业务结果，任何已创建 BrowserRun 的终态带 close 契约。
 *  2. 启动失败的所有权分叉：token 先登记；不确定则保留并证明，明确未创建才撤回。
 *  3. 手动 start/stop 与账号启停真正驱动 epoch 与排期表。
 */

/** 只含被测路径实际读到的字段。 */
function fixture(options = {}) {
  const broker = {
    running: true,
    generationId: "gen-test",
    tokens: [],
    disposed: [],
    newRunToken() {
      const token = `token-${this.tokens.length + 1}`;
      this.tokens.push(token);
      return token;
    },
    async start() {},
    async terminate() { return { ok: true }; },
    waitForEmpty: options.waitForEmpty ?? (async () => ({ ok: true, count: 0, disposed: false })),
    async dispose_(token) { this.disposed.push(token); return { ok: true }; },
    async forget() { return { ok: true }; },
    async dispose() {},
  };
  const events = { published: [], publish(name, payload) { this.published.push({ name, payload }); } };
  const operations = new OperationRegistry({ events });
  const recorded = [];
  return { broker, events, operations, recorded };
}

async function composeFake(options = {}) {
  resetLocksForTest();
  const { broker, events, operations, recorded } = fixture(options);
  const background = await composeBackground({
    operations,
    events,
    store: {
      getAccount: (id) => ({ id, enabled: true }),
      getAccounts: () => [{ id: "acc-1", enabled: true }],
      getSettings: () => ({ headless: true, intervalMinutes: 180 }),
    },
    log: { info() {}, warn() {}, error() {} },
    // 本组测的是所有权与关闭序列，账号不绑分组代理；提供者仍是必需参数。
    getProxyNodes: () => [],
    runOnce: options.runOnce ?? (async () => ({ ok: true })),
    checkSelectors: async () => ({ ok: true }),
    refreshAccount: async () => ({ state: "ok" }),
    statusMonitor: null,
    // composeBackground 要求的调度契约：本组不测调度，给足方法即可。
    scheduler: {
      running: true,
      nextAtFromNow: (now = Date.now()) => now + 60_000,
      noteScheduled: () => {},
      noteCompleted: () => {},
    },
    requireBroker: true,
    brokerFactory: () => broker,
    recordConversation: (accountId, result) => recorded.push({ accountId, result }),
    launchChrome: options.launchChrome ?? (async (account, opts) => ({
      context: { async close() {} },
      page: { url: () => "about:blank" },
      rootPid: 6001,
      rootStartTime: 1,
      runToken: opts.runToken,
    })),
  });
  const run = async () => {
    background.enqueue({ accountId: "acc-1", workKind: "account-run", kind: "account-run" });
    for (let i = 0; i < 100 && background.queue.activeCount() > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { background, broker, operations, events, recorded, run };
}

test("业务失败仍是 failed，保留业务结果并附带 close 契约", async () => {
  // Job 计数不归零：这正是「任务失败且 Chrome 未能回收」的现场。
  const { background, operations, recorded, events, run } = await composeFake({
    runOnce: async () => ({ ok: false, reason: "未登录，请先登录该账号" }),
    waitForEmpty: async () => ({ ok: true, count: 3, disposed: false }),
  });
  await run();

  const final = operations.list({ limit: 5 })[0];
  // 队列只把抛错记为 failed；缺少 ok→抛错映射时失败的自动对话会显示成成功。
  assert.equal(final.state, "failed");
  assert.match(final.message, /未登录/);
  assert.equal(final.result.ok, false, "必须保留业务结果");
  // §5.5：已创建 BrowserRun 的终态必须带 close.ok 布尔值，且未回收时为 false。
  assert.equal(typeof final.result.close.ok, "boolean");
  assert.equal(final.result.close.ok, false);
  assert.match(final.result.close.reason, /job-not-empty/);
  // 迁到队列后曾丢失的服务语义：历史落盘。
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].accountId, "acc-1");
  // close.ok === false 不得被解释为资源已释放：账号必须隔离且仍占 Chrome 容量。
  assert.equal(isQuarantined("acc-1"), true);
  assert.equal(background.snapshot().chromeSlots.used >= 1, true);
  assert.ok(events.published.some((entry) => entry.name === "browserRun.changed"));
  background.browserRuns.cancelAllRechecks();
});

test("启动失败的所有权分叉：不确定保留 token，明确未创建才撤回", async () => {
  const tokensDuringLaunch = [];
  let attempt = 0;
  const { background, broker, run } = await composeFake({
    // 保留 token 的那一次必须真的去证明；这里让它证明不出来。
    waitForEmpty: async () => ({ ok: true, count: 1, disposed: false }),
    launchChrome: async (account, opts) => {
      attempt++;
      // launch 进行中 run 就必须已持有 token，否则启动失败时无据可查。按 accountId 精确
      // 定位：close_failed 的 run 会长期留在 active，listActive()[0] 不是"当前这个"。
      const current = background.browserRuns
        .listActive()
        .find((entry) => entry.accountId === account.id);
      tokensDuringLaunch.push({
        registered: current?.launcherRunToken ?? null,
        used: opts.runToken,
      });
      const error = new Error(attempt === 1 ? "命令超时：launch" : "可执行文件不存在");
      error.code = attempt === 1 ? "CHROME_BROKER_TIMEOUT" : "LAUNCH_FAILED";
      // 只有 broker 的同步负响应能确定没留下任何东西（它返回前已 Dispose Job）。
      if (attempt === 2) error.ownershipCertain = true;
      throw error;
    },
  });

  await run();
  assert.equal(
    tokensDuringLaunch[0].registered,
    tokensDuringLaunch[0].used,
    "launch 前必须已登记本次使用的 token"
  );
  const stuck = background.browserRuns.listActive();
  assert.equal(stuck.length, 1, "不确定的失败必须留下 close_failed 记录");
  assert.equal(stuck[0].state, "close_failed");
  assert.equal(stuck[0].launcherRunToken, broker.tokens[0], "token 必须保留以供证明");
  assert.equal(isQuarantined("acc-1"), true, "证明不了回收必须隔离");
  background.browserRuns.cancelAllRechecks();

  // 第二次：明确未创建。隔离会挡住同一账号，所以换一个。
  resetLocksForTest();
  background.enqueue({ accountId: "acc-2", workKind: "account-run", kind: "account-run" });
  const deadline = Date.now() + 2_000;
  while ((attempt < 2 || background.queue.activeCount() > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(attempt, 2, "第二次 launch 应在 2 秒内发生");
  assert.equal(background.queue.activeCount(), 0, "第二次任务应在断言前结束");
  assert.equal(
    tokensDuringLaunch[1].registered,
    tokensDuringLaunch[1].used,
    "两个分叉都必须在 launch 前登记 token"
  );
  assert.equal(isQuarantined("acc-2"), false, "明确未创建不得隔离账号");
  assert.deepEqual(broker.disposed, [], "撤回 token 后不该再 dispose");
});

test("手动 start/stop 驱动 schedulerEpoch，账号启停驱动排期表", async () => {
  resetLocksForTest();
  const calls = { epoch: 0, config: 0, scheduled: [], unscheduled: [] };
  const scheduler = new SchedulerService({
    getSettings: () => ({ intervalMinutes: 180, jitterMinutes: 30, headless: true }),
    getAccounts: () => [],
    getAccount: (id) => ({ id, enabled: true }),
    log: { info() {}, warn() {}, error() {} },
  });
  scheduler.configureClock({ start() {}, stop() {} }, () => { calls.epoch++; });

  scheduler.start();
  await scheduler.stop();
  // 不 bump 的话，stop 之后已排队的 scheduled 条目不会被复验取消。
  assert.equal(calls.epoch, 2, "start 与 stop 各须 bump 一次 schedulerEpoch");

  const account = { id: "acc-1", enabled: true };
  const events = { publish() {} };
  const services = createApplicationServices({
    runtime: {
      store: {
        getAccount: () => account,
        getAccounts: () => [account],
        getGroups: () => [],
        updateAccount: (id, patch) => Object.assign(account, patch),
      },
      scheduler: { status: () => ({}) },
      proxies: { getNodes: () => [] },
      getOpenPages: () => ({}),
      getCachedStatus: () => ({}),
      bumpConfigEpoch: () => { calls.config++; },
      scheduleAccount: (id) => calls.scheduled.push(id),
      unscheduleAccount: (id) => calls.unscheduled.push(id),
    },
    operations: new OperationRegistry({ events }),
    events,
  });

  // 停用后必须撤期：ScheduleClock 是唯一计时源，留着排期就会继续到期。
  await services.invoke("accounts.update", { id: "acc-1", patch: { enabled: false } });
  assert.deepEqual(calls.unscheduled, ["acc-1"]);
  // 启用后必须补排期，否则新启用的账号永远等不到 onDue。
  await services.invoke("accounts.update", { id: "acc-1", patch: { enabled: true } });
  assert.deepEqual(calls.scheduled, ["acc-1"]);
  assert.equal(calls.config, 2, "启停都要触发排队条目的语义复验");
});
