import test from "node:test";
import assert from "node:assert/strict";
import { composeBackground } from "../src/agent/composition.js";
import { OperationRegistry } from "../src/application/operations.js";
import { createApplicationServices } from "../src/application/services.js";
import { resetLocksForTest, isQuarantined } from "../src/locks.js";

/**
 * 第 1 轮 GPT Review 的三条结论对应的回归：
 *  1. 三个交互入口必须真的进统一队列，不再 operations.create + legacy runtime。
 *  2. 真实 Chrome 创建只使用一个已登记的 runToken，且关闭时 dispose 的是同一个；
 *     statusCheck 不得因队列已持锁而被 isBusy 判为忙碌后跳过。
 *  3. legacy Scheduler 不再启动账号循环，计时只有 ScheduleClock 一套。
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** 记录每一次 token 创建与使用的 launcher 替身。 */
function fakeBroker() {
  return {
    running: true,
    generationId: "gen-test",
    tokens: [],
    terminated: [],
    disposed: [],
    forgotten: [],
    newRunToken() {
      const token = `token-${this.tokens.length + 1}`;
      this.tokens.push(token);
      return token;
    },
    async start() {},
    async terminate(token) {
      this.terminated.push(token);
      return { ok: true };
    },
    async waitForEmpty() {
      return { ok: true, count: 0, disposed: false };
    },
    async dispose_(token) {
      this.disposed.push(token);
      return { ok: true };
    },
    async forget(token) {
      this.forgotten.push(token);
      return { ok: true };
    },
    async dispose() {},
  };
}

function fakeStore(accounts = [{ id: "acc-1", enabled: true }]) {
  return {
    getAccount: (id) => accounts.find((account) => account.id === id) ?? null,
    getAccounts: () => accounts,
    getSettings: () => ({ headless: true, intervalMinutes: 180 }),
    effectiveProxyId: () => null,
    getProxyNodes: () => [],
  };
}

/**
 * 组合一个不碰真实 Chrome 的后台。broker 用替身注入，launchChrome 记录收到的 token
 * 并返回一个可关闭的假 context。
 */
async function composeFake(overrides = {}) {
  resetLocksForTest();
  const broker = fakeBroker();
  const launches = [];
  const events = { published: [], publish(name, payload) { this.published.push({ name, payload }); } };
  const operations = new OperationRegistry({ events });
  const closedContexts = [];

  const background = await composeBackground({
    operations,
    events,
    store: overrides.store ?? fakeStore(),
    log: { info() {}, warn() {}, error() {} },
    runOnce: overrides.runOnce ?? (async () => ({ ok: true })),
    checkSelectors: overrides.checkSelectors ?? (async () => ({ ok: true })),
    refreshAccount: overrides.refreshAccount ?? (async () => ({ state: "ok" })),
    statusMonitor: null,
    scheduler: { running: true },
    schedulerPersistence: null,
    requireBroker: true,
    brokerFactory: () => broker,
    launchChrome: async (account, opts) => {
      launches.push({ accountId: account.id, runToken: opts.runToken, headless: opts.headless });
      const context = {
        closed: false,
        async close() {
          this.closed = true;
          closedContexts.push(this);
        },
      };
      return {
        context,
        page: { url: () => "about:blank" },
        rootPid: 4242 + launches.length,
        rootStartTime: 1700000000,
        runToken: opts.runToken,
      };
    },
  });

  return { background, broker, launches, operations, events, closedContexts };
}

test("后台任务只创建一个 runToken，且关闭时 dispose 的正是启动用的那个", async () => {
  const seenPages = [];
  const { background, broker, launches } = await composeFake({
    runOnce: async (account, opts) => {
      // 业务函数拿到的是调用方给的页面：它不得自行 launch，也不得自行关闭。
      seenPages.push(opts.page);
      return { ok: true };
    },
  });

  const operation = background.enqueue({
    accountId: "acc-1",
    workKind: "account-run",
    kind: "account-run",
  });
  assert.ok(operation);

  for (let i = 0; i < 60 && background.queue.activeCount() > 0; i++) await settle();

  assert.equal(launches.length, 1, "只应启动一次 Chrome");
  // 核心不变量：整条链上只有一个 token。旧实现里 compose 造一个、browser.js 再自造
  // 一个，BrowserRun 关联的是未使用的那个，真实 token 永不 dispose。
  assert.equal(broker.tokens.length, 1, `只应创建 1 个 runToken，实际 ${broker.tokens.length}`);
  assert.equal(launches[0].runToken, broker.tokens[0], "启动必须用登记的那个 token");
  assert.deepEqual(broker.disposed, broker.tokens, "dispose 的必须是启动过的同一个 token");
  assert.equal(seenPages.length, 1);
  assert.ok(seenPages[0], "业务函数必须收到调用方提供的 page");
});

test("BrowserRun 记录真实 rootPid，而不是 null", async () => {
  const { background, launches } = await composeFake();
  let captured = null;
  background.browserRuns.configureBroker(background.broker);

  const originalClose = background.browserRuns.close.bind(background.browserRuns);
  background.browserRuns.close = async (id, reason) => {
    captured = background.browserRuns.get(id);
    return originalClose(id, reason);
  };

  background.enqueue({ accountId: "acc-1", workKind: "account-run", kind: "account-run" });
  for (let i = 0; i < 60 && background.queue.activeCount() > 0; i++) await settle();

  assert.ok(captured, "关闭前应能取到 run");
  assert.equal(launches.length, 1);
  // 旧实现把业务返回值当启动结果，rootPid 恒为 null，关闭序列于是对着空 root 收敛。
  assert.ok(captured.rootPid > 0, "rootPid 必须来自 launcher 的真实报告");
  assert.equal(captured.launcherRunToken, launches[0].runToken);
});

test("状态巡检经队列时必须真的启动 Chrome，不得被 isBusy 判为忙碌后跳过", async () => {
  const refreshCalls = [];
  const { background, launches } = await composeFake({
    refreshAccount: async (account, opts) => {
      refreshCalls.push({ accountId: account.id, page: opts.page });
      return { state: "ok" };
    },
  });

  background.enqueue({
    accountId: "acc-1",
    workKind: "status-check",
    kind: "account-status-refresh",
  });
  for (let i = 0; i < 60 && background.queue.activeCount() > 0; i++) await settle();

  // 队列已用 tryAcquire 持锁，legacy refreshAccount 会因 isBusy 立刻返回 cached
  // skipped，Chrome 永不启动。
  assert.equal(launches.length, 1, "statusCheck 必须启动一次 Chrome");
  assert.equal(refreshCalls.length, 1);
  assert.ok(refreshCalls[0].page, "refreshAccount 必须收到 BrowserRun 提供的 page");
});

test("登录与打开网页占 Chrome 槽并登记 BrowserRun，用同一个 token", async () => {
  const { background, broker, launches } = await composeFake();

  const acquired = await background.acquireInteractiveChrome({
    accountId: "acc-1",
    account: { id: "acc-1" },
    purpose: "open-page",
    headless: false,
  });

  const active = background.browserRuns.listActive();
  assert.equal(active.length, 1, "打开网页必须登记 BrowserRun");
  assert.equal(active[0].purpose, "open-page");
  assert.equal(active[0].rootPid > 0, true);
  // 长期页面计入 Chrome 容量分母。
  assert.equal(background.snapshot().chromeSlots.used, 1);
  assert.equal(broker.tokens.length, 1);
  assert.equal(launches[0].runToken, broker.tokens[0]);

  // 收口必须经 BrowserRun：直接 context.close() 不会 dispose Job。
  await acquired.release("user-closed");
  assert.deepEqual(broker.disposed, broker.tokens);
  assert.equal(background.browserRuns.listActive().length, 0);
  assert.equal(background.snapshot().chromeSlots.used, 0);
});

test("三个交互入口都进统一队列，不再直连 legacy runtime", async () => {
  resetLocksForTest();
  const submitted = [];
  const events = { publish() {} };
  const operations = new OperationRegistry({ events });
  const services = createApplicationServices({
    runtime: {
      store: fakeStore(),
      enqueue(request) {
        submitted.push(request);
        return operations.declare(request.kind, { resourceId: request.accountId });
      },
      // 直连路径一旦被走到就应该失败：这三个入口必须经队列。
      runOnce: () => assert.fail("runNow 不得直连 legacy runOnce"),
      checkSelectors: () => assert.fail("checkSelectors 不得直连 legacy 实现"),
      refreshAccount: () => assert.fail("refreshStatus 不得直连 legacy refreshAccount"),
      isBusy: () => true,
      isHeld: () => false,
    },
    operations,
    events,
  });

  await services.invoke("accounts.runNow", { id: "acc-1" });
  await services.invoke("accounts.refreshStatus", { id: "acc-1" });
  await services.invoke("accounts.checkSelectors", { id: "acc-1", deep: true });

  assert.deepEqual(
    submitted.map((request) => request.workKind),
    ["account-run", "status-check", "selector-check"]
  );
  // 全部按用户触发入队，才能在去重时提升被自动调度占住的同一条。
  assert.equal(submitted.every((request) => request.source === undefined), true);
  // depth 必须进去重维度：page 与 conversation 是两件不同的事。
  assert.deepEqual(submitted[2].dedupeParams, { depth: "conversation" });
  // isBusy 为真也不再前置 RESOURCE_BUSY：去重与意图提升接管了这件事。
  assert.equal(submitted.length, 3);
});

test("Scheduler 配置时钟后不再启动账号循环，计时只有一套", async () => {
  const { SchedulerService } = await import("../src/scheduler.js");
  const clockCalls = { start: 0, stop: 0 };
  const scheduler = new SchedulerService({
    getSettings: () => ({ intervalMinutes: 180, jitterMinutes: 30, headless: true }),
    getAccounts: () => [{ id: "acc-1", enabled: true }],
    getAccount: (id) => ({ id, enabled: true }),
    runOnce: () => assert.fail("接入队列后 Scheduler 不得自己跑 runOnce"),
    log: { info() {}, warn() {}, error() {} },
  });
  scheduler.configureClock({
    start() { clockCalls.start++; },
    stop() { clockCalls.stop++; },
  });

  const started = scheduler.start();
  assert.equal(started.running, true);
  assert.equal(clockCalls.start, 1, "start 必须驱动唯一的 ScheduleClock");
  // 账号循环不得存在：两套计时器会让每个启用账号在一个间隔内跑两次对话。
  assert.equal(scheduler._accountLoops.size, 0, "不得再拉起每账号循环");
  assert.equal(scheduler._manager, undefined, "不得再启动管理循环");

  await scheduler.stop();
  assert.equal(clockCalls.stop, 1, "stop 必须停下同一个时钟");
  assert.equal(scheduler.running, false);
});

test("close_failed 时账号进入隔离，Chrome 容量不释放", async () => {
  const { background, broker, operations } = await composeFake();
  // 让 Job 计数不归零：这正是"任务已取消但 Chrome 未能回收"的现场。
  broker.waitForEmpty = async () => ({ ok: true, count: 2, disposed: false });

  const operation = background.enqueue({
    accountId: "acc-1",
    workKind: "account-run",
    kind: "account-run",
  });
  for (let i = 0; i < 80 && background.queue.activeCount() > 0; i++) await settle();

  const active = background.browserRuns.listActive();
  assert.equal(active.length, 1, "未能回收的 run 必须留在 active");
  assert.equal(active[0].state, "close_failed");
  assert.equal(isQuarantined("acc-1"), true, "账号必须进入隔离");
  const final = operations.get(operation.id);
  assert.equal(final.state, "failed", "业务成功但 Chrome 未回收时 Operation 必须降级");
  assert.equal(final.result.close.ok, false);
  // 容量分母仍计入它，否则 UI 会显示成已释放。
  assert.equal(background.snapshot().chromeSlots.used >= 1, true);
  background.browserRuns.cancelAllRechecks();
});

test("选择器摘要在关闭 Chrome 后仍是 Operation 的最终消息", async () => {
  const { background, operations } = await composeFake({
    checkSelectors: async () => ({ ok: true, summary: "全部选择器可用" }),
  });
  const operation = background.enqueue({
    accountId: "acc-1",
    workKind: "selector-check",
    kind: "account-selector-check",
    dedupeParams: { depth: "page" },
  });
  for (let i = 0; i < 60 && background.queue.activeCount() > 0; i++) await settle();
  assert.equal(operations.get(operation.id).message, "全部选择器可用");
});
