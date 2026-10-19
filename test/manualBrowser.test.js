import test from "node:test";
import assert from "node:assert/strict";
import { connectManualBrowser } from "../src/manualBrowser.js";

async function fixture(t, handler = () => undefined) {
  const commands = [];
  let event;
  let disconnected;
  let sessionCounter = 0;
  const pageInfo = { targetId: "main", type: "page", url: "https://chatgpt.com/" };
  const connection = {
    onEvent: callback => { event = callback; },
    onUnexpectedClose: callback => { disconnected = callback; },
    close: () => {},
    send: async (method, params, sessionId, options) => {
      commands.push({ method, params, sessionId, options });
      const custom = await handler({ method, params, sessionId, emit: message => event(message) });
      if (custom !== undefined) return custom;
      if (method === "Target.getTargets") return { targetInfos: [pageInfo] };
      if (method === "Target.attachToTarget") return { sessionId: `session-${++sessionCounter}` };
      if (method === "Browser.close") disconnected();
      return {};
    },
  };
  const browser = await connectManualBrowser("ws://127.0.0.1:12345/devtools/browser/test", { connect: async () => connection });
  t.after(() => browser.close());
  return { browser, context: browser.contexts()[0], page: browser.contexts()[0].pages()[0], commands,
    emit: message => event(message), disconnect: () => disconnected() };
}

test("manual discovery observes tabs without attaching automation to every page", async t => {
  const { context, page, commands, emit } = await fixture(t);
  assert.deepEqual(commands.map(command => command.method), ["Target.setDiscoverTargets", "Target.getTargets"]);
  emit({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "main", type: "page", url: "https://github.com/signup" } } });
  assert.equal(page.url(), "https://github.com/signup");
  emit({ method: "Target.targetCreated", params: { targetInfo: { targetId: "worker", type: "service_worker" } } });
  assert.equal(context.pages().length, 1);
  let closed = 0;
  context.on("close", () => closed++);
  emit({ method: "Target.targetDestroyed", params: { targetId: "main" } });
  assert.equal(page.isClosed(), true);
  assert.deepEqual(context.pages(), []);
  assert.equal(closed, 1, "closing the last tab releases the existing window lifecycle");
});

test("manual navigation waits for its main-frame loader and detaches after DOM readiness", async t => {
  const { page, commands } = await fixture(t, ({ method, sessionId, emit }) => {
    if (method !== "Page.navigate") return;
    // Fast lifecycle events can arrive before the navigate response.
    emit({ method: "Page.lifecycleEvent", sessionId, params: { name: "DOMContentLoaded", loaderId: "old", frameId: "main" } });
    emit({ method: "Page.lifecycleEvent", sessionId, params: { name: "DOMContentLoaded", loaderId: "current", frameId: "child" } });
    setImmediate(() => emit({ method: "Page.lifecycleEvent", sessionId, params: { name: "DOMContentLoaded", loaderId: "current", frameId: "main" } }));
    return { loaderId: "current", frameId: "main" };
  });
  await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 1000 });
  assert.deepEqual(commands.slice(2).map(command => command.method), [
    "Target.attachToTarget", "Page.enable", "Page.setLifecycleEventsEnabled", "Page.navigate", "Target.detachFromTarget",
  ]);
});

test("failed and stalled manual navigations release their temporary control session", async t => {
  for (const result of [{ errorText: "net::ERR_PROXY_CONNECTION_FAILED" }, { loaderId: "waiting", frameId: "main" }]) {
    const { page, commands } = await fixture(t, ({ method }) => method === "Page.navigate" ? result : undefined);
    await assert.rejects(page.goto("https://example.com", { timeout: 20 }), /ERR_PROXY_CONNECTION_FAILED|页面导航超过/);
    assert.equal(commands.at(-1).method, "Target.detachFromTarget");
  }
});

test("on-demand session evaluation guards the origin and does not enable Runtime events", async t => {
  const { page, commands } = await fixture(t, ({ method }) => method === "Runtime.evaluate" ? { result: { value: { email: "test@example.com" } } } : undefined);
  assert.deepEqual(await page.evaluate(options => options, { attempts: 1 }), { email: "test@example.com" });
  const evaluation = commands.find(command => command.method === "Runtime.evaluate");
  assert.match(evaluation.params.expression, /location.origin !== "https:\/\/chatgpt.com"/);
  assert.equal(evaluation.options.timeoutMs, 25_000);
  assert.equal(commands.some(command => command.method === "Runtime.enable"), false);
  assert.equal(commands.at(-1).method, "Target.detachFromTarget");
});

test("disconnecting during navigation rejects promptly and closes the context once", async t => {
  let disconnect;
  const fixtureResult = await fixture(t, ({ method }) => {
    if (method === "Page.navigate") { setImmediate(() => disconnect()); return { loaderId: "pending", frameId: "main" }; }
  });
  disconnect = fixtureResult.disconnect;
  let closed = 0;
  fixtureResult.context.on("close", () => closed++);
  await assert.rejects(fixtureResult.page.goto("https://example.com"), /页面已关闭/);
  disconnect();
  assert.equal(closed, 1);
  assert.equal(fixtureResult.browser.isConnected(), false);
});

test("manual control rejects remote endpoints before connecting", async () => {
  await assert.rejects(connectManualBrowser("ws://example.com:1234/devtools/browser/x", {
    connect: () => assert.fail("must not connect outside loopback"),
  }), /本机/);
});
