import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleClock, planOverdueRecovery } from "../src/scheduleClock.js";

function fakeClock() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      // Fire every timer whose deadline has passed, in deadline order.
      for (;;) {
        const ready = timers
          .filter((timer) => !timer.cancelled && timer.firesAt <= now)
          .sort((a, b) => a.firesAt - b.firesAt);
        if (!ready.length) break;
        const timer = ready[0];
        timer.cancelled = true;
        timer.fn();
      }
    },
    setTimeout(fn, ms) {
      const timer = { fn, firesAt: now + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

test("单一定时器：多个账号不产生每账号一个定时器", () => {
  const clock = fakeClock();
  const fired = [];
  const scheduler = new ScheduleClock({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onDue: (accountId) => fired.push(accountId),
  });
  scheduler.start();
  for (let i = 0; i < 50; i++) {
    scheduler.schedule(`acc-${i}`, clock.now() + 60_000 + i);
  }
  // The old design ran one loop per account; the point of this rewrite is that 50
  // accounts still need only a single outstanding timer.
  assert.equal(clock.pending(), 1, `应只有一个未触发定时器，实际 ${clock.pending()}`);
  assert.equal(fired.length, 0);
});

test("到期账号按 nextAt 升序 FIFO 交给队列", () => {
  const clock = fakeClock();
  const fired = [];
  const scheduler = new ScheduleClock({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onDue: (accountId) => fired.push(accountId),
  });
  scheduler.start();
  scheduler.schedule("late", clock.now() + 3_000);
  scheduler.schedule("early", clock.now() + 1_000);
  scheduler.schedule("middle", clock.now() + 2_000);

  clock.advance(3_500);
  assert.deepEqual(fired, ["early", "middle", "late"]);
});

test("更早的到期时间会重排定时器", () => {
  const clock = fakeClock();
  const fired = [];
  const scheduler = new ScheduleClock({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onDue: (accountId) => fired.push(accountId),
  });
  scheduler.start();
  scheduler.schedule("far", clock.now() + 600_000);
  scheduler.schedule("soon", clock.now() + 500);
  clock.advance(600);
  assert.deepEqual(fired, ["soon"], "插入更早的到期时间必须让定时器提前触发");
});

test("stop 后不再触发，unschedule 移除账号", () => {
  const clock = fakeClock();
  const fired = [];
  const scheduler = new ScheduleClock({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onDue: (accountId) => fired.push(accountId),
  });
  scheduler.start();
  scheduler.schedule("a", clock.now() + 1_000);
  scheduler.schedule("b", clock.now() + 1_000);
  scheduler.unschedule("a");
  scheduler.stop();
  clock.advance(5_000);
  assert.deepEqual(fired, []);
});

test("retainOnly 移除已停用账号", () => {
  const clock = fakeClock();
  const scheduler = new ScheduleClock({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  scheduler.start();
  scheduler.schedule("keep", clock.now() + 1_000);
  scheduler.schedule("drop", clock.now() + 1_000);
  const removed = scheduler.retainOnly(["keep"]);
  assert.deepEqual(removed, ["drop"]);
  assert.equal(scheduler.dueAt("drop"), null);
  assert.ok(scheduler.dueAt("keep"));
});

test("逾期恢复按原始 nextAt 从早到晚，且区分未来任务", () => {
  const now = 2_000_000;
  const plan = planOverdueRecovery(
    {
      c: { nextAt: new Date(now - 1_000).toISOString() },
      a: { nextAt: new Date(now - 50_000).toISOString() },
      b: { nextAt: new Date(now - 20_000).toISOString() },
      future: { nextAt: new Date(now + 10_000).toISOString() },
      broken: { nextAt: "not-a-date" },
    },
    now
  );
  // Original nextAt order, earliest first: no 5-minute bulk window, no catch-up of
  // multiple historical periods.
  assert.deepEqual(plan.overdue.map((entry) => entry.accountId), ["a", "b", "c"]);
  assert.deepEqual(plan.future.map((entry) => entry.accountId), ["future"]);
});
