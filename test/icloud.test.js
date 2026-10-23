import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IcloudManager } from "../src/icloud/manager.js";
import { ICLOUD_DEFAULT_CONFIG, IcloudError, HOUR, classifyIcloudFailure, retryAfterTime, parseIcloudList, initialIcloudData, SqliteIcloudStore } from "../src/icloud/model.js";
import { IcloudBrowser, hmeEndpoint } from "../src/icloud/browser.js";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { assertRequestContract, assertMethodResultContract, assertOutgoingContract } from "../src/agent/contractValidator.js";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const raw = (id = "old", extra = {}) => ({ origin: "ON_DEMAND", anonymousId: id, domain: "", forwardToEmail: "private@example.com",
  hme: `${id}@example.com`, label: "G", note: "云端备注", createTimestamp: NOW - 2 * HOUR, isActive: true, recipientMailId: "", ...extra });
const payload = rows => ({ success: true, timestamp: NOW / 1000, result: { hmeEmails: rows, forwardToEmails: [], selectedForwardTo: "private@example.com" } });

function fixture(t, overrides = {}) {
  let now = NOW; let saved = structuredClone(overrides.data ?? initialIcloudData());
  const calls = { launches: [], closes: 0, creates: 0, syncs: 0, hooks: null };
  const remote = { accountKey: "test-account", emails: parseIcloudList(payload([raw()])) };
  const store = { load: () => structuredClone(saved), save: data => { saved = structuredClone(data); } };
  const options = { store, dataRoot: path.join(os.tmpdir(), `icloud-unit-${randomUUID()}`), now: () => now,
    setTimer: () => ({ unref() {} }), clearTimer() {},
    browserFactory: hooks => ({
      async launch(config, request) { calls.hooks = hooks; calls.launches.push({ config, request }); },
      async openLogin() {},
      async sync() { calls.syncs++; if (overrides.onSync) await overrides.onSync(); if (overrides.syncError) throw overrides.syncError; hooks.onList(structuredClone(remote)); return structuredClone(remote); },
      async create(config, before) {
        const id = `new${++calls.creates}`; before(`${id}@example.com`);
        if (overrides.onCreate) await overrides.onCreate();
        if (overrides.createError) throw overrides.createError;
        remote.emails.push(...parseIcloudList(payload([raw(id, { label: config.label, note: config.note, createTimestamp: now })])));
        return `${id}@example.com`;
      },
      async close() { calls.closes++; if (overrides.onClose) await overrides.onClose(); if (overrides.closeError) throw overrides.closeError; },
    }), ...overrides.managerOptions };
  const manager = new IcloudManager(options);
  t.after(() => manager.shutdown());
  return { manager, store, options, remote, calls, clock: value => { now = value; }, saved: () => saved };
}

test("default automation waits for login, then runs until the server limit every 61 minutes", async t => {
  const overrides = {}; const { manager, calls, clock } = fixture(t, overrides);
  assert.deepEqual(manager.state().config, {
    enabled: true, mode: "until_limit", batchSize: 5, intervalMinutes: 61, networkMode: "direct", label: "G", note: "",
  });
  manager.schedule();
  clock(NOW + 3 * HOUR); await manager.tick();
  await assert.rejects(manager.runNow(), /等待登录/);
  assert.equal(calls.launches.length, 0);
  assert.equal(manager.timer, null);
  assert.equal(manager.state().nextRunAt, null);
  assert.equal(manager.state().config.enabled, true);
  await manager.sync();
  const firstRun = NOW + 3 * HOUR + 61 * 60_000;
  assert.equal(manager.state().nextRunAt, new Date(firstRun).toISOString());
  assert.notEqual(manager.timer, null);
  overrides.onCreate = () => {
    if (calls.creates === 2) {
      const error = new IcloudError("limit", "达到限额", manager.now() + HOUR);
      error.creationRejected = true; throw error;
    }
  };
  clock(firstRun); await manager.tick();
  assert.equal(calls.creates, 2);
  assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 1);
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().nextRunAt, new Date(firstRun + 61 * 60_000).toISOString());
});

for (const status of ["not_logged_in", "needs_login"]) {
  test(`enabled settings can be saved and restarted while ${status} without launching Chrome`, async t => {
    const data = initialIcloudData(); data.status = status;
    if (status === "needs_login") data.accountKey = "test-account";
    data.nextRunAt = NOW + HOUR;
    const { manager, calls, options } = fixture(t, { data });
    manager.stop();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, label: "自定义标签", intervalMinutes: 75 });
    assert.equal(manager.state().status, status);
    assert.equal(manager.state().nextRunAt, null);
    const restarted = new IcloudManager(options); t.after(() => restarted.shutdown());
    restarted.schedule(); await restarted.tick();
    assert.equal(restarted.state().config.enabled, true);
    assert.equal(restarted.state().config.label, "自定义标签");
    assert.equal(restarted.timer, null);
    assert.equal(calls.launches.length, 0);
    await restarted.sync();
    assert.equal(restarted.state().status, "idle");
    assert.equal(restarted.state().nextRunAt, new Date(NOW + 75 * 60_000).toISOString());
  });
}

test("the manual browser's first list starts the default schedule without requiring another sync", async t => {
  const { manager, calls, remote, clock } = fixture(t);
  await manager.open();
  clock(NOW + HOUR);
  calls.hooks.onList(structuredClone(remote));
  const nextRunAt = new Date(NOW + HOUR + 61 * 60_000).toISOString();
  assert.equal(manager.state().nextRunAt, nextRunAt);
  assert.notEqual(manager.timer, null);
  await manager.close();
  assert.equal(manager.state().nextRunAt, nextRunAt);
  assert.equal(calls.creates, 0);
});

for (const kind of ["service", "rate_limit"]) {
  test(`a ${kind} sync failure while awaiting re-login cannot resume automation or hide the login reminder`, async t => {
    const data = initialIcloudData(); data.accountKey = "test-account"; data.status = "needs_login";
    const overrides = { data, syncError: new IcloudError(kind, "连接暂时失败") };
    const { manager, calls } = fixture(t, overrides);
    manager.saveConfig({ ...data.config, enabled: true });
    await assert.rejects(manager.sync());
    assert.equal(manager.state().status, "needs_login");
    assert.equal(manager.state().config.enabled, true);
    assert.equal(manager.state().nextRunAt, null);
    assert.equal(manager.timer, null);
    await manager.tick();
    assert.equal(calls.launches.length, 1);
    delete overrides.syncError;
    await manager.sync();
    assert.equal(manager.state().status, "idle");
    assert.equal(manager.state().nextRunAt, new Date(NOW + 61 * 60_000).toISOString());
  });
}

test("saving legacy settings without mode fields preserves the existing creation strategy", t => {
  const { manager } = fixture(t);
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, mode: "batch", batchSize: 2 });
  const { mode, batchSize, ...legacyInput } = manager.state().config;
  manager.saveConfig({ ...legacyInput, label: "新标签" });
  assert.equal(manager.state().config.mode, mode);
  assert.equal(manager.state().config.batchSize, batchSize);
  assert.equal(manager.state().config.label, "新标签");
});

test("verified list schema keeps cloud fields, uses milliseconds, and rejects incomplete snapshots", () => {
  const [row] = parseIcloudList(payload([raw()]));
  assert.equal(row.cloudNote, "云端备注"); assert.equal(row.createdAt, "2026-10-22T08:00:00.000Z");
  assert.equal(row.remoteState, "active"); assert.equal(row.id, "old");
  for (const body of [{ success: false }, payload([raw(), raw()]), payload([raw("a", { isActive: "true" })]), { success: true, result: {} }]) {
    assert.throws(() => parseIcloudList(body), error => error.kind === "format");
  }
  assert.deepEqual(parseIcloudList(payload([])), []);
});

test("sync preserves local metadata, marks imported records unknown and retains missing cloud addresses", async t => {
  const { manager, remote } = fixture(t);
  await manager.sync();
  assert.equal(manager.state().emails[0].usage, "unknown");
  manager.updateLocal({ ids: ["old"], usage: "used", localNote: "本地独立备注" });
  remote.emails[0].cloudNote = "云端更改"; remote.emails[0].remoteState = "inactive";
  await manager.sync();
  assert.equal(manager.state().emails[0].localNote, "本地独立备注");
  assert.equal(manager.state().emails[0].usage, "used"); assert.equal(manager.state().emails[0].cloudNote, "云端更改");
  remote.emails = []; await manager.sync();
  assert.equal(manager.state().emails[0].remoteState, "missing");
  assert.equal(manager.state().emails[0].usage, "used");
});

test("creation persists fixed label/note and marks only confirmed new addresses unused", async t => {
  const { manager, calls } = fixture(t);
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, label: "固定标签", note: "固定备注" });
  await manager.create();
  const result = manager.state();
  assert.equal(result.emails.find(row => row.id === "new1").usage, "unused");
  assert.equal(result.emails.find(row => row.id === "new1").label, "固定标签");
  assert.equal(result.emails.find(row => row.id === "new1").cloudNote, "固定备注");
  assert.equal(result.emails.find(row => row.id === "old").usage, "unknown");
  assert.equal(calls.creates, 1); assert.equal(calls.closes, 1); assert.equal(result.pendingEmail, null);
  assertMethodResultContract("icloud.getState", result);
  assertOutgoingContract({ event: "icloud.changed", seq: 1, revision: 1, instanceId: randomUUID(), occurredAt: new Date(NOW).toISOString(), payload: result });
});

test("manual and automatic single-mode creation share a persistent rolling-hour cap, including restart", async t => {
  const { manager, options, calls, clock } = fixture(t);
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "single", intervalMinutes: 1 });
  for (let i = 0; i < 5; i++) { clock(NOW + i * 60_000); await manager.create({ automatic: i % 2 === 0 }); }
  await assert.rejects(manager.create(), error => error.kind === "rate_limit"); assert.equal(calls.creates, 5);
  const restart = new IcloudManager(options); t.after(() => restart.shutdown());
  await assert.rejects(restart.create(), error => error.kind === "rate_limit"); assert.equal(calls.creates, 5);
  clock(NOW + HOUR + 2000); await restart.create(); assert.equal(calls.creates, 6);
});

test("legacy settings retain single mode and their saved interval", t => {
  const data = initialIcloudData(); delete data.config.mode; delete data.config.batchSize;
  data.config.intervalMinutes = 60; data.config.enabled = false; data.config.networkMode = "system";
  const { manager } = fixture(t, { data });
  assert.equal(manager.state().config.mode, "single");
  assert.equal(manager.state().config.batchSize, 5);
  assert.equal(manager.state().config.intervalMinutes, 60);
  assert.equal(manager.state().config.enabled, false);
  assert.equal(manager.state().config.networkMode, "system");
  assertMethodResultContract("icloud.getState", manager.state());
});

test("a scheduled batch creates five sequentially in one browser, then waits sixty minutes", async t => {
  const { manager, calls, clock } = fixture(t);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", intervalMinutes: 60 });
  assert.equal(manager.state().nextRunAt, new Date(NOW + HOUR).toISOString());
  clock(NOW + HOUR); await manager.tick();
  assert.equal(calls.creates, 5);
  assert.equal(calls.launches.length, 2); // initial sync + one browser for the whole batch
  assert.equal(calls.closes, 2);
  assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 5);
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
  assert.match(manager.state().lastMessage, /本轮结束，已申请 5 个/);
  clock(NOW + 2 * HOUR); await manager.tick();
  assert.equal(calls.creates, 10);
  clock(NOW + 3 * HOUR); await manager.create();
  assert.equal(calls.creates, 11, "the manual button still requests exactly one address");
});

test("until-limit mode passes local estimates, stops on server 429 and retains cooldown across restart", async t => {
  const overrides = {};
  const { manager, remote, calls, clock, options } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  clock(NOW + HOUR);
  manager.data.attempts = Array(5).fill(NOW + HOUR - 1000);
  remote.emails = parseIcloudList(payload(Array.from({ length: 5 }, (_, i) => raw(`external${i}`, { createTimestamp: NOW + HOUR - 1000 }))));
  const rate = classifyIcloudFailure({ status: 429, retryAfter: "7200" }, NOW + HOUR);
  rate.creationRejected = true;
  overrides.onCreate = () => { if (calls.creates === 7) overrides.createError = rate; };
  await manager.tick();
  assert.equal(calls.creates, 7);
  assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 6);
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().status, "cooldown");
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().nextRunAt, new Date(NOW + 3 * HOUR).toISOString());
  const restart = new IcloudManager(options); t.after(() => restart.shutdown());
  await restart.tick();
  assert.equal(calls.creates, 7);
  assert.equal(restart.state().nextRunAt, new Date(NOW + 3 * HOUR).toISOString());
});

test("runNow cancels the old timer, runs the saved batch and schedules from completion", async t => {
  const timers = new Map();
  const overrides = { managerOptions: {
    setTimer: (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token; },
    clearTimer: token => timers.delete(token),
  } };
  const { manager, calls, clock, saved } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", intervalMinutes: 60 });
  const originalTimer = manager.timer;
  let finishFirst;
  overrides.onCreate = () => calls.creates === 1 ? new Promise(resolve => { finishFirst = resolve; }) : undefined;
  clock(NOW + 10 * 60_000);
  const round = manager.runNow({ operationId: "manual-round" });
  while (!finishFirst) await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.has(originalTimer), false);
  assert.equal(timers.size, 0);
  assert.equal(manager.state().nextRunAt, null);
  await assert.rejects(manager.runNow(), error => error.code === "RESOURCE_BUSY");
  // The original deadline passes while this round is still running.
  clock(NOW + HOUR + 60_000);
  finishFirst();
  assert.equal((await round).count, 5);
  assert.equal(calls.creates, 5);
  assert.equal(calls.launches.at(-1).request.operationId, "manual-round");
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR + 60_000).toISOString());
  assert.equal(saved().nextRunAt, NOW + 2 * HOUR + 60_000);
  assert.equal(timers.size, 1);
  assert.equal(timers.get(manager.timer).delay, HOUR);
});

for (const outcome of ["success", "limit", "long-cooldown"]) {
  test(`${outcome} schedules from final sync and browser cleanup completion`, async t => {
    const timers = new Map();
    const overrides = { managerOptions: {
      setTimer: (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token; },
      clearTimer: token => timers.delete(token),
    } };
    const { manager, calls, clock, saved } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: outcome === "success" ? "batch" : "until_limit", batchSize: 1, intervalMinutes: 60 });
    overrides.onCreate = () => {
      clock(NOW + 2 * 60_000);
      if (outcome !== "success") {
        const error = new IcloudError("rate_limit", "达到限额", NOW + (outcome === "long-cooldown" ? 3 : 1) * HOUR);
        error.creationRejected = true; throw error;
      }
    };
    overrides.onSync = () => { if (calls.creates) clock(NOW + 5 * 60_000); };
    let finishClose;
    overrides.onClose = () => new Promise(resolve => { finishClose = resolve; });
    const round = outcome === "success" ? manager.runNow() : manager.tick();
    while (!finishClose) await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.size, 0, "no next timer while this round is still closing its browser");
    clock(NOW + 6 * 60_000);
    finishClose(); await round;
    const expected = outcome === "long-cooldown" ? NOW + 3 * HOUR : NOW + 66 * 60_000;
    assert.equal(saved().nextRunAt, expected);
    assert.equal(manager.state().nextRunAt, new Date(expected).toISOString());
    assert.equal(timers.size, 1);
    assert.equal(timers.get(manager.timer).delay, expected - manager.now());
  });
}

test("stopping during browser cleanup does not schedule another round", async t => {
  const overrides = {}; const { manager, clock } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "single" });
  overrides.onClose = () => { clock(NOW + 5 * 60_000); manager.stop(); };
  await manager.runNow();
  assert.equal(manager.state().nextRunAt, null);
  assert.equal(manager.timer, null);
});

test("runNow requires enabled automation and a closed manual browser without changing the schedule", async t => {
  const { manager, calls } = fixture(t);
  manager.stop();
  await assert.rejects(manager.runNow(), error => error.kind === "validation");
  assert.equal(calls.launches.length, 0);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  const next = manager.state().nextRunAt;
  await manager.open();
  await assert.rejects(manager.runNow(), error => error.kind === "validation");
  assert.equal(manager.state().nextRunAt, next);
  assert.equal(calls.creates, 0);
});

test("runNow retries during cooldown while scheduled rounds keep waiting", async t => {
  const overrides = {}; const { manager, calls, clock } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  overrides.onCreate = () => {
    if (calls.creates >= 3) {
      const rate = classifyIcloudFailure({ status: 429, retryAfter: "7200" }, manager.now());
      rate.creationRejected = true; throw rate;
    }
  };
  assert.deepEqual(await manager.runNow(), { ok: true, count: 2, limited: true });
  assert.equal(calls.creates, 3);
  assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 2);
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
  clock(NOW + 10 * 60_000);
  await manager.tick();
  assert.equal(calls.creates, 3);
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
  assert.deepEqual(await manager.runNow(), { ok: true, count: 0, limited: true });
  assert.equal(calls.creates, 4, "a manual round reaches iCloud despite the saved cooldown");
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
  assert.equal(manager.state().cooldownUntil, new Date(NOW + 2 * HOUR).toISOString());
});

for (const mode of ["single", "batch", "until_limit"]) {
  test(`zero-success manual ${mode} round preserves deadlines, attempts and the timer across restart`, async t => {
    const timers = new Map();
    const overrides = { managerOptions: {
      setTimer: (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token; },
      clearTimer: token => timers.delete(token),
    } };
    const { manager, clock, saved, options } = fixture(t, overrides);
    await manager.sync();
    manager.data.cooldownUntil = NOW + 30 * 60_000;
    manager.data.attempts = Array(4).fill(NOW - 60_000);
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode, intervalMinutes: 60 });
    const previous = saved();
    overrides.onCreate = () => {
      const rate = new IcloudError("rate_limit", "达到限额", manager.now() + 2 * HOUR);
      rate.creationRejected = true; throw rate;
    };
    overrides.onClose = () => clock(NOW + 20 * 60_000);
    clock(NOW + 10 * 60_000);
    assert.deepEqual(await manager.runNow(), { ok: true, count: 0, limited: true });
    assert.equal(saved().nextRunAt, previous.nextRunAt);
    assert.equal(saved().cooldownUntil, previous.cooldownUntil);
    assert.deepEqual(saved().attempts, previous.attempts);
    assert.equal(timers.size, 1);
    assert.equal(timers.get(manager.timer).delay, 40 * 60_000);
    const restarted = new IcloudManager(options); t.after(() => restarted.shutdown());
    assert.equal(restarted.state().nextRunAt, new Date(previous.nextRunAt).toISOString());
    assert.equal(restarted.state().cooldownUntil, new Date(previous.cooldownUntil).toISOString());
  });
}

for (const outcome of ["limit", "network", "auth", "stop"]) {
  test(`zero-success manual ${outcome} keeps the original wait without reviving stopped automation`, async t => {
    const overrides = {}; const { manager, clock, saved } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
    clock(NOW + 10 * 60_000);
    if (["network", "auth"].includes(outcome)) {
      overrides.syncError = new IcloudError(outcome === "auth" ? "auth" : "service", "同步失败");
    } else {
      overrides.onCreate = () => {
        if (outcome === "stop") manager.stop();
        const rate = new IcloudError("rate_limit", "达到限额", NOW + 2 * HOUR);
        rate.creationRejected = true; throw rate;
      };
    }
    overrides.onClose = () => clock(NOW + 15 * 60_000);
    if (["network", "auth"].includes(outcome)) await assert.rejects(manager.runNow());
    else assert.equal((await manager.runNow()).count, 0);
    const enabled = ["limit", "network"].includes(outcome);
    assert.equal(manager.state().config.enabled, enabled);
    assert.equal(saved().cooldownUntil, null);
    assert.equal(saved().nextRunAt, enabled ? NOW + HOUR : null);
    assert.deepEqual(saved().attempts, []);
    if (!enabled) assert.equal(manager.timer, null);
    if (outcome === "limit") assert.equal(manager.state().status, "idle");
    if (outcome === "auth") assert.equal(manager.state().status, "needs_login");
  });
}

test("a manual round with a confirmed success still reschedules even when a later attempt fails", async t => {
  const overrides = {}; const { manager, calls, clock, saved } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  clock(NOW + 10 * 60_000);
  overrides.onCreate = () => {
    if (calls.creates === 2) {
      const error = new IcloudError("rate_limit", "达到限额", NOW + 2 * HOUR);
      error.creationRejected = true; throw error;
    }
  };
  overrides.onClose = () => clock(NOW + 20 * 60_000);
  assert.deepEqual(await manager.runNow(), { ok: true, count: 1, limited: true });
  assert.equal(saved().cooldownUntil, NOW + 2 * HOUR);
  assert.equal(saved().nextRunAt, NOW + 2 * HOUR);
});

test("automatic reconciliation counts an already-created address before ending on a limit", async t => {
  const overrides = {}; const { manager, remote, clock, saved } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  clock(NOW + 10 * 60_000);
  overrides.onCreate = () => {
    remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: manager.now() })])));
    throw new IcloudError("rate_limit", "其他请求受到限流", manager.now() + HOUR);
  };
  overrides.onClose = () => clock(NOW + 20 * 60_000);
  assert.deepEqual(await manager.runNow(), { ok: true, count: 1, limited: true });
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(saved().cooldownUntil, NOW + 70 * 60_000);
  assert.equal(saved().nextRunAt, NOW + 80 * 60_000);
});

for (const kind of ["rate_limit", "limit"]) {
  test(`a ${kind} during reconciliation ends a recovered creation instead of starting another`, async t => {
    const overrides = {}; const { manager, remote, calls } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 2, intervalMinutes: 60 });
    overrides.onCreate = () => {
      if (calls.creates === 1) {
        remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: NOW })])));
        throw new IcloudError("timeout", "未收到创建完成提示");
      }
    };
    overrides.onSync = () => {
      if (calls.creates === 1) {
        calls.hooks.onList(structuredClone(remote));
        throw new IcloudError(kind, "其他请求达到限额", NOW + 2 * HOUR);
      }
    };
    assert.deepEqual(await manager.runNow(), { ok: true, count: 1, limited: true });
    assert.equal(calls.creates, 1);
    assert.equal(manager.state().pendingEmail, null);
    assert.equal(manager.state().cooldownUntil, new Date(NOW + 2 * HOUR).toISOString());
    assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
  });
}

test("a reconciliation limit does not hide an authentication failure", async t => {
  const overrides = {}; const { manager, remote, calls } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 2 });
  overrides.onCreate = () => {
    remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: NOW })])));
    throw new IcloudError("auth", "需要重新登录");
  };
  overrides.onSync = () => {
    if (calls.creates) {
      calls.hooks.onList(structuredClone(remote));
      throw new IcloudError("rate_limit", "同步限流", NOW + 2 * HOUR);
    }
  };
  await assert.rejects(manager.runNow(), error => error.kind === "auth");
  assert.equal(calls.creates, 1);
  assert.equal(manager.state().config.enabled, false);
  assert.equal(manager.state().status, "needs_login");
  assert.equal(manager.state().cooldownUntil, new Date(NOW + 2 * HOUR).toISOString());
});

test("shutdown during a zero-success manual round saves the original deadlines", async t => {
  const overrides = {}; const { manager, calls, clock, saved, options } = fixture(t, overrides);
  await manager.sync();
  manager.data.cooldownUntil = NOW + 30 * 60_000;
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  const previous = saved();
  overrides.onCreate = () => {
    const rate = new IcloudError("rate_limit", "达到限额", NOW + 2 * HOUR);
    rate.creationRejected = true; throw rate;
  };
  let cancelSync;
  overrides.onSync = () => calls.creates ? new Promise((resolve, reject) => { cancelSync = reject; }) : undefined;
  clock(NOW + 10 * 60_000);
  const round = manager.runNow();
  while (!cancelSync) await new Promise(resolve => setImmediate(resolve));
  const shutdown = manager.shutdown();
  cancelSync(new IcloudError("cancelled", "应用退出"));
  await round; await shutdown;
  assert.equal(saved().nextRunAt, previous.nextRunAt);
  assert.equal(saved().cooldownUntil, previous.cooldownUntil);
  assert.deepEqual(saved().attempts, previous.attempts);
  assert.equal(manager.timer, null);
  const restarted = new IcloudManager(options); t.after(() => restarted.shutdown());
  assert.equal(restarted.state().nextRunAt, new Date(previous.nextRunAt).toISOString());
  assert.equal(restarted.state().cooldownUntil, new Date(previous.cooldownUntil).toISOString());
});

for (const mode of ["single", "batch", "until_limit"]) {
  test(`manual ${mode} round ignores saved cooldown and rolling-hour estimates for the entire round`, async t => {
    const overrides = {}; const { manager, remote, calls, clock } = fixture(t, overrides);
    remote.emails = parseIcloudList(payload(Array.from({ length: 5 }, (_, i) => raw(`external${i}`, { createTimestamp: NOW - 60_000 }))));
    await manager.sync();
    manager.data.attempts = Array(5).fill(NOW - 60_000);
    manager.data.cooldownUntil = NOW + 3 * HOUR;
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode, batchSize: 5, intervalMinutes: 60 });
    await manager.tick();
    assert.equal(calls.creates, 0);
    overrides.onCreate = () => {
      if (mode === "until_limit" && calls.creates === 3) {
        const rate = new IcloudError("rate_limit", "达到限额", NOW + HOUR);
        rate.creationRejected = true; throw rate;
      }
    };
    overrides.onClose = () => clock(NOW + 5 * 60_000);
    const result = await manager.runNow();
    assert.equal(result.count, mode === "single" ? 1 : mode === "batch" ? 5 : 2);
    assert.equal(calls.creates, mode === "single" ? 1 : mode === "batch" ? 5 : 3);
    assert.equal(manager.state().pendingEmail, null);
    assert.equal(manager.state().config.enabled, true);
    assert.equal(manager.state().cooldownUntil, mode === "until_limit" ? new Date(NOW + HOUR).toISOString() : null);
    assert.equal(manager.state().nextRunAt, new Date(NOW + 65 * 60_000).toISOString());
  });
}

test("stopping a runNow round finishes the submitted address and cancels future automatic work", async t => {
  const overrides = {}; const { manager, calls } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", intervalMinutes: 60 });
  overrides.onCreate = () => manager.stop();
  await manager.runNow();
  assert.equal(calls.creates, 1);
  assert.equal(manager.state().emails.find(row => row.id === "new1").usage, "unused");
  assert.equal(manager.state().config.enabled, false);
  assert.equal(manager.state().nextRunAt, null);
  assert.equal(manager.timer, null);
});

test("the observed HTTP 200 -41015 response ends a round, syncs and automatically resumes after cooldown", async t => {
  const overrides = {}; const { manager, calls, clock, saved, options } = fixture(t, overrides);
  const body = { success: false, error: { errorCode: "-41015", errorMessage: "You have reached the limit of addresses you can create right now. Please try again later.", retryAfter: 2 } };
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 61 });
  overrides.onCreate = () => {
    if (calls.creates % 3 === 0) {
      const error = classifyIcloudFailure({ status: 200, body }, manager.now());
      error.creationRejected = true; throw error;
    }
  };
  assert.deepEqual(await manager.runNow(), { ok: true, count: 2, limited: true });
  assert.equal(calls.syncs, 5, "initial sync, round start, two successes, and rejected submission all sync automatically");
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().status, "cooldown");
  assert.equal(manager.state().nextRunAt, new Date(NOW + 61 * 60_000).toISOString());
  assert.equal(saved().pendingCreate, null);
  const restarted = new IcloudManager(options); t.after(() => restarted.shutdown());
  clock(NOW + 61 * 60_000); await restarted.tick();
  assert.equal(calls.creates, 6);
  assert.equal(restarted.state().emails.filter(row => row.usage === "unused").length, 4);
  assert.equal(restarted.state().config.enabled, true);
  assert.equal(restarted.state().pendingEmail, null);
});

test("a lost success acknowledgement is reconciled automatically without stopping the round", async t => {
  const overrides = {}; const { manager, remote, calls } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 2 });
  overrides.onCreate = () => {
    if (calls.creates === 1) {
      remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: NOW })])));
      throw new IcloudError("timeout", "未收到成功提示");
    }
  };
  assert.equal((await manager.runNow()).count, 2);
  assert.equal(calls.creates, 2);
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 2);
});

for (const kind of ["format", "service", "timeout"]) {
  test(`the fifth created address is confirmed automatically after one ${kind} list failure`, async t => {
    const overrides = {}; const { manager, calls } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 5, intervalMinutes: 60 });
    let failed = false;
    overrides.onSync = () => {
      if (calls.creates === 5 && !failed) {
        failed = true;
        throw new IcloudError(kind, "iCloud 列表格式不受支持，已保留上次同步数据");
      }
    };
    assert.equal((await manager.runNow()).count, 5);
    assert.equal(calls.creates, 5, "retry only reads the list; never submits the fifth address again");
    assert.equal(calls.syncs, 8);
    assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 5);
    assert.equal(manager.state().pendingEmail, null);
    assert.equal(manager.state().config.enabled, true);
  });
}

test("a temporarily stale list is retried before requesting another address", async t => {
  const overrides = {}; const { manager, remote, calls } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 1 });
  let newRow; let reconciliations = 0;
  overrides.onSync = () => {
    if (!calls.creates) return;
    if (++reconciliations === 1) newRow = remote.emails.pop();
    else remote.emails.push(newRow);
  };
  assert.equal((await manager.runNow()).count, 1);
  assert.equal(reconciliations, 2);
  assert.equal(calls.creates, 1);
  assert.equal(manager.state().pendingEmail, null);
});

test("persistent malformed lists stop after three reconciliation attempts and preserve the submitted address", async t => {
  const overrides = {}; const { manager, calls } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 5 });
  overrides.onSync = () => { if (calls.creates === 5) throw new IcloudError("format", "列表格式异常"); };
  await assert.rejects(manager.runNow(), error => error.kind === "format");
  assert.equal(calls.creates, 5);
  assert.equal(calls.syncs, 9);
  assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 4);
  assert.equal(manager.state().pendingEmail, "new5@example.com");
  assert.equal(manager.state().config.enabled, false);
});

for (const kind of ["auth", "account", "rate_limit", "limit", "cancelled"]) {
  test(`reconciliation does not retry a ${kind} response`, async t => {
    const overrides = {}; const { manager, calls } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "batch", batchSize: 5 });
    overrides.onSync = () => { if (calls.creates) throw new IcloudError(kind, "同步无法继续"); };
    await assert.rejects(manager.runNow(), error => error.kind === kind);
    assert.equal(calls.syncs, 3);
    assert.equal(calls.creates, 1);
  });
}

test("a rejected limit needs no manual acknowledgement even if the following sync fails", async t => {
  const overrides = {}; const { manager, calls } = fixture(t, overrides);
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit" });
  overrides.onCreate = () => {
    overrides.syncError = new IcloudError("service", "同步暂时失败");
    const error = new IcloudError("rate_limit", "达到限额", NOW + HOUR);
    error.creationRejected = true; throw error;
  };
  assert.equal((await manager.create({ automatic: true })).limited, true);
  assert.equal(calls.syncs, 3);
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().status, "cooldown");
});

test("ordinary retry messages are service errors, not address limits", () => {
  for (const errorMessage of ["Something went wrong. Please try again later.", "服务暂时不可用，请稍后再试"]) {
    const error = classifyIcloudFailure({ status: 503, body: { success: false, error: { errorMessage } } }, NOW);
    assert.equal(error.kind, "service");
  }
  assert.equal(classifyIcloudFailure({ status: 200, body: { success: false, error: { errorCode: "-41015" } } }, NOW).kind, "rate_limit");
});

test("quantity-limit responses retain a longer Retry-After deadline", async t => {
  const error = classifyIcloudFailure({ status: 200, retryAfter: "7200",
    body: { success: false, error: { errorMessage: "You have reached the limit of addresses" } } }, NOW);
  assert.equal(error.kind, "limit");
  error.creationRejected = true;
  const { manager } = fixture(t, { createError: error });
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  assert.equal((await manager.create({ automatic: true })).limited, true);
  assert.equal(manager.state().cooldownUntil, new Date(NOW + 2 * HOUR).toISOString());
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
});

for (const scenario of ["limit then auth", "timeout then limit"]) {
  test(`${scenario} preserves server cooldown through automatic reconciliation and restart`, async t => {
    const overrides = {}; const { manager, remote, options } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 15 });
    const rate = new IcloudError("rate_limit", "达到限额", NOW + 2 * HOUR);
    overrides.onCreate = () => {
      if (scenario === "limit then auth") {
        rate.creationRejected = true;
        overrides.syncError = new IcloudError("auth", "需要重新登录");
        throw rate;
      }
      overrides.syncError = rate;
      throw new IcloudError("timeout", "未收到创建结果");
    };
    await assert.rejects(manager.create({ automatic: true }));
    assert.equal(manager.state().config.enabled, false);
    assert.equal(manager.state().status, scenario === "limit then auth" ? "needs_login" : "uncertain");
    assert.equal(manager.state().cooldownUntil, new Date(NOW + 2 * HOUR).toISOString());
    const restarted = new IcloudManager(options); t.after(() => restarted.shutdown());
    overrides.syncError = null;
    if (scenario === "timeout then limit") remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: NOW })])));
    await restarted.sync();
    restarted.saveConfig({ ...restarted.state().config, enabled: true });
    assert.equal(restarted.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
  });
}

for (const mode of ["batch", "until_limit"]) {
  test(`stopping ${mode} finishes the submitted address without starting another`, async t => {
    const overrides = {}; const { manager, calls } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode, intervalMinutes: 60 });
    overrides.onCreate = () => manager.stop();
    await manager.tick();
    assert.equal(calls.creates, 1);
    assert.equal(manager.state().emails.find(row => row.id === "new1").usage, "unused");
    assert.equal(manager.state().config.enabled, false);
    assert.equal(manager.state().nextRunAt, null);
    assert.equal(manager.state().pendingEmail, null);
    assert.equal(manager.state().busy, false);
  });
}

for (const kind of ["limit", "timeout"]) {
  test(`until-limit mode stops the round on ${kind} and retains earlier successes`, async t => {
    const overrides = {}; const { manager, calls } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, mode: "until_limit", intervalMinutes: 60 });
    const error = new IcloudError(kind, "模拟服务端响应");
    if (kind === "limit") error.creationRejected = true;
    overrides.onCreate = () => { if (calls.creates === 3) overrides.createError = error; };
    await manager.tick();
    assert.equal(calls.creates, 3);
    assert.equal(manager.state().emails.filter(row => row.usage === "unused").length, 2);
    assert.equal(manager.state().config.enabled, kind === "limit");
    assert.equal(manager.state().status, kind === "limit" ? "cooldown" : "uncertain");
    assert.equal(manager.state().pendingEmail, kind === "limit" ? null : "new3@example.com");
  });
}

test("addresses created on other devices also defer single-mode creation", async t => {
  const { manager, remote, calls } = fixture(t);
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, mode: "single" });
  remote.emails = parseIcloudList(payload(Array.from({ length: 5 }, (_, i) => raw(`external${i}`, { createTimestamp: NOW - 60_000 }))));
  await assert.rejects(manager.create(), error => error.kind === "rate_limit"); assert.equal(calls.creates, 0);
});

test("429 and generic quantity limits retain automation and respect cooldown", async t => {
  const rate = classifyIcloudFailure({ status: 429, retryAfter: "3600" }, NOW);
  rate.creationRejected = true;
  const { manager, calls } = fixture(t, { createError: rate });
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  await assert.rejects(manager.create(), error => error.kind === "rate_limit");
  assert.equal(manager.state().status, "cooldown"); assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().cooldownUntil, new Date(NOW + HOUR).toISOString());
  await assert.rejects(manager.create()); assert.equal(calls.creates, 1);
  const limit = classifyIcloudFailure({ body: { success: false, error: { errorMessage: "已达到创建地址上限" } } }, NOW);
  assert.equal(limit.kind, "limit");
  manager.failed("create", limit); assert.equal(manager.state().config.enabled, true);
  assert.equal(manager.state().status, "cooldown");
  assert.equal(retryAfterTime("invalid", NOW), NOW + HOUR);
  assert.equal(retryAfterTime(new Date(NOW + HOUR).toUTCString(), NOW), NOW + HOUR);
});

test("lost create acknowledgement survives restart and reconciles without another create", async t => {
  const { manager, remote, options, calls } = fixture(t, { createError: new IcloudError("timeout", "模拟超时") });
  await assert.rejects(manager.create());
  assert.equal(manager.state().status, "uncertain"); assert.equal(manager.state().config.enabled, false);
  const restarted = new IcloudManager(options); t.after(() => restarted.shutdown());
  await assert.rejects(restarted.create()); assert.equal(calls.creates, 1);
  remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: NOW })])));
  assert.equal((await restarted.create()).reconciled, true);
  assert.equal(restarted.state().pendingEmail, null);
  assert.equal(restarted.state().emails.find(row => row.id === "new1").usage, "unused"); assert.equal(calls.creates, 1);
});

test("a rate error after submission cannot clear intent unless it rejected that address", async t => {
  const { manager, remote } = fixture(t, { createError: classifyIcloudFailure({ status: 429, retryAfter: "7200" }, NOW) });
  await assert.rejects(manager.create());
  assert.equal(manager.state().status, "uncertain");
  assert.equal(manager.state().pendingEmail, "new1@example.com");
  assert.equal(manager.state().cooldownUntil, new Date(NOW + 2 * HOUR).toISOString());
  remote.emails.push(...parseIcloudList(payload([raw("new1", { createTimestamp: NOW })])));
  await manager.sync();
  manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  assert.equal(manager.state().pendingEmail, null);
  assert.equal(manager.state().nextRunAt, new Date(NOW + 2 * HOUR).toISOString());
});

test("an explicit POST 429 is recognized before its body finishes; list 429 keeps intent uncertain", async () => {
  const browser = new IcloudBrowser({}); browser.submittedCandidate = "candidate@example.com";
  const response = { status: () => 429, headers: () => ({ "retry-after": "3600" }),
    json: () => { throw new Error("Must not await a throttled response body"); },
    request: () => ({ method: () => "POST", postDataJSON: () => ({ hme: "candidate@example.com" }) }) };
  await browser.readResponse(response, new URL("https://maildomainws.icloud.com.cn/v2/hme/reserve"), 1);
  assert.equal(browser.failure.kind, "rate_limit"); assert.equal(browser.failure.creationRejected, true);
  await browser.readResponse({ ...response, request: () => ({ method: () => "GET" }) }, new URL("https://maildomainws.icloud.com.cn/v2/hme/list"), 2);
  assert.equal(browser.failure.kind, "rate_limit"); assert.equal(browser.failure.creationRejected, undefined);
});

for (const bodyOutcome of ["aborted", "malformed"]) {
  test(`an old ${bodyOutcome} list response cannot poison a new sync`, async () => {
    const browser = new IcloudBrowser({});
    const url = new URL("https://maildomainws.icloud.com.cn/v2/hme/list?dsid=123");
    let finishBody; let failBody;
    const old = browser.readResponse({ status: () => 200, headers: () => ({}),
      json: () => new Promise((resolve, reject) => { finishBody = resolve; failBody = reject; }) }, url, ++browser.sequence);
    browser.openLogin = async () => {
      if (bodyOutcome === "aborted") failBody(new Error("Navigation discarded response body"));
      else finishBody({});
      await old;
      await browser.readResponse({ status: () => 200, headers: () => ({}), json: async () => payload([raw()]) }, url, ++browser.sequence);
    };
    browser.page = { isClosed: () => false };
    const list = await browser.sync();
    assert.equal(list.emails.length, 1);
    assert.equal(browser.failure, null);
  });
}

for (const kind of ["timeout", "service"]) {
  test(`a native navigation ${kind} after create is classified for automatic reconciliation`, async t => {
    const overrides = {}; const { manager, remote, calls } = fixture(t, overrides);
    await manager.sync();
    manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, mode: "single" });
    const browser = new IcloudBrowser({});
    let navigations = 0;
    browser.page = {
      isClosed: () => false,
      goto: async () => {
        if (++navigations === 1) {
          const error = new Error(kind === "timeout" ? "page.goto: Timeout exceeded" : "page.goto: net::ERR_CONNECTION_RESET");
          if (kind === "timeout") error.name = "TimeoutError";
          throw error;
        }
        browser.latest = { ...structuredClone(remote), sequence: ++browser.sequence };
      },
    };
    overrides.onSync = async () => { if (calls.creates) await browser.sync(); };
    assert.equal((await manager.runNow()).count, 1);
    assert.equal(navigations, 2);
    assert.equal(manager.state().pendingEmail, null);
    assert.equal(manager.state().config.enabled, true);
    assert.equal(calls.creates, 1);
  });
}

test("authentication expiry stops scheduling and never erases cached rows", async t => {
  const overrides = {}; const { manager } = fixture(t, overrides);
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  overrides.syncError = classifyIcloudFailure({ status: 421 }, NOW);
  await assert.rejects(manager.sync());
  assert.equal(manager.state().status, "needs_login"); assert.equal(manager.state().config.enabled, false);
  assert.equal(manager.state().emails.length, 1);
});

test("a navigation interrupted by closing the browser is cancelled instead of retried", async () => {
  const browser = new IcloudBrowser({});
  browser.page = { isClosed: () => true, goto: async () => { throw new Error("Target closed"); } };
  await assert.rejects(browser.sync(), error => error.kind === "cancelled");
});

test("different Apple accounts cannot mix rows or inherit auto-create permission", async t => {
  const { manager, remote } = fixture(t);
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  remote.accountKey = "other-account";
  await assert.rejects(manager.sync(), error => error.kind === "account");
  assert.equal(manager.state().config.enabled, false); assert.equal(manager.state().emails.length, 1);
});

test("concurrent actions are serialized; stop prevents following automatic work", async t => {
  let complete; const wait = new Promise(resolve => { complete = resolve; });
  const { manager, calls } = fixture(t, { onCreate: () => wait });
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  const first = manager.create({ automatic: true });
  await assert.rejects(manager.create(), error => error.code === "RESOURCE_BUSY");
  while (!calls.creates) await new Promise(resolve => setImmediate(resolve));
  manager.stop(); complete(); await first;
  await manager.tick(); assert.equal(calls.creates, 1); assert.equal(manager.state().config.enabled, false);
});

test("manual browser owns the Profile and defers background creation; network changes require closing", async t => {
  const { manager, calls } = fixture(t);
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  await manager.open(); await manager.tick(); assert.equal(calls.creates, 0);
  assert.throws(() => manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, networkMode: "system" }));
  await manager.close(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, networkMode: "system" });
  assert.equal(manager.state().config.networkMode, "system");
});

test("overdue schedule restarts in the future; no accumulated catch-up bursts", t => {
  const data = initialIcloudData(); data.config.enabled = true; data.status = "idle"; data.accountKey = "test-account"; data.nextRunAt = NOW - 4 * HOUR;
  const { manager } = fixture(t, { data });
  assert.equal(manager.state().nextRunAt, new Date(NOW + 61 * 60_000).toISOString());
});

test("closing the manual Chrome during sync releases ownership after the action finishes", async t => {
  const overrides = {}; const { manager, calls } = fixture(t, overrides);
  await manager.open();
  let release; overrides.onSync = () => new Promise(resolve => { release = resolve; });
  const sync = manager.sync();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  calls.hooks.onClosed();
  await new Promise(resolve => setImmediate(resolve));
  release(); await sync;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.state().browserOpen, false);
  assert.equal(calls.closes, 1);
});

test("persistent configuration, local notes and pending intent survive reopening SQLite", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-icloud-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const filePath = path.join(root, "keeper.db");
  const repo = await openKeeperRepository({ filePath });
  const data = initialIcloudData(); data.config.note = "保留"; data.pendingCreate = { email: "pending@example.com", at: NOW, confirmed: false };
  new SqliteIcloudStore(repo).save(data); repo.close();
  const reopened = await openKeeperRepository({ filePath });
  try { assert.deepEqual(new SqliteIcloudStore(reopened).load(), data); } finally { reopened.close(); }
});

test("IPC rejects invalid settings and empty updates; endpoint matching excludes unrelated sites", () => {
  assertRequestContract({ id: "c", method: "icloud.saveConfig", params: { ...ICLOUD_DEFAULT_CONFIG }, commandId: randomUUID() });
  for (const params of [{ ...ICLOUD_DEFAULT_CONFIG, label: "" }, { ...ICLOUD_DEFAULT_CONFIG, intervalMinutes: 0 },
    { ...ICLOUD_DEFAULT_CONFIG, mode: "invalid" }, { ...ICLOUD_DEFAULT_CONFIG, batchSize: 0 }, { ...ICLOUD_DEFAULT_CONFIG, batchSize: 6 }]) {
    assert.throws(() => assertRequestContract({ id: "c", method: "icloud.saveConfig", params, commandId: randomUUID() }));
  }
  assert.throws(() => assertRequestContract({ id: "c", method: "icloud.updateLocal", params: { ids: ["old"] }, commandId: randomUUID() }));
  assert.equal(hmeEndpoint("https://p203-maildomainws.icloud.com.cn/v2/hme/list?dsid=123").searchParams.get("dsid"), "123");
  assert.equal(hmeEndpoint("https://p203-maildomainws.icloud.com.cn.evil.test/v2/hme/list?dsid=123"), null);
  assert.equal(classifyIcloudFailure({ body: payload([raw("a", { note: "too many" })]) }), null);
});
