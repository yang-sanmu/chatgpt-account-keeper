import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";

// Opt-in: real Chrome + the real private mihomo + Windows broker. All traffic is
// terminated by local fixture proxies; no user profiles or live nodes are used.
test("temporary Chrome windows retain isolated sessions, apply exit timezone and clear only the selected data", {
  skip: process.platform !== "win32" || process.env.GPT_ACCOUNT_NETWORK_LAB !== "1", timeout: 120000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-temp-browser-"));
  const previous = {};
  for (const [name, directory] of Object.entries({ DATA: "data", CACHE: "cache", STATE: "state" })) {
    const key = `GPT_ACCOUNT_KEEPER_${name}_ROOT`; previous[key] = process.env[key];
    process.env[key] = path.join(root, directory);
  }
  const [{ openKeeperRepository }, { createSqliteRuntimeAdapters }, { TemporaryWindowManager, SqliteTemporaryWindowStore },
    proxies, store, { composeBackground }, { ApplicationEventBus }, { OperationRegistry }] = await Promise.all([
    import("../src/persistence/sqliteRepository.js"), import("../src/persistence/runtimeAdapters.js"), import("../src/temporaryWindows.js"),
    import("../src/proxyManager.js"), import("../src/store.js"), import("../src/agent/composition.js"),
    import("../src/application/events.js"), import("../src/application/operations.js"),
  ]);
  const servers = []; const sockets = new Set(); const restorers = []; let background; let manager; let repository;
  t.after(async () => {
    await manager?.shutdown(); await background?.dispose(); await proxies.stopAll();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const restore of restorers.reverse()) restore();
    repository?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
  });
  const regionFixtures = [{ timezone: "Asia/Tokyo", countryCode: "JP" }, { timezone: "Europe/Berlin", countryCode: "DE" }];
  for (const region of regionFixtures) {
    const server = http.createServer((req, res) => {
      const target = new URL(req.url, `http://${req.headers.host}`);
      if (target.hostname === "ip-api.com") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "success", query: "203.0.113.10", ...region }));
      } else if (target.hostname === "temporary-window.test") {
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><title>Temporary window fixture</title><script>
          window.initial = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            cookie: document.cookie, storage: localStorage.getItem('session') };
          </script><h1>Temporary window fixture</h1>`);
      } else { res.statusCode = 403; res.end(); }
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("connect", (req, socket, head) => {
      if (!["ip-api.com:80", "temporary-window.test:80"].includes(req.url)) { socket.destroy(); return; }
      const upstream = net.createConnection(server.address().port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
      socket.on("close", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  }
  const dataRoot = path.join(root, "data");
  repository = await openKeeperRepository({ filePath: path.join(dataRoot, "keeper.db") });
  const adapters = createSqliteRuntimeAdapters(repository);
  adapters.proxy.writeProxyStore({ nodes: servers.map((server, index) => ({ id: `custom_fixture_${index}`, name: `Fixture ${index}`,
    raw: { type: "http", server: "127.0.0.1", port: server.address().port }, enabled: true })), network: { mode: "direct" } });
  restorers.push(store.configureStoreBackend(adapters.store), proxies.configureProxyStoreBackend(adapters.proxy));
  const events = new ApplicationEventBus(); const operations = new OperationRegistry({ events });
  const log = { info() {}, warn() {}, error() {} };
  background = await composeBackground({ operations, events, store: adapters.store, log,
    runOnce: async () => {}, checkSelectors: async () => {}, refreshAccount: async () => {},
    scheduler: { running: false, nextAtFromNow: () => Date.now(), noteScheduled() {}, noteCompleted() {} },
    getProxyNodes: () => proxies.getNodes() });
  const launched = new Map();
  manager = new TemporaryWindowManager({ store: new SqliteTemporaryWindowStore(repository), dataRoot, proxies,
    onChanged: windows => events.publish("temporaryWindows.changed", windows),
    browserRuns: background.browserRuns, acquireChrome: async request => {
      const result = await background.acquireInteractiveChrome(request); launched.set(request.accountId, result); return result;
    } });
  restorers.push(events.subscribe(event => { if (event.event === "browserRun.changed") manager.browserRunChanged(event.payload); }));
  const received = [];
  restorers.push(events.subscribe(event => received.push(event)));
  restorers.push(proxies.configureTemporaryProxyIds(() => manager.proxyIds()));
  const windows = regionFixtures.map((_region, index) => manager.save({ name: `Fixture ${index}`, proxyId: `custom_fixture_${index}`,
    homepage: "http://temporary-window.test/" }));
  for (const [index, window] of windows.entries()) {
    await manager.open(window.id);
    const page = launched.get(window.id).page;
    assert.equal(await page.evaluate(() => window.initial.timezone), regionFixtures[index].timezone);
    assert.equal(await page.evaluate(() => window.initial.storage), null);
    await page.evaluate(value => { localStorage.setItem("session", value); document.cookie = `session=${value}; Max-Age=3600; Path=/`; }, `window-${index}`);
    await manager.close(window.id);
  }
  for (const [index, window] of windows.entries()) {
    await manager.open(window.id);
    const initial = await launched.get(window.id).page.evaluate(() => window.initial);
    assert.equal(initial.storage, `window-${index}`); assert.match(initial.cookie, new RegExp(`session=window-${index}`));
    await manager.close(window.id);
  }
  await manager.clearData(windows[0].id);
  for (const [index, window] of windows.entries()) {
    await manager.open(window.id);
    const initial = await launched.get(window.id).page.evaluate(() => window.initial);
    assert.equal(initial.storage, index === 0 ? null : "window-1");
    assert.equal(initial.cookie, index === 0 ? "" : "session=window-1");
    await manager.close(window.id);
  }
  assert.equal(background.browserRuns.chromeOccupancy, 0);
  assert.ok(received.some(event => event.event === "browserRun.changed"));
  assert.ok(received.some(event => event.event === "temporaryWindows.changed"));
  for (let index = 1; index < received.length; index++) {
    assert.equal(received[index].seq, received[index - 1].seq + 1, "IPC event sequence must remain continuous");
  }
  assert.deepEqual(repository.listAccounts(), []); assert.deepEqual(repository.listGroups(), []);
});
