import test from "node:test";
import assert from "node:assert/strict";
import {
  BackgroundQueue,
  SOURCES,
  STAGES,
  WORK_KINDS,
} from "../src/application/backgroundQueue.js";
import { SlotManager } from "../src/application/resourceSlots.js";
import { OperationRegistry } from "../src/application/operations.js";
import {
  isBusy,
  markHeld,
  releaseHeld,
  resetLocksForTest,
  withAccountLock,
} from "../src/locks.js";

function harness(options = {}) {
  const events = { published: [], publish(name, payload) { this.published.push({ name, payload }); } };
  const operations = new OperationRegistry({ events });
  const slots = new SlotManager({
    workSlots: options.workSlots ?? 4,
    chromeSlots: options.chromeSlots ?? 4,
    launchIntervalMs: 0,
  });
  const queue = new BackgroundQueue({ operations, events, slots, log: { warn() {}, error() {}, info() {} } });
  return { events, operations, slots, queue };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("manual run 与 scheduled run 去重到同一条并提升 effectiveSource", async () => {
  resetLocksForTest();
  const { queue, operations } = harness();
  const gate = { resolve: null };
  const started = new Promise((resolve) => { gate.resolve = resolve; });
  queue.registerHandler(WORK_KINDS.accountRun, async () => {
    gate.resolve();
    return { ok: true };
  });

  const scheduled = queue.submit({
    accountId: "acc-1",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.scheduled,
    kind: "account-run",
  });
  const manual = queue.submit({
    accountId: "acc-1",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.manual,
    kind: "account-run",
  });

  // Same dedupe key: manual must reuse the scheduled entry rather than create a second
  // run for the same account, and the intent must be promoted.
  assert.equal(manual.id, scheduled.id);
  await started;
  await settle();
  assert.equal(operations.get(scheduled.id).effectiveSource, SOURCES.manual);
});

test("不同 workKind 在账号忙时各自成条目，不合并也不提升", async () => {
  resetLocksForTest();
  const { queue } = harness();
  queue.registerHandler(WORK_KINDS.accountRun, async () => ({ ok: true }));
  queue.registerHandler(WORK_KINDS.statusCheck, async () => ({ ok: true }));
  const run = queue.submit({
    accountId: "acc-2",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.scheduled,
  });
  const status = queue.submit({
    accountId: "acc-2",
    workKind: WORK_KINDS.statusCheck,
    source: SOURCES.manual,
  });
  assert.notEqual(run.id, status.id);
});

test("selector-check 的 depth 进 dedupe key，page 与 conversation 不合并", () => {
  resetLocksForTest();
  const { queue } = harness();
  queue.registerHandler(WORK_KINDS.selectorCheck, async () => ({ ok: true }));
  const shallow = queue.submit({
    accountId: "acc-3",
    workKind: WORK_KINDS.selectorCheck,
    dedupeParams: { depth: "page" },
    source: SOURCES.manual,
  });
  const deep = queue.submit({
    accountId: "acc-3",
    workKind: WORK_KINDS.selectorCheck,
    dedupeParams: { depth: "conversation" },
    source: SOURCES.manual,
  });
  // conversation depth really posts a message; merging it into a page-depth request
  // would produce a side effect the caller never asked for.
  assert.notEqual(shallow.id, deep.id);
});

test("scheduler.stop 只取消仍为 scheduled 的条目，被提升为 manual 的不取消", async () => {
  resetLocksForTest();
  const { queue, operations, slots } = harness();
  slots.pauseAdmission();
  queue.registerHandler(WORK_KINDS.accountRun, async () => ({ ok: true }));

  const promoted = queue.submit({
    accountId: "acc-4",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.scheduled,
  });
  queue.submit({
    accountId: "acc-4",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.manual,
  });
  const staysScheduled = queue.submit({
    accountId: "acc-5",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.scheduled,
  });

  queue.cancelQueuedBySource([SOURCES.scheduled], "调度已停止");
  assert.equal(operations.get(staysScheduled.id).state, "cancelled");
  assert.equal(operations.get(promoted.id).state, "queued");
});

test("blocksUpdate 随资源持有双向变化：try-lock 失败退回时回落 false", async () => {
  resetLocksForTest();
  const { queue, operations } = harness();
  queue.registerHandler(WORK_KINDS.accountRun, async () => ({ ok: true }));

  // Hold the account the way an open page does, so try-lock must fail.
  markHeld("acc-6");
  const entry = queue.submit({
    accountId: "acc-6",
    workKind: WORK_KINDS.accountRun,
    source: SOURCES.scheduled,
  });
  await settle();
  const afterBounce = operations.get(entry.id);
  assert.equal(afterBounce.stage, STAGES.waitingAccount);
  assert.equal(
    afterBounce.blocksUpdate,
    false,
    "退回等待账号锁时必须回落 blocksUpdate，否则会留下不持任何资源的假 blocker"
  );

  releaseHeld("acc-6");
  await settle();
  await settle();
});

test("纯 queued 场景下 50 条排队条目都不是 blocker", () => {
  resetLocksForTest();
  const { queue, operations, slots } = harness();
  slots.pauseAdmission();
  queue.registerHandler(WORK_KINDS.accountRun, async () => ({ ok: true }));
  const ids = [];
  for (let i = 0; i < 50; i++) {
    ids.push(queue.submit({
      accountId: `bulk-${i}`,
      workKind: WORK_KINDS.accountRun,
      source: SOURCES.scheduled,
    }).id);
  }
  const blockers = ids.filter((id) => operations.get(id).blocksUpdate);
  assert.deepEqual(blockers, [], "准入暂停时不应有任何条目持有资源");
  assert.equal(operations.listActive().filter((op) => op.blocksUpdate).length, 0);
});

test("工作槽上限为 4：第 5 个条目留在队列里", async () => {
  resetLocksForTest();
  const { queue, slots } = harness({ workSlots: 4 });
  let running = 0;
  let peak = 0;
  const release = [];
  queue.registerHandler(WORK_KINDS.accountRun, async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => release.push(resolve));
    running--;
    return { ok: true };
  });
  for (let i = 0; i < 8; i++) {
    queue.submit({
      accountId: `slot-${i}`,
      workKind: WORK_KINDS.accountRun,
      source: SOURCES.scheduled,
    });
  }
  await settle();
  await settle();
  assert.equal(peak, 4, `并发峰值应为 4，实际 ${peak}`);
  assert.equal(slots.snapshot().workSlots.used, 4);
  for (const resolve of release.splice(0)) resolve();
  await settle();
});

test("语义复验：账号停用取消该条目，无关账号不受影响", () => {
  resetLocksForTest();
  const { queue, operations, slots } = harness();
  slots.pauseAdmission();
  const disabled = new Set();
  queue.configureRevalidate(({ accountId }) =>
    disabled.has(accountId) ? { ok: false, reason: "账号已删除或已停用" } : { ok: true }
  );
  queue.registerHandler(WORK_KINDS.accountRun, async () => ({ ok: true }));
  const doomed = queue.submit({ accountId: "gone", workKind: WORK_KINDS.accountRun, source: SOURCES.scheduled });
  const healthy = queue.submit({ accountId: "fine", workKind: WORK_KINDS.accountRun, source: SOURCES.scheduled });

  disabled.add("gone");
  queue.bumpConfigEpoch();

  assert.equal(operations.get(doomed.id).state, "cancelled");
  assert.equal(operations.get(doomed.id).message, "账号已删除或已停用");
  assert.equal(operations.get(healthy.id).state, "queued");
});

test("withAccountLock 释放也会唤醒队列的 try-lock 等待者", async () => {
  resetLocksForTest();
  const { queue } = harness();
  let ran = false;
  queue.registerHandler(WORK_KINDS.accountRun, async () => {
    ran = true;
    return { ok: true };
  });

  let releaseLock;
  const holding = new Promise((resolve) => { releaseLock = resolve; });
  const lockTask = withAccountLock("acc-7", () => holding);
  assert.equal(isBusy("acc-7"), true);

  queue.submit({ accountId: "acc-7", workKind: WORK_KINDS.accountRun, source: SOURCES.scheduled });
  await settle();
  assert.equal(ran, false, "账号锁被 withAccountLock 持有时不应准入");

  releaseLock();
  await lockTask;
  await settle();
  await settle();
  assert.equal(ran, true, "onRelease 必须无条件触发，否则会漏掉 withAccountLock 的释放");
});

test("队列快照报告阶段、槽位与来源分组", () => {
  resetLocksForTest();
  const { queue, slots } = harness();
  slots.pauseAdmission();
  queue.registerHandler(WORK_KINDS.accountRun, async () => ({ ok: true }));
  queue.submit({ accountId: "s-1", workKind: WORK_KINDS.accountRun, source: SOURCES.scheduled });
  queue.submit({ accountId: "s-2", workKind: WORK_KINDS.accountRun, source: SOURCES.manual });
  const snapshot = queue.snapshot();
  assert.equal(snapshot.queuedTotal, 2);
  assert.equal(snapshot.workSlots.limit, 4);
  assert.equal(snapshot.chromeSlots.limit, 4);
  assert.equal(snapshot.bySource.scheduled, 1);
  assert.equal(snapshot.bySource.manual, 1);
  assert.equal(snapshot.admissionPaused, true);
});
