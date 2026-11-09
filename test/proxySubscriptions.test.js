import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { configureStoreBackend } from "../src/store.js";
import * as proxies from "../src/proxyManager.js";

const proxy = (name, server) => ({ name, type: "http", server, port: 1234 });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-subscriptions-"));
  const database = await openKeeperRepository({ filePath: path.join(root, "keeper.db") });
  const { proxy: backend } = createSqliteRuntimeAdapters(database);
  backend.writeProxyStore({ nodes: [], subscriptions: [], network: { mode: "direct" } });
  const groups = [];
  const restoreStore = configureStoreBackend({ getGroups: () => groups });
  const restoreProxy = proxies.configureProxyStoreBackend(backend);
  const feeds = new Map();
  const server = http.createServer((request, response) => {
    const feed = feeds.get(new URL(request.url, "http://localhost").pathname);
    if (typeof feed === "function") return feed(response);
    if (!feed) return response.writeHead(503).end();
    response.end(YAML.stringify({ proxies: feed }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    restoreProxy();
    restoreStore();
    database.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    backend, groups, feeds,
    url: (source) => `http://127.0.0.1:${server.address().port}/${source}?token=fixture-token`,
  };
}

test("multiple subscriptions keep same-name nodes separate and refresh independently", async (t) => {
  const { backend, feeds, url } = await fixture(t);
  const a = proxy("香港 01", "a.example.test");
  const b = proxy("香港 01", "b.example.test");
  const c = proxy("香港 01", "c.example.test");
  feeds.set("/a", [a]);
  feeds.set("/b", [b, c, c]);
  const { results } = await proxies.addSubscriptions([url("a"), url("b"), url("bad"), url("a")]);
  assert.deepEqual(results.map(({ added, skipped, error }) => [added, skipped, error]), [
    [1, 0, undefined], [2, 1, undefined], [undefined, undefined, "订阅拉取失败（HTTP 503）"], [undefined, undefined, "此链接已存在"],
  ]);
  assert.equal(results[3].duplicate, true);
  assert.ok(!JSON.stringify({ results, sources: proxies.getSubscriptions(), nodes: proxies.getNodes() }).includes("fixture-token"));
  const before = backend.readProxyStore();
  assert.equal(new Set(before.nodes.map((node) => node.id)).size, 3);
  assert.equal(new Set(before.nodes.map((node) => node.portSlot)).size, 3);
  assert.notEqual(proxies.getSubscriptions()[0].name, proxies.getSubscriptions()[1].name);
  const oldA = before.nodes.find((node) => node.sourceId === results[0].id);
  const oldB = before.nodes.find((node) => node.raw.server === b.server);
  await proxies.setNodeEnabled(oldB.id, false);
  feeds.delete("/a");
  feeds.set("/b", [c, { ...b, name: "香港 02" }]);
  const refresh = await proxies.refreshSubscriptions();
  assert.ok(refresh.results[0].error);
  assert.equal(refresh.results[1].updated, 1);
  assert.deepEqual(backend.readProxyStore().nodes.find((node) => node.id === oldA.id), oldA);
  const renamed = backend.readProxyStore().nodes.find((node) => node.id === oldB.id);
  assert.equal(renamed.name, "香港 02");
  assert.equal(renamed.portSlot, oldB.portSlot);
  assert.equal(renamed.enabled, false);
  await assert.rejects(proxies.importSubscription(url("a")), /多个订阅/);
});

test("missing bound nodes retain their identity and replacing a link supersedes stale refreshes", async (t) => {
  const { backend, feeds, groups, url } = await fixture(t);
  const old = proxy("香港 01", "old.example.test");
  const replacement = proxy("香港 01", "new.example.test");
  feeds.set("/a", [old]);
  const { results: [source] } = await proxies.addSubscriptions([url("a")]);
  const [node] = proxies.getNodes();
  // A disabled node is still a saved binding, but requires no live listener.
  await proxies.setNodeEnabled(node.id, false);
  groups.push({ id: "g", name: "测试分组", proxyId: node.id });
  const bound = { bindingLabels: () => ["分组「测试分组」"] };
  let release;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  feeds.set("/a", (response) => {
    release = () => response.end(YAML.stringify({ proxies: [old] }));
    started();
  });
  const stale = proxies.refreshSubscriptions([source.id], bound);
  await requested;
  feeds.set("/replacement", [replacement]);
  try {
    const result = await proxies.updateSubscription({ id: source.id, url: url("replacement") }, bound);
    assert.deepEqual(result.results[0].missing, [{ id: node.id, name: node.name, bindings: ["分组「测试分组」"] }]);
  } finally { release(); }
  assert.match((await stale).results[0].error, /已变更/);
  const after = proxies.getNodes();
  assert.ok(after.find((item) => item.id === node.id).missing);
  assert.notEqual(after.find((item) => item.server === replacement.server).id, node.id);
  assert.equal(backend.readProxyStore().subscriptions[0].url, url("replacement"));
  assert.ok((await proxies.updateSubscription({ id: source.id, url: url("bad") })).results[0].error);
  assert.equal(backend.readProxyStore().subscriptions[0].url, url("replacement"));
  await assert.rejects(proxies.removeSubscription(source.id, bound), /测试分组/);
  feeds.set("/replacement", [old, replacement]);
  await proxies.refreshSubscriptions([source.id], bound);
  const restored = backend.readProxyStore().nodes.find((item) => item.id === node.id);
  assert.equal(restored.missing, false);
  assert.equal(restored.enabled, false);
  assert.equal(restored.portSlot, 0);
  groups.length = 0;
  await proxies.removeSubscription(source.id);
  assert.deepEqual(proxies.getSubscriptions(), []);
  assert.deepEqual(proxies.getNodes(), []);
});

test("a slow batch cannot overwrite a newer refresh of the same subscription", async (t) => {
  const { feeds, url } = await fixture(t);
  const node = (server) => proxy("节点", server);
  feeds.set("/a", [node("initial.example.test")]);
  feeds.set("/b", [node("b.example.test")]);
  const { results: [source, other] } = await proxies.addSubscriptions([url("a"), url("b")]);
  const olderDownloaded = Promise.withResolvers();
  const releaseBatch = Promise.withResolvers();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (target) => {
    if (target === url("b")) {
      await releaseBatch.promise;
      return new Response(YAML.stringify({ proxies: [node("b-updated.example.test")] }));
    }
    const first = requests++ === 0;
    if (first) setImmediate(olderDownloaded.resolve);
    return new Response(YAML.stringify({ proxies: [node(first ? "older.example.test" : "newer.example.test")] }));
  });

  const olderBatch = proxies.refreshSubscriptions();
  try {
    await olderDownloaded.promise;
    await proxies.refreshSubscriptions([source.id]);
    assert.equal(requests, 2);
  } finally {
    releaseBatch.resolve();
  }
  const { results } = await olderBatch;
  assert.match(results[0].error, /较早的刷新结果/);
  assert.equal(proxies.getNodes().find((item) => item.sourceId === source.id).server, "newer.example.test");
  assert.equal(proxies.getNodes().find((item) => item.sourceId === other.id).server, "b-updated.example.test");
});

test("an active-route change can be rejected before committing while harmless refreshes still save", async (t) => {
  const { feeds, groups, url } = await fixture(t);
  const old = { ...proxy("香港 01", "old.example.test"), "dialer-proxy": "原订阅中转" };
  feeds.set("/a", [old]);
  const { results: [source] } = await proxies.addSubscriptions([url("a")]);
  const [node] = proxies.getNodes();
  groups.push({ proxyId: node.id });
  const rejectWhileBusy = { assertIdle: () => { throw Object.assign(new Error("busy"), { code: "RESOURCE_BUSY" }); } };
  feeds.set("/a", [{ ...old, name: "新名称", "dialer-proxy": "改名后的订阅中转" }]);
  await proxies.refreshSubscriptions([source.id], rejectWhileBusy);
  assert.equal(proxies.getNodes()[0].name, "新名称");
  assert.equal(proxies.getNodes()[0].id, node.id);
  const before = proxies.getNodes();
  feeds.set("/a", [proxy("香港 01", "different.example.test")]);
  await assert.rejects(proxies.refreshSubscriptions([source.id], rejectWhileBusy), { code: "RESOURCE_BUSY" });
  assert.deepEqual(proxies.getNodes(), before);
});

test("refresh recognizes a migrated node with a string port", async (t) => {
  const { backend, feeds, groups, url } = await fixture(t);
  const raw = proxy("原节点", "old.example.test");
  const id = "px_legacy";
  backend.writeProxyStore({
    ...backend.readProxyStore(),
    subscriptions: [{ id: "legacy-subscription", name: "原有订阅", url: url("a") }],
    nodes: [{ id, sourceId: "legacy-subscription", portSlot: 0, name: raw.name,
      raw: { ...raw, port: String(raw.port) }, enabled: false }],
  });
  groups.push({ proxyId: id });
  assert.equal(proxies.getNodes()[0].port, raw.port);
  feeds.set("/a", [raw]);
  await proxies.refreshSubscriptions();
  assert.deepEqual(proxies.getNodes().map((node) => [node.id, node.enabled, node.missing]), [[id, false, false]]);
});

test("subscriptions outside the current routes can be managed while those routes are invalid", async (t) => {
  const { backend, feeds, groups, url } = await fixture(t);
  feeds.set("/a", [proxy("节点", "a.example.test")]);
  const { results: [source] } = await proxies.addSubscriptions([url("a")]);
  groups.push({ proxyId: proxies.getNodes()[0].id });
  const [{ localPort }] = proxies.getNodes();
  backend.writeProxyStore({ ...backend.readProxyStore(),
    network: { mode: "system", systemProxyUrl: `http://127.0.0.1:${localPort}` } });
  assert.throws(() => proxies.buildConfig(), /循环转发/);

  await proxies.updateSubscription({ id: source.id, name: "新别名" });
  feeds.delete("/a");
  const { results } = await proxies.refreshSubscriptions([source.id]);
  assert.equal(proxies.getSubscriptions()[0].name, "新别名");
  assert.equal(proxies.getSubscriptions()[0].error, results[0].error);
  assert.equal(proxies.getNodes().length, 1);

  feeds.set("/b", [proxy("备用节点", "b.example.test")]);
  const { results: [spare] } = await proxies.addSubscriptions([url("b")]);
  feeds.set("/b", [proxy("备用节点", "b-new.example.test")]);
  await proxies.refreshSubscriptions([spare.id]);
  assert.equal(proxies.getNodes().find((node) => node.sourceId === spare.id).server, "b-new.example.test");
  await proxies.removeSubscription(spare.id);
  assert.deepEqual(proxies.getNodes().map((node) => node.localPort), [localPort]);
});

test("reimporting a custom node keeps its port after an earlier subscription is deleted", async (t) => {
  const { feeds, groups, url } = await fixture(t);
  feeds.set("/a", [proxy("先导入的节点", "a.example.test")]);
  const { results: [source] } = await proxies.addSubscriptions([url("a")]);
  const customUrl = "http://custom.example.test:8080";
  await proxies.importCustom(customUrl);
  const custom = proxies.getNodes().find((node) => node.id.startsWith("custom_"));
  groups.push({ proxyId: custom.id });
  const port = proxies.getNodes().find((node) => node.id === custom.id).localPort;
  await proxies.removeSubscription(source.id);
  await proxies.importCustom(customUrl);
  assert.equal(proxies.getNodes()[0].localPort, port);
});
