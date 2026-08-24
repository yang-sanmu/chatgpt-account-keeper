import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRunRegistry, purposeFor } from "../src/application/browserRuns.js";
import { SlotManager } from "../src/application/resourceSlots.js";
import {
  isBusy,
  isQuarantined,
  resetLocksForTest,
  tryAcquire,
} from "../src/locks.js";

/**
 * Fake broker. Models the real one's contract exactly, including the tombstone that
 * makes a lost dispose ack recoverable, so the registry can be exercised without Chrome.
 */
class FakeBroker {
  constructor(options = {}) {
    this.running = true;
    this.active = new Map(); // token -> { count }
    this.tombstones = new Set();
    this.forgotten = [];
    this.disposeFailsOnce = options.disposeFailsOnce ?? false;
    this.stuckTokens = new Set(options.stuckTokens ?? []);
    this.dropDisposeAck = options.dropDisposeAck ?? false;
    this.calls = [];
  }

  launchFake(token, count = 5) {
    this.active.set(token, { count });
  }

  async terminate(token) {
    this.calls.push(["terminate", token]);
    const entry = this.active.get(token);
    // A stuck token models a root that refuses to die: the count never reaches zero.
    if (entry && !this.stuckTokens.has(token)) entry.count = 0;
    return { ok: true };
  }

  async enumerate(token) {
    this.calls.push(["enumerate", token]);
    if (this.tombstones.has(token)) {
      return { ok: true, count: 0, pids: [], disposed: true, rootAlive: false };
    }
    const entry = this.active.get(token);
    if (!entry) return { ok: false, code: "UNKNOWN_TOKEN", count: null, pids: [], disposed: false };
    return { ok: true, count: entry.count, pids: [], disposed: false, rootAlive: entry.count > 0 };
  }

  async waitForEmpty(token, _timeoutMs) {
    const listed = await this.enumerate(token);
    return listed;
  }

  async dispose_(token) {
    this.calls.push(["dispose", token]);
    if (this.tombstones.has(token)) return { ok: true, disposed: true, count: 0 };
    const entry = this.active.get(token);
    if (!entry) return { ok: false, code: "UNKNOWN_TOKEN" };
    if (entry.count !== 0) return { ok: false, code: "JOB_NOT_EMPTY", count: entry.count };
    if (this.disposeFailsOnce) {
      this.disposeFailsOnce = false;
      return { ok: false, code: "INTERNAL", message: "injected dispose failure" };
    }
    this.active.delete(token);
    this.tombstones.add(token);
    if (this.dropDisposeAck) {
      // The dispose really happened; only the response is lost.
      return { ok: false, code: "CHROME_BROKER_TIMEOUT", message: "ack lost" };
    }
    return { ok: true, disposed: true, count: 0 };
  }

  async forget(token) {
    this.calls.push(["forget", token]);
    this.tombstones.delete(token);
    this.forgotten.push(token);
    return { ok: true, disposed: true };
  }
}

function setup(brokerOptions = {}) {
  const events = { published: [], publish(name, payload) { this.published.push({ name, payload }); } };
  const broker = new FakeBroker(brokerOptions);
  const timers = [];
  const registry = new BrowserRunRegistry({
    events,
    broker,
    log: { warn() {}, error() {}, info() {} },
    // Rechecks are driven manually so the tests stay deterministic.
    setTimeout: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimeout: () => {},
  });
  const slots = new SlotManager({ launchIntervalMs: 0 });
  return { registry, broker, slots, events, timers };
}

function startRun(registry, slots, accountId, token, options = {}) {
  const chromeSlot = options.chromeSlot ?? null;
  const accountLockHandle = tryAcquire(accountId, { owner: "queue" });
  assert.ok(accountLockHandle, `应能取得 ${accountId} 的账号锁`);
  const workSlot = slots.tryAcquireWorkSlot();
  const run = registry.register({
    accountId,
    operationId: `op-${accountId}`,
    purpose: "scheduled-run",
    workKind: "account-run",
    effectiveSource: "scheduled",
    launcherRunToken: token,
    accountLockHandle,
    chromeSlot,
    workSlot,
  });
  registry.attachLaunch(run.browserRunId, { rootPid: 4242, rootStartTime: 111 });
  registry.markRunning(run.browserRunId, options.context ?? null);
  return run;
}

test("purpose 按最终有效来源映射，被提升的自动条目显示为 manual-run", () => {
  assert.equal(purposeFor("account-run", "scheduled"), "scheduled-run");
  assert.equal(purposeFor("account-run", "manual"), "manual-run");
  assert.equal(purposeFor("status-check", "background"), "status-check");
  assert.equal(purposeFor("selector-check", "manual"), "selector-check");
});

test("closed：Job 计数归零 + dispose ack 后释放 Chrome 槽与账号锁", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup();
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-a" });
  broker.launchFake("tok-a", 6);
  const run = startRun(registry, slots, "acc-a", "tok-a", { chromeSlot });

  const closed = await registry.close(run.browserRunId, "test");
  assert.equal(closed.state, "closed");
  assert.equal(registry.chromeOccupancy, 0, "closed 后必须释放 Chrome 容量");
  assert.equal(isBusy("acc-a"), false, "closed 后账号锁必须释放");
  assert.equal(slots.snapshot().chromeSlots.used, 0);
  assert.equal(slots.snapshot().workSlots.used, 0);
});

test("Browser.close 后自然退出时不再 terminate，给 Profile 完整落盘机会", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup();
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-graceful" });
  broker.launchFake("tok-graceful", 4);
  const context = {
    close: async () => {
      broker.active.get("tok-graceful").count = 0;
    },
  };
  const run = startRun(registry, slots, "acc-graceful", "tok-graceful", {
    chromeSlot,
    context,
  });

  const closed = await registry.close(run.browserRunId, "login-complete");

  assert.equal(closed.state, "closed");
  assert.equal(
    broker.calls.filter(([name]) => name === "terminate").length,
    0,
    "已经自然退出的 Chrome 不能再被强制终止"
  );
  assert.equal(
    broker.calls.filter(([name]) => name === "dispose").length,
    1
  );
});

test("close_failed：计数未归零则保留 Chrome 容量与账号锁 quarantine", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup({ stuckTokens: ["tok-b"] });
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-b" });
  broker.launchFake("tok-b", 3);
  const run = startRun(registry, slots, "acc-b", "tok-b", { chromeSlot });

  const result = await registry.close(run.browserRunId, "test");
  assert.equal(result.state, "close_failed");
  // Releasing capacity here is what would let a 5th Chrome start behind 4 zombies.
  assert.equal(registry.chromeOccupancy, 1, "close_failed 必须继续占用 Chrome 容量");
  assert.equal(slots.snapshot().chromeSlots.used, 1);
  // The account lock stays owned by quarantine: only setting a flag and releasing the
  // lock would let Profile maintenance touch a profile a zombie Chrome still locks.
  assert.equal(isQuarantined("acc-b"), true);
  assert.equal(isBusy("acc-b"), true, "quarantine 必须让 isBusy 继续为真");
  assert.equal(tryAcquire("acc-b", { owner: "maintenance" }), null, "隔离期间任何消费者都不得取得账号锁");
  // The work slot is released so queue throughput is not eaten by the zombie.
  assert.equal(slots.snapshot().workSlots.used, 0);
});

test("close_failed 后自愈复验成功则释放容量并解除隔离", async () => {
  resetLocksForTest();
  const { registry, broker, slots, timers } = setup({ stuckTokens: ["tok-c"] });
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-c" });
  broker.launchFake("tok-c", 2);
  const run = startRun(registry, slots, "acc-c", "tok-c", { chromeSlot });
  await registry.close(run.browserRunId, "test");
  assert.equal(isQuarantined("acc-c"), true);

  // The stuck process finally dies; the next recheck must converge.
  broker.stuckTokens.delete("tok-c");
  assert.ok(timers.length > 0, "close_failed 必须安排复验");
  const recheck = await registry.recheck(run.browserRunId);
  assert.equal(recheck.state, "closed");
  assert.equal(registry.chromeOccupancy, 0);
  assert.equal(isQuarantined("acc-c"), false);
  assert.equal(isBusy("acc-c"), false);
  assert.equal(slots.snapshot().chromeSlots.used, 0);
});

test("dispose ack 丢失：tombstone 幂等响应作为收敛证明，不永久 quarantine", async () => {
  resetLocksForTest();
  const { registry, broker, slots, timers } = setup({ dropDisposeAck: true });
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-d" });
  broker.launchFake("tok-d", 4);
  const run = startRun(registry, slots, "acc-d", "tok-d", { chromeSlot });

  // First attempt: dispose actually succeeded inside the broker but the ack was lost.
  const first = await registry.close(run.browserRunId, "test");
  assert.equal(first.state, "close_failed");
  assert.equal(isQuarantined("acc-d"), true);
  assert.ok(broker.tombstones.has("tok-d"), "broker 侧应已写入 tombstone");

  // The recheck must converge via the idempotent tombstone answer rather than getting
  // UNKNOWN_TOKEN and quarantining the account forever.
  assert.ok(timers.length > 0);
  const recovered = await registry.recheck(run.browserRunId);
  assert.equal(recovered.state, "closed");
  assert.equal(isQuarantined("acc-d"), false);
  assert.equal(registry.chromeOccupancy, 0);
});

test("dispose 失败一次则先 close_failed，复验后收敛", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup({ disposeFailsOnce: true });
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-e" });
  broker.launchFake("tok-e", 1);
  const run = startRun(registry, slots, "acc-e", "tok-e", { chromeSlot });
  const first = await registry.close(run.browserRunId, "test");
  assert.equal(first.state, "close_failed", "计数归零但 dispose 未确认也必须是 close_failed");
  const recovered = await registry.recheck(run.browserRunId);
  assert.equal(recovered.state, "closed");
});

test("重复关闭请求复用同一个关闭 Promise", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup();
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-f" });
  broker.launchFake("tok-f", 2);
  const run = startRun(registry, slots, "acc-f", "tok-f", { chromeSlot });
  const [a, b] = await Promise.all([
    registry.close(run.browserRunId, "first"),
    registry.close(run.browserRunId, "second"),
  ]);
  assert.deepEqual(a, b);
  const terminates = broker.calls.filter(([name]) => name === "terminate").length;
  assert.equal(terminates, 1, "重复请求不应重复执行关闭序列");
});

test("优雅关闭抛错但树已消失：只记 closeError，仍判 closed", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup();
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-g" });
  broker.launchFake("tok-g", 2);
  const context = { close: async () => { throw new Error("context.close 爆了"); } };
  const run = startRun(registry, slots, "acc-g", "tok-g", { chromeSlot, context });
  const closed = await registry.close(run.browserRunId, "test");
  assert.equal(closed.state, "closed", "关闭噪声不得掩盖已完成的回收");
  assert.match(closed.closeError, /context\.close/);
});

test("closing 起冻结 effectiveSource 与 purpose", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup({ stuckTokens: ["tok-h"] });
  const chromeSlot = await slots.acquireChromeSlot({ label: "acc-h" });
  broker.launchFake("tok-h", 2);
  const run = startRun(registry, slots, "acc-h", "tok-h", { chromeSlot });
  assert.equal(registry.updateEffectiveSource(run.browserRunId, "manual"), true);
  assert.equal(registry.get(run.browserRunId).purpose, "manual-run");

  await registry.close(run.browserRunId, "test");
  // close_failed records are shown as blockers for a long time; their purpose must stay
  // the truth at the moment of the incident.
  assert.equal(registry.updateEffectiveSource(run.browserRunId, "scheduled"), false);
  assert.equal(registry.get(run.browserRunId).purpose, "manual-run");
});

test("close_failed 留在 active，closed 转入 recent", async () => {
  resetLocksForTest();
  const { registry, broker, slots } = setup({ stuckTokens: ["tok-j"] });
  const okSlot = await slots.acquireChromeSlot({ label: "acc-ok" });
  const badSlot = await slots.acquireChromeSlot({ label: "acc-bad" });
  broker.launchFake("tok-i", 1);
  broker.launchFake("tok-j", 1);
  const good = startRun(registry, slots, "acc-ok", "tok-i", { chromeSlot: okSlot });
  const bad = startRun(registry, slots, "acc-bad", "tok-j", { chromeSlot: badSlot });
  await registry.close(good.browserRunId, "test");
  await registry.close(bad.browserRunId, "test");

  const active = registry.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].state, "close_failed");
  assert.ok(registry.listRecent().some((run) => run.state === "closed"));
  assert.equal(registry.unresolved().length, 1, "未回收的 run 必须阻止关库");
});
