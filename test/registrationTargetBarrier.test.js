import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installRegistrationTargetBarrier } from "../scripts/registration-target-barrier.mjs";
import { installIdentityBarrierOnEndpoint } from "../src/browser.js";

const options = { endpoint: "ws://127.0.0.1:12345/devtools/browser/test", accountId: "fixture",
  timezoneId: "Asia/Tokyo", locale: "en-US", identity: { userAgent: "fixture", platform: "Win32", metadata: { brands: [] } } };

function fixture(targets, failure = () => null, {
  installBarrier = installRegistrationTargetBarrier,
  honorFilter = false,
} = {}) {
  const calls = [];
  let event, unexpectedClose;
  const connection = {
    closed: false,
    onEvent(fn) { event = fn; },
    onUnexpectedClose(fn) { unexpectedClose = fn; },
    close() { this.closed = true; },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.setAutoAttach" && !sessionId) {
        for (const target of targets) {
          const rule = params.filter?.find(entry => !entry.type || entry.type === target.type);
          if (!honorFilter || !rule?.exclude) this.attach(target);
        }
      }
      const error = await failure(method, params, sessionId);
      if (error) throw error;
      return {};
    },
    attach({ type, id = type, waiting = true, parent }) {
      event({ method: "Target.attachedToTarget", sessionId: parent,
        params: { sessionId: id, targetInfo: { type, targetId: id }, waitingForDebugger: waiting } });
    },
    disconnect() { unexpectedClose(new Error("connection lost")); },
  };
  const context = new EventEmitter();
  context.closeCount = 0;
  context.close = async () => { context.closeCount++; context.emit("close"); };
  return { connection, context, calls, install: () => installBarrier(options, {
    connect: async () => connection, log: { error() {} },
  }) };
}

test("internal browser UI cannot block registration readiness or receive Runtime commands", async () => {
  const f = fixture([{ type: "browser_ui" }, { type: "page" }, { type: "iframe" }, { type: "worker" }],
    (_method, _params, sessionId) => sessionId === "browser_ui" ? new Error("internal target timeout") : null);
  const barrier = await f.install();
  barrier.attachContext(f.context);
  const accepts = (filter, type) => !filter.find(entry => !entry.type || entry.type === type)?.exclude;
  for (const call of f.calls.filter(c => c.method === "Target.setAutoAttach")) {
    assert.equal(accepts(call.params.filter, "browser_ui"), false);
    assert.equal(accepts(call.params.filter, "tab"), false);
    for (const type of ["page", "iframe", "worker", "shared_worker", "service_worker"]) {
      assert.equal(accepts(call.params.filter, type), true);
    }
  }
  assert.ok(f.calls.some(c => c.method === "Target.detachFromTarget" && c.params.sessionId === "browser_ui"));
  assert.equal(f.calls.some(c => c.sessionId === "browser_ui"), false);
  assert.equal(f.calls.filter(c => c.method === "Emulation.setUserAgentOverride").length, 3);
  assert.equal(f.calls.filter(c => c.method === "Emulation.setTimezoneOverride").length, 2);
  assert.equal(f.calls.filter(c => c.method === "Runtime.runIfWaitingForDebugger").length, 3);
  barrier.close();
});

test("the shared account barrier excludes internal targets and resumes only paused web targets", async () => {
  const f = fixture([
    { type: "browser_ui" },
    { type: "page", waiting: false },
    { type: "iframe" },
    { type: "service_worker" },
  ], (_method, _params, id) => id === "browser_ui" ? new Error("internal target timeout") : null,
  { installBarrier: installIdentityBarrierOnEndpoint, honorFilter: true });
  const barrier = await f.install();
  barrier.attachContext(f.context);
  const calls = f.calls.filter(c => c.method === "Target.setAutoAttach");
  assert.equal(calls.length, 3);
  for (const { params } of calls) {
    assert.deepEqual(params.filter, ["page", "iframe", "worker", "shared_worker", "service_worker"]
      .map(type => ({ type })).concat({ exclude: true }));
  }
  assert.equal(f.calls.some(c => c.sessionId === "browser_ui"), false);
  assert.deepEqual(f.calls.filter(c => c.method === "Runtime.runIfWaitingForDebugger")
    .map(c => c.sessionId), ["iframe", "service_worker"]);
  assert.ok(f.calls.some(c => c.method === "Emulation.setUserAgentOverride" && c.sessionId === "page"));
  barrier.close();
});

test("the shared account barrier still fails a real page that cannot resume", async () => {
  const f = fixture([{ type: "page" }], (method, _params, id) =>
    method === "Runtime.runIfWaitingForDebugger" && id === "page" ? new Error("fixture timeout") : null,
  { installBarrier: installIdentityBarrierOnEndpoint });
  await assert.rejects(f.install(), /Target page .*fixture timeout/);
  assert.equal(f.connection.closed, true);
});

test("already-running pages are initialized without an unnecessary debugger resume", async () => {
  const f = fixture([{ type: "page", waiting: false }]);
  const barrier = await f.install();
  assert.ok(f.calls.some(c => c.method === "Emulation.setLocaleOverride"));
  assert.equal(f.calls.some(c => c.method === "Runtime.runIfWaitingForDebugger"), false);
  barrier.close();
});

test("real page initialization failures still reject startup and close the CDP connection", async () => {
  for (const method of ["Target.setAutoAttach", "Emulation.setTimezoneOverride", "Runtime.runIfWaitingForDebugger"]) {
    const f = fixture([{ type: "page" }], (m, _p, id) => m === method && id === "page" ? new Error("fixture timeout") : null);
    await assert.rejects(f.install(), /Target page .*fixture timeout/);
    assert.equal(f.connection.closed, true);
  }
});

test("only exact missing-session and duplicate-locale responses are tolerated", async () => {
  for (const error of [
    Object.assign(new Error("gone"), { code: -32001, cdpMessage: "Session with given id not found." }),
    Object.assign(new Error("duplicate"), { code: -32000, cdpMessage: "Another locale override is already in effect" }),
  ]) {
    const f = fixture([{ type: "page" }], m => m === "Emulation.setLocaleOverride" ? error : null);
    (await f.install()).close();
  }
  const f = fixture([{ type: "page" }], m => m === "Emulation.setLocaleOverride"
    ? Object.assign(new Error("different error"), { code: -32000, cdpMessage: "different error" }) : null);
  await assert.rejects(f.install(), /different error/);
});

test("later iframe failure closes the owned browser instead of silently continuing", async () => {
  const f = fixture([{ type: "page" }], (m, _p, id) => m === "Emulation.setTimezoneOverride" && id === "iframe"
    ? new Error("late failure") : null);
  const barrier = await f.install();
  barrier.attachContext(f.context);
  f.connection.attach({ type: "iframe" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.closeCount, 1);
  assert.equal(f.connection.closed, true);
});

test("disconnect between installation and context attachment cannot report success", async () => {
  const f = fixture([]);
  const barrier = await f.install();
  f.connection.disconnect();
  assert.throws(() => barrier.attachContext(f.context), /connection lost/);
  await new Promise(resolve => setImmediate(resolve));
  barrier.close();
});

test("normal shutdown with pending target commands does not request another browser close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = Promise.withResolvers();
  const f = fixture([{ type: "page" }], (method, _params, id) =>
    method === "Emulation.setTimezoneOverride" && id === "iframe" ? pending.promise : null);
  const barrier = await f.install();
  t.after(() => barrier.close());
  barrier.attachContext(f.context);
  f.connection.attach({ type: "iframe" });
  f.connection.disconnect();
  pending.resolve(new Error("Chrome CDP WebSocket 已关闭（1006）"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.closeCount, 0, "wait for the context's normal close event");
  f.context.emit("close");
  assert.equal(f.connection.closed, true);
  t.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.closeCount, 0);
});

test("unexpected disconnect with pending commands still closes the browser after the grace period", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = Promise.withResolvers();
  const f = fixture([{ type: "page" }], (method, _params, id) =>
    method === "Emulation.setTimezoneOverride" && id === "iframe" ? pending.promise : null);
  const barrier = await f.install();
  t.after(() => barrier.close());
  barrier.attachContext(f.context);
  f.connection.attach({ type: "iframe" });
  f.connection.disconnect();
  pending.resolve(new Error("Chrome CDP WebSocket 已关闭（1006）"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.closeCount, 0);
  t.mock.timers.tick(500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.closeCount, 1);
  assert.equal(f.connection.closed, true);
});

test("remote control endpoints are rejected before connection", async () => {
  await assert.rejects(installRegistrationTargetBarrier({ ...options, endpoint: "ws://example.com/" }, {
    connect: () => assert.fail("must stay local"),
  }), /local endpoint/);
});
