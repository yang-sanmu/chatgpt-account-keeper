import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  ApplicationServices,
  ERROR_CODES,
  InMemoryReceiptStore,
  ReceiptCoordinator,
} from "../src/application/index.js";

function fakeRuntime(overrides = {}) {
  const accounts = [
    {
      id: "acc_1",
      note: "one",
      email: null,
      profileDir: "profiles/acc_1",
      groupId: null,
      enabled: true,
      switchRule: "random",
      minWindows: 1,
      maxWindows: 3,
    },
  ];
  const groups = [{ id: "grp_direct", name: "direct", proxyId: null }];
  const conversations = { default: { topic: "hello", minRounds: 1, maxRounds: 2 } };
  let settings = {
    intervalMinutes: 180,
    jitterMinutes: 30,
    headless: true,
    statusCheckMinutes: 15,
    statusCheckOnStartup: true,
    openPageTimeoutMinutes: 0,
    profileAutoCleanEnabled: true,
  };
  let nextAccount = 2;
  const status = new Map([
    ["acc_1", { state: "ok", loggedIn: true, email: "one@example.com", checkedAt: "now" }],
  ]);
  const openPages = {};
  const runtime = {
    store: {
      getAccounts: () => accounts.map((item) => ({ ...item })),
      getAccount: (id) => accounts.find((item) => item.id === id) ?? null,
      addAccount: (input) => {
        const account = {
          id: `acc_${nextAccount++}`,
          profileDir: `profiles/acc_${nextAccount - 1}`,
          email: null,
          enabled: true,
          switchRule: "random",
          minWindows: 1,
          maxWindows: 3,
          groupId: null,
          ...input,
        };
        accounts.push(account);
        return { ...account };
      },
      updateAccount: (id, patch) => {
        const account = accounts.find((item) => item.id === id);
        if (!account) return null;
        Object.assign(account, patch);
        return { ...account };
      },
      removeAccount: (id) => {
        const index = accounts.findIndex((item) => item.id === id);
        if (index < 0) return false;
        accounts.splice(index, 1);
        return true;
      },
      getGroups: () => groups.map((item) => ({ ...item })),
      getGroup: (id) => groups.find((item) => item.id === id) ?? null,
      addGroup: (name, proxyId, extra) => {
        const group = { id: `grp_${groups.length}`, name, proxyId: proxyId || null, ...extra };
        groups.push(group);
        return { ...group };
      },
      updateGroup: (id, patch) => {
        const group = groups.find((item) => item.id === id);
        if (!group) return null;
        Object.assign(group, patch);
        return { ...group };
      },
      removeGroup: (id) => {
        const index = groups.findIndex((item) => item.id === id);
        if (index < 0) return false;
        groups.splice(index, 1);
        return true;
      },
      getConversations: () => structuredClone(conversations),
      saveConversationSet: (name, set) => (conversations[name] = structuredClone(set)),
      removeConversationSet: (name) => delete conversations[name],
      getSettings: () => ({ ...settings }),
      saveSettings: (patch) => (settings = { ...settings, ...patch }),
    },
    scheduler: {
      running: false,
      status() {
        return { running: this.running, accounts: {}, lastResults: {} };
      },
      start() {
        this.running = true;
        return { running: true };
      },
      async stop() {
        this.running = false;
        return { running: false };
      },
    },
    proxies: {
      nodes: [],
      getNodes() {
        return this.nodes.map((item) => ({ ...item }));
      },
      status: () => ({ running: false }),
      getSubscriptionInfo: () => null,
      getMihomoInfo: () => ({ found: false, path: null }),
      ensureRunning: async () => ({ running: true }),
      reconcile: async () => ({ running: true }),
      importSubscription: async () => ({ imported: 0 }),
      refreshSubscription: async () => ({ imported: 0 }),
      setClashVergeDirectory: async () => ({ running: false }),
      setNodeEnabled: async () => null,
      testNode: async () => ({ ok: true }),
      testAllNodes: async () => ({ results: [] }),
    },
    profileManager: {
      scan: () => ({ profiles: [], orphans: [] }),
      cleanCaches: () => ({ profilesCleaned: 0 }),
      archiveOrphan: (name) => ({ archived: true, name }),
      purgeOrphan: (name) => ({ deleted: true, name }),
      removeAccountWithProfile: (_account, action, commit) => {
        commit();
        return { action };
      },
    },
    getCachedStatus: (id) => status.get(id) ?? { state: null, loggedIn: false },
    getAllCachedStatus: () => Object.fromEntries(status),
    deleteCachedStatus: (id) => status.delete(id),
    refreshAccount: async (account) => ({
      state: "ok",
      loggedIn: true,
      email: `${account.id}@example.com`,
      checkedAt: "later",
    }),
    getOpenPages: () => structuredClone(openPages),
    openPageForAccount: async (account, url) => {
      openPages[account.id] = { url: url || "https://chatgpt.com", openedAt: "now" };
      return { ok: true, url: openPages[account.id].url };
    },
    closePageForAccount: async (id) => delete openPages[id],
    closeAllOpenPages: async () => {},
    startLogin: async () => ({ taskId: "login_1", status: "success" }),
    getLoginTask: () => ({ taskId: "login_1", status: "success", email: "one@example.com" }),
    closeAllLoginTasks: async () => {},
    runOnce: async () => ({ ok: true, totalRounds: 2 }),
    recordConversation: () => {},
    readHistory: (_id, limit) => [
      {
        ok: true,
        time: "2026-01-01T00:00:00.000Z",
        setName: `limit-${limit}`,
        totalRounds: 1,
        rounds: [{ q: "问题", a: "回答" }],
      },
    ],
    isBusy: () => false,
    isHeld: () => false,
    clearRegionCache: () => {},
    validateSettingsPatch: () => null,
    restartStatusMonitor: () => {},
    stopStatusMonitor: () => {},
    sleep: async () => {},
    loginPollMs: 0,
    openPagePollMs: 0,
    agentVersion: "test",
    schemaVersion: 1,
    lifecycle: {},
  };
  return Object.assign(runtime, overrides);
}

function request(method, params, commandId = crypto.randomUUID()) {
  return { id: crypto.randomUUID(), method, params, commandId };
}

test("hello negotiates major version and bootstrap contains a consistent management snapshot", async () => {
  const services = new ApplicationServices({ runtime: fakeRuntime() });
  const hello = await services.invoke("system.hello", {
    protocol: { major: 1, minor: 0 },
    clientVersion: "test",
    capabilities: [],
  });
  assert.deepEqual(hello.protocol, { major: 1, minMinor: 0, maxMinor: 1 });
  assert.equal(hello.agentVersion, "test");
  assert.ok(hello.capabilities.includes("operations"));

  const snapshot = await services.invoke("system.bootstrap");
  assert.equal(snapshot.accounts[0].loggedIn, true);
  assert.equal(snapshot.accounts[0].pageOpen, false);
  assert.equal(snapshot.scheduler.running, false);
  assert.equal(snapshot.settings.headless, true);

  await assert.rejects(
    services.invoke("system.hello", {
      protocol: { major: 2, minor: 0 },
      clientVersion: "test",
      capabilities: [],
    }),
    (error) => error.code === ERROR_CODES.PROTOCOL_MISMATCH
  );
});

test("hello rejects a client without the per-user IPC credential", async () => {
  const runtime = fakeRuntime();
  runtime.ipcAuthToken = "secret-token";
  const services = new ApplicationServices({ runtime });
  await assert.rejects(
    services.execute({
      id: "hello",
      method: "system.hello",
      params: {
        protocol: { major: 1, minor: 0 },
        clientVersion: "test",
        capabilities: [],
        authToken: "wrong-token",
      },
    }),
    (error) => error.code === ERROR_CODES.PROTOCOL_MISMATCH
  );
});

test("hello reports and rejects a mismatched data directory", async () => {
  const dataRoot = path.join(os.tmpdir(), "keeper-root-one");
  const services = new ApplicationServices({ runtime: fakeRuntime({ dataRoot }) });
  const hello = await services.invoke("system.hello", {
    protocol: { major: 1, minor: 1 },
    clientVersion: "test",
    capabilities: [],
    dataRoot,
  });
  assert.equal(hello.dataRoot, dataRoot);

  await assert.rejects(
    services.invoke("system.hello", {
      protocol: { major: 1, minor: 1 },
      clientVersion: "test",
      capabilities: [],
      dataRoot: path.join(os.tmpdir(), "keeper-root-two"),
    }),
    (error) => error.code === ERROR_CODES.PROTOCOL_MISMATCH
  );
});

test("account updates use a strict allowlist and validate window ranges", async () => {
  const services = new ApplicationServices({ runtime: fakeRuntime() });
  const updated = await services.execute(
    request("accounts.update", {
      id: "acc_1",
      patch: { note: "changed", switchRule: "sequential", minWindows: 2, maxWindows: 4 },
    })
  );
  assert.equal(updated.note, "changed");
  assert.equal(updated.switchRule, "sequential");

  await assert.rejects(
    services.execute(
      request("accounts.update", { id: "acc_1", patch: { profileDir: "elsewhere" } })
    ),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
  await assert.rejects(
    services.execute(
      request("accounts.update", { id: "acc_1", patch: { minWindows: 9, maxWindows: 2 } })
    ),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
});

test("proxy-bound account creation starts mihomo and rechecks the group after await", async () => {
  const runtime = fakeRuntime();
  runtime.proxies.nodes.push({ id: "proxy_1", enabled: true, missing: false });
  runtime.store.getGroups().push;
  const groups = runtime.store.getGroups();
  // Mutate through the public fake store so the service sees the proxy group.
  const proxyGroup = runtime.store.addGroup("proxy", "proxy_1", {});
  let starts = 0;
  runtime.proxies.ensureRunning = async () => {
    starts++;
    return { running: true };
  };
  const services = new ApplicationServices({ runtime });
  const account = await services.execute(
    request("accounts.create", { note: "new", groupId: proxyGroup.id })
  );
  assert.equal(account.groupId, proxyGroup.id);
  assert.equal(starts, 1);

  runtime.proxies.nodes[0].enabled = false;
  await assert.rejects(
    services.execute(request("accounts.create", { note: "blocked", groupId: proxyGroup.id })),
    (error) => error.code === ERROR_CODES.PROXY_UNAVAILABLE
  );
  assert.equal(groups.length, 1);
});

test("command receipts coalesce concurrent requests and replay the same result", async () => {
  const runtime = fakeRuntime();
  let calls = 0;
  const original = runtime.store.addAccount;
  runtime.store.addAccount = async (...args) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return original(...args);
  };
  const services = new ApplicationServices({
    runtime,
    receiptStore: new InMemoryReceiptStore(),
  });
  const commandId = crypto.randomUUID();
  const command = request("accounts.create", { note: "once", groupId: null }, commandId);
  const [first, second] = await Promise.all([
    services.execute(command),
    services.execute({ ...command, id: "another-request" }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  const replay = await services.execute({ ...command, id: "third-request" });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
});

test("concurrent commandId reuse by another method is rejected", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const receipts = new ReceiptCoordinator(new InMemoryReceiptStore());
  const first = receipts.execute(
    "shared-command",
    async () => {
      await gate;
      return { from: "accounts.create" };
    },
    "accounts.create"
  );
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    receipts.execute(
      "shared-command",
      async () => ({ from: "groups.create" }),
      "groups.create"
    ),
    (error) => error.badRequest === true
  );
  release();
  assert.equal((await first).value.from, "accounts.create");
});

test("persisted commandId reuse by another method is a validation error", async () => {
  const reused = Object.assign(new Error("commandId 已用于其他方法，不能复用"), {
    code: "COMMAND_ID_REUSED",
  });
  const services = new ApplicationServices({
    runtime: fakeRuntime(),
    receiptStore: {
      get: async () => {
        throw reused;
      },
      put: async () => {},
    },
  });

  await assert.rejects(
    services.execute(request("accounts.create", { note: "reused", groupId: null })),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
});

test("long work returns an operation immediately and publishes lifecycle events", async () => {
  const runtime = fakeRuntime();
  let release;
  runtime.runOnce = () => new Promise((resolve) => (release = resolve));
  const services = new ApplicationServices({ runtime });
  const events = [];
  services.events.subscribe((event) => events.push(event));

  const operation = await services.execute(request("accounts.runNow", { id: "acc_1" }));
  assert.equal(operation.state, "queued");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(services.operations.get(operation.id).state, "running");
  release({ ok: true, totalRounds: 3 });
  const finished = await services.operations.waitForTerminal(operation.id);
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result.totalRounds, 3);
  assert.ok(events.filter((event) => event.event === "operation.changed").length >= 3);
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));
});

test("Chrome missing keeps its stable code through run, open-page, and login operations", async () => {
  const runtime = fakeRuntime({
    runOnce: async () => ({ ok: false, reason: "未找到本机 Google Chrome", code: "CHROME_NOT_FOUND" }),
    openPageForAccount: async () => ({ ok: false, message: "未找到本机 Google Chrome", code: "CHROME_NOT_FOUND" }),
    startLogin: async () => ({
      taskId: "login-missing-chrome",
      status: "failed",
      message: "未找到本机 Google Chrome",
      code: "CHROME_NOT_FOUND",
    }),
  });
  const services = new ApplicationServices({ runtime });

  for (const [method, params] of [
    ["accounts.runNow", { id: "acc_1" }],
    ["browser.openPage", { accountId: "acc_1" }],
    ["browser.startLogin", { accountId: "acc_1" }],
  ]) {
    const operation = await services.execute(request(method, params));
    const finished = await services.operations.waitForTerminal(operation.id);
    assert.equal(finished.state, "failed", method);
    assert.equal(finished.error.code, ERROR_CODES.CHROME_NOT_FOUND, method);
  }
});

test("update preparation reports blockers before committing drain mode", async () => {
  const runtime = fakeRuntime();
  await runtime.openPageForAccount(runtime.store.getAccount("acc_1"));
  const services = new ApplicationServices({ runtime });
  const blocked = await services.execute(
    request("system.prepareUpdate", { commit: true })
  );
  assert.equal(blocked.ready, false);
  assert.equal(services.draining, false);
  await runtime.closePageForAccount("acc_1");
  const ready = await services.execute(
    request("system.prepareUpdate", { commit: true })
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.committed, true);
  assert.equal(services.draining, true);
  await assert.rejects(
    services.execute(request("accounts.create", { note: "late", groupId: null })),
    (error) => error.code === ERROR_CODES.AGENT_DRAINING
  );
});

test("failed update preparation restores monitor, scheduler, and write availability", async () => {
  const calls = [];
  const runtime = fakeRuntime({
    stopStatusMonitor: () => calls.push("monitor:stop"),
    restartStatusMonitor: () => calls.push("monitor:start"),
    lifecycle: {
      checkpoint: async () => {
        calls.push("checkpoint");
        throw new Error("backup failed");
      },
    },
  });
  runtime.scheduler.running = true;
  runtime.scheduler.drain = async () => {
    calls.push("scheduler:drain");
    runtime.scheduler.running = false;
    return { drained: true };
  };
  runtime.scheduler.start = async () => {
    calls.push("scheduler:resume");
    runtime.scheduler.running = true;
  };
  const services = new ApplicationServices({ runtime });

  await assert.rejects(
    services.execute(request("system.prepareUpdate", { commit: true })),
    /backup failed/
  );
  assert.equal(services.draining, false);
  assert.equal(runtime.scheduler.running, true);
  assert.deepEqual(calls, [
    "monitor:stop",
    "scheduler:drain",
    "checkpoint",
    "monitor:start",
    "scheduler:resume",
  ]);

  const created = await services.execute(request("accounts.create", { note: "after failure" }));
  assert.equal(created.note, "after failure");
});

test("timed-out update drain fails without restarting overlapping scheduler work", async () => {
  const calls = [];
  const runtime = fakeRuntime({
    stopStatusMonitor: () => calls.push("monitor:stop"),
    restartStatusMonitor: () => calls.push("monitor:start"),
  });
  runtime.scheduler.running = true;
  runtime.scheduler.drain = async () => {
    calls.push("scheduler:drain");
    runtime.scheduler.running = false;
    return { running: false, drained: false };
  };
  runtime.scheduler.start = async () => {
    calls.push("scheduler:start");
    runtime.scheduler.running = true;
  };
  const services = new ApplicationServices({ runtime });

  await assert.rejects(
    services.execute(request("system.prepareUpdate", { commit: true })),
    (error) => error.code === ERROR_CODES.RESOURCE_BUSY
  );
  assert.equal(services.draining, false);
  assert.equal(runtime.scheduler.running, false);
  assert.deepEqual(calls, ["monitor:stop", "scheduler:drain", "monitor:start"]);
});

test("shutdown refuses to terminate while a profile resource is busy", async () => {
  const runtime = fakeRuntime();
  const account = await runtime.store.addAccount({ note: "busy" });
  runtime.isBusy = (id) => id === account.id;
  const services = new ApplicationServices({ runtime });
  await assert.rejects(
    services.execute(request("system.shutdown", { reason: "test" })),
    (error) => error.code === ERROR_CODES.RESOURCE_BUSY && error.details.blockers[0].resourceId === account.id
  );
});

test("asynchronous shutdown failures are reported", async () => {
  let report;
  const reported = new Promise((resolve) => {
    report = resolve;
  });
  const runtime = fakeRuntime({
    lifecycle: {
      shutdown: async () => {
        throw new Error("shutdown failed");
      },
    },
    reportBackgroundError: report,
  });
  const services = new ApplicationServices({ runtime });

  assert.deepEqual(
    await services.execute(request("system.shutdown", { reason: "test" })),
    { accepted: true }
  );
  const error = await reported;
  assert.match(error.message, /shutdown failed/);
});

test("history supports deleted account ids but enforces a bounded limit", async () => {
  const services = new ApplicationServices({ runtime: fakeRuntime() });
  const rows = await services.invoke("history.query", { accountId: "deleted-account", limit: 500 });
  assert.equal(rows[0].setName, "limit-500");
  await assert.rejects(
    services.invoke("history.query", { accountId: "deleted-account", limit: 501 }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
});

test("history entries expose structured question/answer rounds", async () => {
  const services = new ApplicationServices({ runtime: fakeRuntime() });
  const [entry] = await services.invoke("history.query", { accountId: "acc", limit: 10 });
  // 界面要能直接渲染问答气泡，不该自己去猜 payload 结构，也不该在猜不到时
  // 把原始 JSON 铺给用户。
  assert.equal(entry.ok, true);
  assert.equal(entry.totalRounds, 1);
  assert.deepEqual(entry.rounds, [{ question: "问题", answer: "回答", at: null }]);
});

test("history append publishes an event instead of requiring a poll", async () => {
  const runtime = fakeRuntime();
  let publishHistory;
  runtime.subscribeHistory = (observer) => {
    publishHistory = observer;
    return () => {
      publishHistory = null;
    };
  };
  const services = new ApplicationServices({ runtime });
  const seen = [];
  services.events.subscribe((event) => {
    if (event.event === "history.appended") seen.push(event.payload);
  });
  publishHistory({ accountId: "acc", entry: { ok: false, reason: "未登录", rounds: [] } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].accountId, "acc");
  assert.equal(seen[0].entry.error, "未登录");
  services.dispose();
  assert.equal(publishHistory, null);
});

test("open page changes come from the browser observer, not a poll loop", async () => {
  const runtime = fakeRuntime();
  let publishOpenPage;
  runtime.subscribeOpenPages = (observer) => {
    publishOpenPage = observer;
    return () => {
      publishOpenPage = null;
    };
  };
  const services = new ApplicationServices({ runtime });
  const seen = [];
  services.events.subscribe((event) => {
    if (event.event === "openPage.changed") seen.push(event.payload);
  });
  publishOpenPage({ accountId: "acc", open: true, url: "https://chatgpt.com/", openedAt: "now" });
  publishOpenPage({ accountId: "acc", open: false });
  assert.deepEqual(seen.map((item) => item.open), [true, false]);
  services.dispose();
});

test("scheduler account progress is published for every persisted change", async () => {
  const runtime = fakeRuntime();
  let publishSchedule;
  runtime.scheduler.subscribe = (observer) => {
    publishSchedule = observer;
    return () => {
      publishSchedule = null;
    };
  };
  const services = new ApplicationServices({ runtime });
  const seen = [];
  services.events.subscribe((event) => {
    if (event.event === "scheduler.accountChanged") seen.push(event.payload);
  });
  publishSchedule({
    kind: "account",
    accountId: "acc",
    nextAt: "2026-01-01T01:00:00.000Z",
    lastAt: null,
    busy: false,
    lastResultState: null,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].nextAt, "2026-01-01T01:00:00.000Z");
  services.dispose();
});
