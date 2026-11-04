import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { composeBackground } from "../src/agent/composition.js";
import { OperationRegistry } from "../src/application/operations.js";
import { ApplicationServices } from "../src/application/services.js";
import { configureChromeLauncher, launchForAccount } from "../src/browser.js";
import { openPageForAccount, closePageForAccount, getOpenPages } from "../src/openPage.js";
import { configureStoreBackend } from "../src/store.js";
import * as proxies from "../src/proxyManager.js";
import { isBusy, isHeld, isQuarantined, listQuarantined, resetLocksForTest } from "../src/locks.js";
import { fromRoot } from "../src/paths.js";
import { proxyNodeId } from "../src/proxyUtils.js";

test("失效中转启动失败可重复尝试、后台任务释放资源，之后可保存网络配置并重新打开", async t => {
  resetLocksForTest();
  const fixtureRoot = fromRoot("tmp");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const profile = fs.mkdtempSync(path.join(fixtureRoot, "proxy-launch-recovery-"));
  const account = { id: "proxy-launch-recovery", profileDir: path.relative(fromRoot(), profile), enabled: true };
  let proxyStore = { nodes: [{ id: "removed-relay", name: "旧中转", missing: true, enabled: true,
    raw: { name: "旧中转", type: "http", server: "127.0.0.1", port: 1 } }],
    network: { mode: "relay", relayProxyId: "removed-relay" } };
  const store = {
    getAccount: () => account, getAccounts: () => [account], getGroups: () => [],
    getSettings: () => ({ headless: false, intervalMinutes: 180, openPageTimeoutMinutes: 0 }),
    getAccountEnvironment: () => ({ mode: "fixed", locale: "en-US", version: 1 }),
    effectiveProxyId: () => null,
  };
  const restoreStore = configureStoreBackend(store);
  const restoreProxy = proxies.configureProxyStoreBackend({
    readProxyStore: () => proxyStore, writeProxyStore: value => { proxyStore = value; },
  });
  let token = 0;
  const brokerCalls = [];
  const broker = {
    running: true, generationId: "fixture", start: async () => {}, dispose: async () => {},
    newRunToken: () => `token-${++token}`,
    // 未创建的 token 必须返回 UNKNOWN_TOKEN，不能假报空 Job 掩盖现场缺陷。
    terminate: async id => { brokerCalls.push(id); return { ok: false, code: "UNKNOWN_TOKEN" }; },
    waitForEmpty: async () => ({ ok: false, code: "UNKNOWN_TOKEN", count: null }),
  };
  const operations = new OperationRegistry();
  const background = await composeBackground({
    operations, events: { publish() {} }, store, log: { info() {}, warn() {}, error() {} },
    scheduler: { running: false, status: () => ({ running: false }), nextAtFromNow: now => now + 60_000,
      noteScheduled() {}, noteCompleted() {} },
    getProxyNodes: () => proxyStore.nodes, requireBroker: true, brokerFactory: () => broker,
    launchChrome: launchForAccount,
    runOnce: () => assert.fail("代理失败时不能执行对话"),
  });
  const services = new ApplicationServices({ operations, runtime: {
    store, proxies, browserRuns: background.browserRuns, getOpenPages, isBusy, isHeld, listQuarantined,
    scheduler: { status: () => ({ running: false, accounts: {} }) },
    clearRegionCache() {}, bumpConfigEpoch() {},
  } });
  t.after(async () => {
    await closePageForAccount(account.id);
    services.dispose(); await background.dispose(); restoreProxy(); restoreStore(); resetLocksForTest();
    assert.equal(path.dirname(profile), fixtureRoot);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const assertReleased = () => {
    assert.equal(isBusy(account.id), false);
    assert.equal(isHeld(account.id), false);
    assert.equal(isQuarantined(account.id), false);
    assert.deepEqual(background.browserRuns.listActive(), []);
    assert.equal(background.snapshot().chromeSlots.used, 0);
    assert.deepEqual(brokerCalls, [], "不能回收从未创建的 broker Job");
  };
  for (let i = 0; i < 2; i++) {
    const result = await openPageForAccount(account, "https://example.com/", {
      acquireInteractiveChrome: background.acquireInteractiveChrome,
      closeHeadlessBrowserContextsForAccount: async () => 0,
    });
    assert.equal(result.code, "PROXY_UNAVAILABLE");
    assert.match(result.message, /旧中转.*网络配置/);
    assertReleased();
  }
  const operation = background.enqueue({ accountId: account.id, workKind: "account-run", kind: "account-run" });
  const failed = await operations.waitForTerminal(operation.id);
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.equal(failed.result.code, "PROXY_UNAVAILABLE");
  assert.equal(failed.result.close.ok, true);
  assertReleased();

  const saved = await services.invoke("network.updateConfig", { mode: "direct" });
  assert.equal(saved.config.mode, "direct", "前置失败不能阻止修正网络配置");

  const page = { url: () => "https://example.com/", goto: async () => {}, bringToFront: async () => {} };
  const context = new EventEmitter();
  context.pages = () => context.closed ? [] : [page];
  context.close = async () => { context.closed = true; context.emit("close"); };
  configureChromeLauncher({ launch: async ({ runToken }) => ({ context, page, runToken, rootPid: 123 }) });
  broker.terminate = async () => ({ ok: true });
  broker.waitForEmpty = async () => ({ ok: true, count: 0 });
  broker.dispose_ = async () => ({ ok: true });
  broker.forget = async () => ({ ok: true });
  const opened = await openPageForAccount(account, "https://example.com/", {
    acquireInteractiveChrome: background.acquireInteractiveChrome,
    closeHeadlessBrowserContextsForAccount: async () => 0,
  });
  assert.equal(opened.ok, true);
  await assert.rejects(services.invoke("network.updateConfig", { mode: "direct" }), { code: "RESOURCE_BUSY" },
    "真实窗口仍须阻止保存");
  await closePageForAccount(account.id);
});

test("刷新移除中转节点时报告应用失败，并向界面发布已保存的 missing 节点", async t => {
  const relayName = "原中转";
  const relayId = proxyNodeId(relayName);
  let proxyStore = {
    subscription: { url: "https://subscription.invalid/test" },
    network: { mode: "relay", relayProxyId: relayId },
    nodes: [{ id: relayId, name: relayName, enabled: true, missing: false,
      raw: { name: relayName, type: "http", server: "127.0.0.1", port: 1 } }],
  };
  const store = { getGroups: () => [], getAccounts: () => [] };
  const restoreStore = configureStoreBackend(store);
  const restoreProxy = proxies.configureProxyStoreBackend({
    readProxyStore: () => proxyStore, writeProxyStore: value => { proxyStore = value; },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    proxies: [{ name: "新节点", type: "http", server: "127.0.0.1", port: 2 }],
  })));
  let cacheClears = 0;
  const services = new ApplicationServices({ runtime: {
    store, proxies, clearRegionCache() { cacheClears++; },
  } });
  const states = [];
  services.events.subscribe(event => {
    if (event.event === "proxyState.changed") states.push(event.payload);
  });
  t.after(() => { services.dispose(); restoreProxy(); restoreStore(); });
  const operation = await services.invoke("proxies.refreshSubscription", {});
  const finished = await services.operations.waitForTerminal(operation.id);
  assert.equal(finished.state, "failed");
  assert.equal(finished.error.code, "PROXY_UNAVAILABLE");
  assert.match(finished.error.message, /订阅节点已更新.*原中转.*中转节点选择已变空.*网络配置/);
  assert.equal(proxyStore.network.mode, "relay", "失效时仍保留指定中转模式");
  assert.equal(proxyStore.network.relayProxyId, relayId, "不得擅自更换用户出口链路");
  assert.equal(proxyStore.nodes.find(node => node.id === relayId).missing, true);
  assert.equal(cacheClears, 1);
  assert.equal(states.at(-1).nodes.find(node => node.id === relayId).missing, true);
  assert.ok(states.at(-1).nodes.some(node => node.name === "新节点"));
  assert.equal(states.at(-1).nodes.some(node => node.id === relayId && node.enabled && !node.missing), false,
    "中转选择保持为空，不自动选中新节点");
});
