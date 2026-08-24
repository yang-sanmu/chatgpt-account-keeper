import test from "node:test";
import assert from "node:assert/strict";
import { composeBackground } from "../src/agent/composition.js";
import { OperationRegistry } from "../src/application/operations.js";
import { createApplicationServices } from "../src/application/services.js";
import { resetLocksForTest, isQuarantined } from "../src/locks.js";
import { CancelledError } from "../src/cancellation.js";

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

/**
 * 默认就绑定分组代理。早先这里是 effectiveProxyId: () => null 外加一个
 * getProxyNodes: () => []，于是没有一条测试进得去复验里的 if (proxyId) 分支——
 * 一个让**所有**真实账号无法运行的 bug 在全绿的测试下发布了。
 */
function fakeStore(accounts = [{ id: "acc-1", enabled: true }], { proxyId = "node-1" } = {}) {
  return {
    getAccount: (id) => accounts.find((account) => account.id === id) ?? null,
    getAccounts: () => accounts,
    getSettings: () => ({ headless: true, intervalMinutes: 180 }),
    effectiveProxyId: () => proxyId,
  };
}

const healthyNodes = () => [{ id: "node-1", enabled: true, missing: false }];

/** composeBackground 要求的 scheduler 契约：三个方法缺一不可。 */
function fakeScheduler(overrides = {}) {
  return {
    running: true,
    nextAtFromNow: (now = Date.now()) => now + 60_000,
    noteScheduled: () => {},
    noteCompleted: () => {},
    ...overrides,
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
    scheduler: overrides.scheduler ?? fakeScheduler(),
    getProxyNodes: overrides.getProxyNodes ?? healthyNodes,
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

/** 队列跑到终态即停；不靠固定睡眠，测试保持确定且快。 */
async function drainQueue(background, limit = 120) {
  for (let i = 0; i < limit && background.queue.activeCount() > 0; i++) await settle();
}

/**
 * 时钟到期是经 setTimeout 异步入队的，所以不能直接 drain：那一刻队列还是空的，
 * 循环会立刻退出。先等条目出现，再等它跑完。
 */
async function drainAfterClock(background, limit = 120) {
  for (let i = 0; i < limit && background.queue.activeCount() === 0; i++) await settle();
  await drainQueue(background, limit);
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

/**
 * 第 2 轮 Review：语义复验的节点来源与调度状态回写。
 *
 * store 从来没有导出 getProxyNodes（节点表在 proxyManager），所以原先那句
 * store.getProxyNodes?.() ?? [] 在**任何**后端下都退化成空表，凡是分组绑了代理的
 * 账号一律被判「分组绑定的代理节点不可用」——而 _checkEntry 在每次 _pump 都跑，
 * 手动 Run Now、状态巡检、选择器自检、自动调度全部中招。
 */

test("契约不全时 composeBackground 在接受任何任务之前就失败", async () => {
  const operations = new OperationRegistry({ events: { publish() {} } });
  const base = {
    operations,
    events: { publish() {} },
    store: fakeStore(),
    log: { info() {}, warn() {}, error() {} },
    runOnce: async () => ({ ok: true }),
    checkSelectors: async () => ({ ok: true }),
    refreshAccount: async () => ({ state: "ok" }),
    statusMonitor: null,
    scheduler: fakeScheduler(),
    getProxyNodes: healthyNodes,
    requireBroker: false,
  };

  const cases = [
    [{ getProxyNodes: undefined }, /getProxyNodes provider is required/],
    // 坏 provider 必须在 compose 时就炸：等到第一条 proxied 任务才炸的话，
    // submit 已经 declare 了 Operation，会留下半入队状态。
    [{ getProxyNodes: () => null }, /getProxyNodes must return an array/],
    [{ getProxyNodes: () => ({ nodes: [] }) }, /getProxyNodes must return an array/],
    [{ scheduler: fakeScheduler({ nextAtFromNow: undefined }) }, /scheduler\.nextAtFromNow/],
    [{ scheduler: fakeScheduler({ noteScheduled: undefined }) }, /scheduler\.noteScheduled/],
    [{ scheduler: fakeScheduler({ noteCompleted: undefined }) }, /scheduler\.noteCompleted/],
  ];

  for (const [patch, expected] of cases) {
    await assert.rejects(() => composeBackground({ ...base, ...patch }), expected);
  }
  // 一条 Operation 都不该留下。
  assert.equal(operations.list().length, 0, "compose 失败不得遗留半入队的 Operation");
});

test("手动入队：绑定了健康代理节点的启用账号必须真的启动", async () => {
  const { background, launches, operations } = await composeFake();

  const operation = background.enqueue({
    accountId: "acc-1",
    workKind: "account-run",
    kind: "account-run",
  });
  await drainQueue(background);

  // 修复前这里是 cancelled + 「分组绑定的代理节点不可用」，一次 Chrome 都不启动。
  assert.equal(launches.length, 1, "健康节点下必须启动 Chrome");
  assert.equal(operations.get(operation.id).state, "succeeded");
});

test("节点缺失仍然取消，且不启动 Chrome", async () => {
  const { background, launches, operations } = await composeFake({
    getProxyNodes: () => [{ id: "node-1", enabled: true, missing: true }],
  });

  const operation = background.enqueue({
    accountId: "acc-1",
    workKind: "account-run",
    kind: "account-run",
  });
  await drainQueue(background);

  assert.equal(launches.length, 0, "节点缺失时不得启动 Chrome");
  const final = operations.get(operation.id);
  assert.equal(final.state, "cancelled");
  assert.match(final.message, /分组绑定的代理节点不可用/);
});

test("节点被停用仍然取消，且不启动 Chrome", async () => {
  const { background, launches, operations } = await composeFake({
    getProxyNodes: () => [{ id: "node-1", enabled: false, missing: false }],
  });

  const operation = background.enqueue({
    accountId: "acc-1",
    workKind: "account-run",
    kind: "account-run",
  });
  await drainQueue(background);

  assert.equal(launches.length, 0, "节点停用时不得启动 Chrome");
  assert.equal(operations.get(operation.id).state, "cancelled");
});

test("调度任务终态把 lastAt / lastResult 写回并通知，成功与失败都算", async () => {
  const { SchedulerService } = await import("../src/scheduler.js");
  for (const scenario of [
    { ok: true, runOnce: async () => ({ ok: true }), expectState: "succeeded" },
    { ok: false, runOnce: async () => ({ ok: false, reason: "登录已失效" }), expectState: "failed" },
  ]) {
    const saved = [];
    const notified = [];
    const accountTable = {};
    const scheduler = new SchedulerService({
      getSettings: () => ({ intervalMinutes: 180, jitterMinutes: 30, headless: true }),
      getAccounts: () => [{ id: "acc-1", enabled: true }],
      getAccount: (id) => ({ id, enabled: true }),
      log: { info() {}, warn() {}, error() {} },
      // 有状态：真实的 SQLite 适配器读得到刚写进去的值，而 noteCompleted 正是靠
      // 读回 nextAt 才不会把 onDue 的预排清掉。无状态的替身测不出这件事。
      persistence: {
        load: () => ({ enabled: true, accounts: { ...accountTable } }),
        setEnabled: () => {},
        saveAccount: (accountId, state) => {
          accountTable[accountId] = { ...state };
          saved.push({ accountId, ...state });
        },
      },
    });
    scheduler.subscribe((change) => notified.push(change));

    const { background, launches } = await composeFake({
      scheduler,
      runOnce: scenario.runOnce,
    });
    // scheduled 条目受调度状态约束：running 为假会被复验判为「调度已停止」。
    // 这里要测的是节点复验与状态回写，所以先让调度真的处于运行中。
    // 必须交出时钟：否则 start() 会去拉 legacy 账号循环，直连 runOnce。
    scheduler.configureClock(background.clock, () => background.queue.bumpSchedulerEpoch());
    scheduler.start();
    background.clock.schedule("acc-1", Date.now() - 1);
    await drainAfterClock(background);
    await scheduler.stop();

    assert.equal(launches.length, 1, "调度到期必须启动一次");
    // §6.5：跑完只写一次，result / lastAt / nextAt 一起落盘，不留中间态。
    assert.equal(saved.length, 1, `应恰好落盘一次，实际 ${saved.length}`);
    const last = saved.at(-1);
    assert.ok(last.lastAt, "终态必须写下 lastAt");
    assert.ok(Date.parse(last.nextAt) > Date.now(), "终态必须同时写下未来的 nextAt");
    assert.equal(last.lastResult.ok, scenario.ok);
    assert.equal(last.lastResultState, scenario.expectState === "succeeded" ? "succeeded" : "failed");
    if (!scenario.ok) assert.match(last.lastResult.reason, /登录已失效/);
    // 不通知的话桌面端拿不到 scheduler.accountChanged 推送，只能靠全量拉取。
    assert.ok(
      notified.some((change) => change.kind === "account" && change.accountId === "acc-1"),
      "每次落盘都必须通知订阅者"
    );
  }
});

test("自动任务因代理节点缺失被排队期取消时，结算为一次真实的运行失败", async () => {
  const { SchedulerService } = await import("../src/scheduler.js");
  const accountTable = {};
  const saved = [];
  const scheduler = new SchedulerService({
    getSettings: () => ({ intervalMinutes: 180, jitterMinutes: 30, headless: true }),
    getAccounts: () => [{ id: "acc-1", enabled: true }],
    getAccount: (id) => ({ id, enabled: true }),
    log: { info() {}, warn() {}, error() {} },
    persistence: {
      load: () => ({ enabled: true, accounts: { ...accountTable } }),
      setEnabled: () => {},
      saveAccount: (accountId, state) => {
        accountTable[accountId] = { ...state };
        saved.push({ accountId, ...state });
      },
    },
  });

  const { background, launches } = await composeFake({
    scheduler,
    getProxyNodes: () => [{ id: "node-1", enabled: true, missing: true }],
  });
  scheduler.configureClock(background.clock, () => background.queue.bumpSchedulerEpoch());
  scheduler.start();
  // 必须经时钟：重排只对时钟发出的到期意图生效（pendingDue），直接 submit 的
  // scheduled 条目不算一次到期。间隔 180 分钟，所以只会到期一次。
  background.clock.schedule("acc-1", Date.now() - 1);
  for (let i = 0; i < 120 && saved.filter((row) => row.lastAt).length === 0; i++) await settle();
  await scheduler.stop();

  assert.equal(launches.length, 0, "节点缺失不得启动 Chrome");
  // 健康校验失败是这一轮的真实结果：不写的话用户只看到「什么都没发生」。
  const settled = saved.filter((row) => row.lastAt);
  assert.equal(settled.length, 1, `应恰好结算一次，实际 ${settled.length}`);
  assert.equal(settled[0].lastResult.ok, false);
  assert.equal(settled[0].lastResultState, "failed");
  assert.match(settled[0].lastResult.reason, /分组绑定的代理节点不可用/);
});

test("scheduler.stop 与账号停用不得污染自动运行结果", async () => {
  for (const scenario of [
    { name: "stop", accounts: [{ id: "acc-1", enabled: true }], stop: true },
    { name: "disabled", accounts: [{ id: "acc-1", enabled: false }], stop: false },
  ]) {
    const saved = [];
    const { background, operations } = await composeFake({
      store: fakeStore(scenario.accounts),
      scheduler: {
        running: true,
        nextAtFromNow: (now) => now + 60_000,
        noteScheduled: () => {},
        noteCompleted: (accountId, state) => saved.push({ accountId, ...state }),
      },
    });

    // submit 会同步 pump，条目会立刻开跑并按成功结算——那测不到生命周期取消。
    // 先暂停准入，让它确实停在排队期，再制造生命周期事件。
    background.slots.pauseAdmission();
    background.queue.submit({
      accountId: "acc-1",
      workKind: "account-run",
      source: "scheduled",
      kind: "account-run",
    });
    if (scenario.stop) background.queue.cancelQueuedBySource(["scheduled"], "调度已停止");
    background.slots.resumeAdmission();
    await drainQueue(background);

    assert.equal(
      saved.length,
      0,
      `${scenario.name} 属于生命周期，不得写入 lastResult（实际写了 ${saved.length} 次）`
    );
    assert.equal(operations.list?.().length ?? 1, 1);
  }
});

test("排期时刻走调度器的 interval±jitter，不是固定间隔", async () => {
  const { SchedulerService } = await import("../src/scheduler.js");
  const scheduled = [];
  // 固定 secureRandom：抖动是确定的，断言不依赖真实随机。
  const scheduler = new SchedulerService({
    getSettings: () => ({ intervalMinutes: 100, jitterMinutes: 10, headless: true }),
    getAccounts: () => [{ id: "acc-1", enabled: true }],
    getAccount: (id) => ({ id, enabled: true }),
    secureRandom: () => 1, // jitter 取满 +10 分钟
    log: { info() {}, warn() {}, error() {} },
    persistence: {
      load: () => ({ enabled: true, accounts: {} }),
      setEnabled: () => {},
      saveAccount: (accountId, state) => scheduled.push({ accountId, ...state }),
    },
  });

  const { background } = await composeFake({ scheduler });
  scheduler.configureClock(background.clock, () => background.queue.bumpSchedulerEpoch());
  scheduler.start();
  const before = Date.now();
  background.clock.schedule("acc-1", Date.now() - 1);
  for (let i = 0; i < 120 && scheduled.length === 0; i++) await settle();
  await scheduler.stop();

  assert.ok(scheduled.length >= 1, "到期必须预排下次时间");
  const nextAt = Date.parse(scheduled[0].nextAt);
  // 100 分钟 + 满抖动 10 分钟 = 110 分钟；固定 interval 实现只会给 100 分钟。
  const deltaMin = (nextAt - before) / 60_000;
  assert.ok(deltaMin > 105 && deltaMin <= 111, `应约 110 分钟（含抖动），实际 ${deltaMin}`);
});

test("长任务：终态之前不预排，终态之后恰好排一次（§6.5）", async () => {
  const noted = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { background } = await composeFake({
    scheduler: fakeScheduler({
      noteScheduled: (accountId, state) => noted.push({ kind: "scheduled", accountId, ...state }),
      noteCompleted: (accountId, state) => noted.push({ kind: "completed", accountId, ...state }),
    }),
    runOnce: async () => {
      await gate;
      return { ok: true };
    },
  });

  background.clock.schedule("acc-1", Date.now() - 1);
  background.clock.start();
  for (let i = 0; i < 120 && background.queue.activeCount() === 0; i++) await settle();

  // 任务还在跑：旧实现此刻已经按"开始时刻 + interval"排好了下一次，窗口提前滚动。
  assert.equal(noted.length, 0, "终态之前不得排下次时间");
  assert.equal(background.clock.dueAt("acc-1"), null, "时钟里不得有预排条目");

  release();
  await drainQueue(background);
  background.clock.stop();

  // 恰好一次，且结果与 nextAt 一起写完。
  assert.equal(noted.length, 1, `终态后只排一次，实际 ${noted.length}`);
  assert.equal(noted[0].kind, "completed");
  assert.equal(noted[0].result.ok, true);
  assert.ok(noted[0].nextAt > Date.now(), "nextAt 必须随结果一次写入");
  assert.ok(background.clock.dueAt("acc-1") > Date.now(), "下次时间必须进时钟");
});

test("到期意图被已有 manual 条目合并时，只排下次时间，不写成自动运行结果", async () => {
  const noted = [];
  let started = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { background } = await composeFake({
    scheduler: fakeScheduler({
      noteScheduled: (accountId, state) => noted.push({ kind: "scheduled", accountId, ...state }),
      noteCompleted: (accountId, state) => noted.push({ kind: "completed", accountId, ...state }),
    }),
    runOnce: async () => {
      started = true;
      await gate;
      return { ok: true };
    },
  });

  // 让 manual 条目停在运行中，再让同一账号到期：去重把到期意图并进这条正在跑的
  // 条目，effectiveSource 保持 manual（manual 优先级更高，不会被降级）。
  background.enqueue({ accountId: "acc-1", workKind: "account-run", kind: "account-run" });
  for (let i = 0; i < 120 && !started; i++) await settle();
  assert.equal(started, true, "manual 条目必须已在运行");

  background.clock.schedule("acc-1", Date.now() - 1);
  background.clock.start();
  for (let i = 0; i < 60 && background.clock.dueAt("acc-1") !== null; i++) await settle();
  assert.equal(background.clock.dueAt("acc-1"), null, "时钟必须已发出到期意图");

  release();
  await drainQueue(background);
  background.clock.stop();

  // 手动跑出来的结果不是自动运行结果：只排下次时间。
  assert.equal(noted.length, 1, `应只结算一次，实际 ${noted.length}`);
  assert.equal(noted[0].kind, "scheduled", "不得把手动结果写成自动运行结果");
  assert.ok(noted[0].nextAt > Date.now());
});

test("到期意图并入 manual 后遇到生命周期取消时不重排", async () => {
  const noted = [];
  let started = false;
  const { background } = await composeFake({
    scheduler: fakeScheduler({
      noteScheduled: (accountId, state) => noted.push({ accountId, ...state }),
      noteCompleted: (accountId, state) => noted.push({ accountId, ...state }),
    }),
    runOnce: async (_account, { signal }) =>
      new Promise((resolve, reject) => {
        started = true;
        signal.addEventListener("abort", () => reject(new CancelledError("Agent 正在退出")), {
          once: true,
        });
      }),
  });

  background.enqueue({ accountId: "acc-1", workKind: "account-run", kind: "account-run" });
  for (let i = 0; i < 120 && !started; i++) await settle();
  background.clock.schedule("acc-1", Date.now() - 1);
  background.clock.start();
  for (let i = 0; i < 60 && background.clock.dueAt("acc-1") !== null; i++) await settle();

  background.queue.signalAllActive("Agent 正在退出");
  await drainQueue(background);
  background.clock.stop();

  assert.equal(noted.length, 0, "生命周期取消不得写结果或排下次时间");
  assert.equal(background.clock.dueAt("acc-1"), null, "生命周期取消不得重新装入时钟");
});

test("逾期恢复：future 保持原值，overdue 按原始顺序补跑", async () => {
  const { background } = await composeFake();
  const now = Date.now();
  const persisted = {
    "acc-2": { nextAt: new Date(now + 3_600_000).toISOString() },
    "acc-3": { nextAt: new Date(now - 1_000).toISOString() },
  };
  const plan = background.planOverdueRecovery(persisted, now);

  assert.deepEqual(plan.future.map((entry) => entry.accountId), ["acc-2"]);
  assert.equal(plan.future[0].nextAt, Date.parse(persisted["acc-2"].nextAt), "future 原值不得变");
  assert.deepEqual(plan.overdue.map((entry) => entry.accountId), ["acc-3"]);
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
