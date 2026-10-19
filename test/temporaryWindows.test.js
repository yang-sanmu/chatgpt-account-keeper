import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { TemporaryWindowManager, SqliteTemporaryWindowStore, normalizeTemporaryWindow } from "../src/temporaryWindows.js";
import * as proxies from "../src/proxyManager.js";
import { configureStoreBackend } from "../src/store.js";
import { ApplicationServices } from "../src/application/services.js";
import { assertRequestContract, assertMethodResultContract, assertOutgoingContract } from "../src/agent/contractValidator.js";
import { lookupThroughProxy } from "../src/geo.js";
import { ApplicationEventBus } from "../src/application/events.js";

const config = { name: "日本窗口", note: "测试备注", homepage: "https://example.com/", proxyId: "custom_tokyo" };
const nodes = ["tokyo", "berlin"].map(name => ({ id: `custom_${name}`, name,
  enabled: true, missing: false, raw: { type: "http", server: "localhost", port: name === "tokyo" ? 31001 : 31002 } }));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-temporary-"));
  const repository = await openKeeperRepository({ filePath: path.join(root, "keeper.db") });
  repository.replaceProxyNodes(nodes);
  const store = new SqliteTemporaryWindowStore(repository);
  const launched = [];
  const runs = new Map();
  const registry = { listActive: () => [...runs.values()], close: async id => {
    const run = runs.get(id); if (!run) return null;
    if (run.state === "close_failed") return run;
    runs.delete(id); return { ...run, state: "closed" };
  }, recheck: async id => { runs.delete(id); return { state: "closed" }; } };
  const manager = new TemporaryWindowManager({ store, dataRoot: root, browserRuns: registry,
    proxies: { getNodes: () => repository.getProxyState().nodes, ensureRunning: async () => {},
      proxyForNode: id => ({ server: `http://127.0.0.1:${id === config.proxyId ? 21000 : 21001}` }) },
    probe: async () => ({ timezone: "Asia/Tokyo", locale: "ja-JP", ip: "203.0.113.1" }),
    acquireChrome: async request => {
      const context = new EventEmitter();
      const run = { browserRunId: randomUUID(), accountId: request.accountId, state: "running" };
      runs.set(run.browserRunId, run);
      const value = { request, context, page: { goto: async url => { value.url = url; } },
        release: async () => { context.emit("close"); return registry.close(run.browserRunId); } };
      launched.push(value); return value;
    }, ...overrides });
  t.after(async () => {
    await manager.shutdown(); await tick(); repository.close();
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repository, store, manager, launched, runs, registry };
}

test("temporary windows bind nodes without creating accounts/groups; configuration survives a database reopen", async t => {
  const { root, manager, repository } = await fixture(t);
  const value = manager.save(config);
  assertMethodResultContract("temporaryWindows.save", value);
  assert.deepEqual(repository.listAccounts(), []); assert.deepEqual(repository.listGroups(), []);
  await manager.detect(value.id);
  const second = await openKeeperRepository({ filePath: path.join(root, "keeper.db") });
  try {
    const saved = new SqliteTemporaryWindowStore(second).get(value.id);
    assert.equal(saved.name, config.name); assert.equal(saved.proxyId, config.proxyId);
    assert.equal(saved.timezone, "Asia/Tokyo"); assert.equal(saved.exitIp, "203.0.113.1");
  } finally { second.close(); }
  const edited = manager.save({ ...config, id: value.id, proxyId: "custom_berlin" });
  assert.equal(edited.timezone, null); assert.equal(edited.detectedAt, null);
});

test("open uses the selected node, detected region and homepage; closing preserves data", async t => {
  const { manager, root, launched } = await fixture(t);
  const value = manager.save(config);
  const profile = path.join(root, "temporary-windows", value.id);
  fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, "Cookies"), "saved session");
  await manager.open(value.id);
  assert.equal(manager.list()[0].state, "open");
  assert.equal(launched[0].url, config.homepage);
  assert.equal(launched[0].request.purpose, "temporary-window");
  assert.equal(launched[0].request.launchOptions.temporaryWindow.timezone, "Asia/Tokyo");
  assert.equal(launched[0].request.launchOptions.temporaryWindow.proxyId, config.proxyId);
  assert.equal(launched[0].request.account.profileDir, path.join("temporary-windows", value.id));
  for (const action of ["open", "detect", "clearData", "remove"]) assert.throws(() => manager[action](value.id), { code: "RESOURCE_BUSY" });
  assert.throws(() => manager.save({ ...config, id: value.id }), { code: "RESOURCE_BUSY" });
  await manager.close(value.id); await tick();
  assert.equal(manager.list()[0].state, "closed");
  assert.equal(fs.readFileSync(path.join(profile, "Cookies"), "utf8"), "saved session");
  await manager.open(value.id);
  assert.equal(launched[1].request.account.profileDir, launched[0].request.account.profileDir);
  launched[1].context.emit("close"); await tick(); await tick();
  assert.equal(manager.list()[0].state, "closed");
});

test("clear data affects only the selected profile and preserves settings; remove deletes both", async t => {
  const { manager, root, store } = await fixture(t);
  const first = manager.save(config); const second = manager.save({ ...config, name: "另一窗口" });
  const paths = [first, second].map(value => path.join(root, "temporary-windows", value.id));
  for (const dir of paths) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "Cookies"), "private"); }
  const unchanged = store.get(first.id);
  const cleaning = manager.clearData(first.id);
  assert.throws(() => manager.open(first.id), { code: "RESOURCE_BUSY" });
  await cleaning;
  assert.equal(fs.existsSync(paths[0]), false); assert.equal(fs.existsSync(paths[1]), true);
  assert.deepEqual(store.get(first.id), unchanged);
  await manager.remove(second.id);
  assert.equal(fs.existsSync(paths[1]), false); assert.equal(store.get(second.id), null);
  assert.ok(store.get(first.id));
});

test("failed and unavailable probes never launch Chrome and can be retried", async t => {
  let succeed = false;
  const { manager, launched, repository } = await fixture(t, { probe: async () => succeed ? { timezone: "Europe/Berlin", locale: "de-DE" } : null });
  const value = manager.save(config);
  await assert.rejects(manager.open(value.id), { code: "PROXY_UNAVAILABLE" });
  assert.equal(launched.length, 0); assert.equal(manager.list()[0].state, "closed");
  succeed = true; await manager.open(value.id); await manager.close(value.id); await tick();
  assert.equal(manager.list()[0].timezone, "Europe/Berlin");
  succeed = false; await assert.rejects(manager.detect(value.id), { code: "PROXY_UNAVAILABLE" });
  assert.equal(manager.list()[0].timezone, null);
  repository.setProxyNodeEnabled(config.proxyId, false);
  await assert.rejects(manager.open(value.id), { code: "PROXY_UNAVAILABLE" });
  assert.equal(launched.length, 1);
});

test("a pending probe excludes duplicate launches and edits; shutdown cancels it without launching", async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { manager, launched } = await fixture(t, { probe: (_server, { signal }) => new Promise(resolve => {
    entered(); signal.addEventListener("abort", () => resolve(null), { once: true });
  }) });
  const value = manager.save(config);
  const pending = manager.open(value.id);
  const rejection = assert.rejects(pending, { code: "AGENT_DRAINING" });
  await started;
  assert.throws(() => manager.open(value.id), { code: "RESOURCE_BUSY" });
  assert.throws(() => manager.save({ ...config, id: value.id }), { code: "RESOURCE_BUSY" });
  await manager.shutdown(); await rejection;
  assert.equal(launched.length, 0); assert.equal(manager.pending.size, 0);
});

test("failed Chrome reclamation blocks destructive actions and close retries recheck ownership", async t => {
  const { manager, runs } = await fixture(t);
  const value = manager.save(config);
  await manager.open(value.id);
  const run = [...runs.values()][0];
  run.state = "close_failed";
  assert.equal(manager.list()[0].state, "close_failed");
  assert.throws(() => manager.clearData(value.id), { code: "RESOURCE_BUSY" });
  await manager.close(value.id);
  assert.equal(manager.list()[0].state, "closed");
  await manager.clearData(value.id);
});

test("browser state changes reach IPC in sequence before the derived temporary-window event", async t => {
  const events = new ApplicationEventBus();
  const { manager, runs } = await fixture(t, {
    onChanged: windows => events.publish("temporaryWindows.changed", windows),
  });
  const value = manager.save(config);
  await manager.open(value.id);
  // Production subscribes the manager before starting the IPC server.
  events.subscribe(event => {
    if (event.event === "browserRun.changed") manager.browserRunChanged(event.payload);
  });
  const received = [];
  events.subscribe(event => received.push(event));
  const run = [...runs.values()][0];
  runs.clear();
  events.publish("browserRun.changed", { ...run, state: "closed" });
  await tick();
  assert.deepEqual(received.map(event => event.event), ["browserRun.changed", "temporaryWindows.changed"]);
  assert.equal(received[1].seq, received[0].seq + 1);
  assert.equal(received[1].payload[0].state, "closed");
});

test("linked profile directories are refused and outside data stays intact", async t => {
  const { manager, root } = await fixture(t);
  const value = manager.save(config);
  const outside = path.join(root, "unrelated"); fs.mkdirSync(outside);
  const marker = path.join(outside, "keep"); fs.writeFileSync(marker, "keep");
  const profileRoot = path.join(root, "temporary-windows"); fs.mkdirSync(profileRoot);
  fs.symlinkSync(outside, path.join(profileRoot, value.id), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(manager.clearData(value.id), { code: "VALIDATION_FAILED" });
  await assert.rejects(manager.remove(value.id), { code: "VALIDATION_FAILED" });
  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
});

test("proxy configuration includes independently selected nodes and protects missing references", async t => {
  const { repository, manager } = await fixture(t);
  const value = manager.save(config);
  const adapters = createSqliteRuntimeAdapters(repository);
  const restoreStore = configureStoreBackend(adapters.store);
  const restoreProxy = proxies.configureProxyStoreBackend(adapters.proxy);
  const restoreWindows = proxies.configureTemporaryProxyIds(() => manager.proxyIds());
  t.after(() => { restoreWindows(); restoreProxy(); restoreStore(); });
  repository.updateProxySettings({ network: { mode: "direct" } });
  assert.ok(proxies.buildConfig().listeners.some(listener => listener.proxy === `out-${config.proxyId}`));
  assert.ok(proxies.proxyForNode(config.proxyId).server.startsWith("http://127.0.0.1:"));
  await assert.rejects(proxies.removeCustom(config.proxyId), /临时窗口/);
  repository.replaceProxyNodes([nodes[1]]);
  assert.equal(manager.list()[0].proxyUnavailable, true);
  assert.equal(repository.getProxyState().nodes.find(node => node.id === config.proxyId).missing, true);
  assert.equal(manager.require(value.id).proxyId, config.proxyId);
});

test("temporary IPC validates commands, receipts, bootstrap, events and update blockers", async t => {
  const { manager, repository } = await fixture(t);
  const adapters = createSqliteRuntimeAdapters(repository);
  const services = new ApplicationServices({ receiptStore: adapters.receiptStore, runtime: { store: adapters.store,
    temporaryWindows: manager, proxies: { getNodes: () => nodes, status: () => ({ running: false }) } } });
  t.after(() => services.dispose());
  manager.onChanged = windows => assertOutgoingContract(services.events.publish("temporaryWindows.changed", windows));
  const request = { id: "request", method: "temporaryWindows.save", params: config, commandId: randomUUID() };
  assertRequestContract(request);
  const value = await services.execute(request);
  assert.deepEqual(await services.execute(request), value); assert.equal(manager.list().length, 1);
  assertMethodResultContract("temporaryWindows.list", await services.invoke("temporaryWindows.list"));
  assert.equal((await services.invoke("system.bootstrap")).temporaryWindows[0].name, config.name);
  assert.throws(() => assertRequestContract({ ...request, params: { ...config, groupId: "not-allowed" } }), { code: "VALIDATION_FAILED" });
  await manager.open(value.id);
  assert.equal((await services.invoke("system.prepareUpdate", {})).ready, false);
  assert.equal((await services.invoke("system.getActivity")).blockers.some(blocker => blocker.kind === "temporary-window"), true);
  await manager.close(value.id); await tick();
  const operation = await services.execute({ method: "temporaryWindows.clearData", params: { id: value.id }, commandId: randomUUID() });
  assertMethodResultContract("temporaryWindows.clearData", operation);
  assert.equal((await services.operations.waitForTerminal(operation.id)).state, "succeeded");
});

test("homepage validation rejects local files, script URLs and embedded credentials", () => {
  for (const homepage of ["javascript:alert(1)", "file:///C:/private", "https://user:secret@example.com", "broken"]) {
    assert.throws(() => normalizeTemporaryWindow({ ...config, homepage }), { code: "VALIDATION_FAILED" });
  }
  assert.equal(normalizeTemporaryWindow({ name: " test ", proxyId: "x" }).homepage, "https://chatgpt.com/");
  assert.throws(() => normalizeTemporaryWindow({ ...config, proxyId: "" }), { code: "VALIDATION_FAILED" });
});

test("exit lookup traverses the selected proxy and validates the returned IANA timezone", async t => {
  let invalid = false; let seen;
  const server = http.createServer((req, res) => {
    seen = req.url;
    res.end(JSON.stringify({ status: "success", query: "203.0.113.3", timezone: invalid ? "Not/AZone" : "Asia/Tokyo", countryCode: "JP" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await lookupThroughProxy(endpoint), { ip: "203.0.113.3", timezone: "Asia/Tokyo", locale: "ja-JP" });
  assert.match(seen, /^http:\/\/ip-api.com\/json\//);
  invalid = true; assert.equal(await lookupThroughProxy(endpoint), null);
});
