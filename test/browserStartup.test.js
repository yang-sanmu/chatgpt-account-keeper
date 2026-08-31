import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForDevToolsEndpoint } from "../src/browser.js";
import { ChromeProcessLauncher } from "../src/chromeProcessLauncher.js";

// Exercise the real polling loop and filesystem. Only elapsed time is accelerated;
// a late Chrome endpoint should not require a 12-second test on every run.
function endpointFixture(t, onAdvance = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-endpoint-"));
  const file = path.join(dir, "DevToolsActivePort");
  const started = Date.now();
  let now = started;
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) =>
    realSetTimeout(() => {
      now += ms;
      onAdvance(now - started, { file, now });
      callback(...args);
    }, 0)
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const publish = (content, mtime = now) => {
    fs.writeFileSync(file, content);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  return { dir, file, started, publish, elapsed: () => now - started };
}

test("headless readiness accepts a fresh endpoint published after the old 10s limit", async (t) => {
  let fixture;
  let published = false;
  fixture = endpointFixture(t, (elapsed) => {
    if (!published && elapsed >= 12_000) {
      published = true;
      fixture.publish("32123\n/devtools/browser/new-browser\n");
    }
  });
  fixture.publish("32122\n/devtools/browser/previous-browser\n", fixture.started - 60_000);
  assert.equal(
    await waitForDevToolsEndpoint(fixture.dir, fixture.started),
    "ws://127.0.0.1:32123/devtools/browser/new-browser"
  );
  assert.ok(fixture.elapsed() >= 12_000);
  assert.ok(fixture.elapsed() < 30_000);
});

test("headless readiness never accepts an old file and reports why its budget expired", async (t) => {
  const fixture = endpointFixture(t);
  const content = "32122\n/devtools/browser/previous-browser\n";
  fixture.publish(content, fixture.started - 60_000);
  await assert.rejects(
    waitForDevToolsEndpoint(fixture.dir, fixture.started, { timeoutMs: 200 }),
    (error) => {
      assert.equal(error.code, "CHROME_DEVTOOLS_TIMEOUT");
      assert.match(error.message, /DevToolsActivePort.*旧/);
      assert.match(error.message, /200ms/);
      assert.equal(error.message.includes(fixture.dir), false);
      return true;
    }
  );
  assert.equal(fixture.elapsed(), 200);
  assert.equal(fs.readFileSync(fixture.file, "utf8"), content, "must not clear profile state");
});

test("headless readiness distinguishes an absent endpoint file without exposing profile paths", async (t) => {
  const fixture = endpointFixture(t);
  await assert.rejects(
    waitForDevToolsEndpoint(fixture.dir, fixture.started, { timeoutMs: 100 }),
    (error) => {
      assert.equal(error.code, "CHROME_DEVTOOLS_TIMEOUT");
      assert.match(error.message, /DevToolsActivePort.*尚未/);
      assert.equal(error.message.includes(fixture.dir), false);
      return true;
    }
  );
  assert.equal(fixture.elapsed(), 100);
});

test("headless readiness tolerates a partially-written file until it becomes valid", async (t) => {
  let fixture;
  fixture = endpointFixture(t, (elapsed) => {
    if (elapsed >= 150) fixture.publish("32123\n/devtools/browser/ready\n");
  });
  fixture.publish("32123\n");
  assert.equal(
    await waitForDevToolsEndpoint(fixture.dir, fixture.started, { timeoutMs: 500 }),
    "ws://127.0.0.1:32123/devtools/browser/ready"
  );
});

test("headless readiness preserves cancellation instead of waiting for a startup timeout", async (t) => {
  const controller = new AbortController();
  const reason = new Error("account task cancelled");
  const fixture = endpointFixture(t, (elapsed) => {
    if (elapsed >= 100) controller.abort(reason);
  });
  await assert.rejects(
    waitForDevToolsEndpoint(fixture.dir, fixture.started, {
      timeoutMs: 500,
      signal: controller.signal,
    }),
    (error) => error.code === "CANCELLED" && error.message === reason.message
  );
  assert.equal(fixture.elapsed(), 100);
});

test("headless readiness rejects an already-cancelled launch even when a fresh file exists", async (t) => {
  const fixture = endpointFixture(t);
  fixture.publish("32123\n/devtools/browser/ready\n");
  const signal = AbortSignal.abort(new Error("already cancelled"));
  await assert.rejects(
    waitForDevToolsEndpoint(fixture.dir, fixture.started, { signal }),
    (error) => error.code === "CANCELLED" && error.message === signal.reason.message
  );
});

function launcherFixture(overrides = {}) {
  const events = [];
  const page = { url: () => "about:blank" };
  const context = { pages: () => [page] };
  const broker = {
    running: true,
    generationId: "generation",
    launch: async () => {
      events.push("launch");
      return { rootPid: 123, rootStartTime: 456 };
    },
    terminate: async () => events.push("terminate"),
    dispose_: async () => events.push("dispose"),
    forget: async () => events.push("forget"),
  };
  const launcher = new ChromeProcessLauncher({
    broker,
    findChromeExecutable: () => "chrome.exe",
    installIdentityBarrier: async () => {
      events.push("barrier");
      return { close: () => events.push("barrier-close") };
    },
    connectOverCDP: async () => {
      events.push("connect");
      return { contexts: () => [context], close: async () => events.push("browser-close") };
    },
    ...overrides,
  });
  const launch = (options = {}) => launcher.launch({
    userDataDir: "C:/temporary-profile",
    launchArgs: { args: [] },
    headless: true,
    accountId: "test-account",
    headlessIdentity: { userAgent: "Chrome/test" },
    runToken: "test-token",
    ...options,
  });
  return { events, launch };
}

test("launcher cancellation before launch does not create a broker-owned process", async () => {
  const { events, launch } = launcherFixture({
    waitForDevToolsEndpoint: async () => "ws://127.0.0.1:32123/devtools/browser/ready",
  });
  const signal = AbortSignal.abort(new Error("cancelled before launch"));
  await assert.rejects(launch({ signal }), (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.message, signal.reason.message);
    assert.equal(error.ownershipCertain, true, "composition must withdraw the uncreated broker token");
    assert.notEqual(error, signal.reason, "do not contaminate a shared cancellation reason with ownership proof");
    return true;
  });
  assert.equal(signal.reason.ownershipCertain, undefined);
  assert.deepEqual(events, []);
});

test("launcher cancellation during real endpoint waiting never attaches or claims cleanup ownership", async (t) => {
  const controller = new AbortController();
  const reason = new Error("cancelled during readiness");
  const fixture = endpointFixture(t, (elapsed) => {
    if (elapsed >= 100) controller.abort(reason);
  });
  const { events, launch } = launcherFixture();
  await assert.rejects(
    launch({ userDataDir: fixture.dir, signal: controller.signal }),
    (error) => {
      assert.equal(error.code, "CANCELLED");
      assert.equal(error.message, reason.message);
      assert.notEqual(error.ownershipCertain, true, "a launched job still requires broker cleanup proof");
      return true;
    }
  );
  assert.deepEqual(events, ["launch"], "BrowserRun remains sole process cleanup owner");
  assert.equal(fixture.elapsed(), 100);
});

test("launcher preserves the identity barrier before Playwright attach", async () => {
  const { events, launch } = launcherFixture({
    waitForDevToolsEndpoint: async () => "ws://127.0.0.1:32123/devtools/browser/ready",
  });
  const result = await launch();
  assert.deepEqual(events, ["launch", "barrier", "connect"]);
  assert.equal(result.rootPid, 123);
  assert.equal(result.endpoint, "http://127.0.0.1:32123");
});

test("headless readiness normalizes the queue's string cancellation reason", async (t) => {
  const controller = new AbortController();
  const fixture = endpointFixture(t, () => controller.abort("queue cancelled"));
  await assert.rejects(
    waitForDevToolsEndpoint(fixture.dir, fixture.started, { signal: controller.signal }),
    (error) => error.code === "CANCELLED" && error.message === "queue cancelled"
  );
});

test("launcher cancellation during port reservation proves no broker launch occurred", async () => {
  const controller = new AbortController();
  const { events, launch } = launcherFixture({
    reserveLocalDebugPort: async () => {
      controller.abort("cancelled while reserving");
      return 32123;
    },
  });
  await assert.rejects(launch({ headless: false, signal: controller.signal }), (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.message, "cancelled while reserving");
    assert.equal(error.ownershipCertain, true);
    return true;
  });
  assert.deepEqual(events, []);
});
