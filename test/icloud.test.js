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
      async close() { calls.closes++; if (overrides.closeError) throw overrides.closeError; },
    }), ...overrides.managerOptions };
  const manager = new IcloudManager(options);
  t.after(() => manager.shutdown());
  return { manager, store, options, remote, calls, clock: value => { now = value; }, saved: () => saved };
}

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

test("manual and automatic creation share a persistent rolling-hour cap, including restart", async t => {
  const { manager, options, calls, clock } = fixture(t);
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true, intervalMinutes: 1 });
  for (let i = 0; i < 5; i++) { clock(NOW + i * 60_000); await manager.create({ automatic: i % 2 === 0 }); }
  await assert.rejects(manager.create(), error => error.kind === "rate_limit"); assert.equal(calls.creates, 5);
  const restart = new IcloudManager(options); t.after(() => restart.shutdown());
  await assert.rejects(restart.create(), error => error.kind === "rate_limit"); assert.equal(calls.creates, 5);
  clock(NOW + HOUR + 2000); await restart.create(); assert.equal(calls.creates, 6);
});

test("legacy settings retain single mode and their saved interval", t => {
  const data = initialIcloudData(); delete data.config.mode; delete data.config.batchSize;
  data.config.intervalMinutes = 60;
  const { manager } = fixture(t, { data });
  assert.equal(manager.state().config.mode, "single");
  assert.equal(manager.state().config.batchSize, 5);
  assert.equal(manager.state().config.intervalMinutes, 60);
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
    assert.equal(manager.state().config.enabled, false);
    assert.equal(manager.state().status, kind === "limit" ? "paused" : "uncertain");
    assert.equal(manager.state().pendingEmail, kind === "limit" ? null : "new3@example.com");
  });
}

test("addresses created on other devices also defer creating a new one", async t => {
  const { manager, remote, calls } = fixture(t);
  remote.emails = parseIcloudList(payload(Array.from({ length: 5 }, (_, i) => raw(`external${i}`, { createTimestamp: NOW - 60_000 }))));
  await assert.rejects(manager.create(), error => error.kind === "rate_limit"); assert.equal(calls.creates, 0);
});

test("429 and Retry-After cool down without blind retries, while unknown quantity limits pause", async t => {
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
  manager.failed("create", limit); assert.equal(manager.state().config.enabled, false);
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
  await restarted.sync();
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

test("authentication expiry stops scheduling and never erases cached rows", async t => {
  const overrides = {}; const { manager } = fixture(t, overrides);
  await manager.sync(); manager.saveConfig({ ...ICLOUD_DEFAULT_CONFIG, enabled: true });
  overrides.syncError = classifyIcloudFailure({ status: 421 }, NOW);
  await assert.rejects(manager.sync());
  assert.equal(manager.state().status, "needs_login"); assert.equal(manager.state().config.enabled, false);
  assert.equal(manager.state().emails.length, 1);
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
  assert.equal(manager.state().nextRunAt, new Date(NOW + 15 * 60_000).toISOString());
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
