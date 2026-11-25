import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { compileConnectionRoutes, normalizeNetworkConfig, normalizeSystemProxyUrl, parseWindowsSystemProxy, udpDialerConflict, upstreamSupportsUdp } from "../src/network/connectionMode.js";
import { configureHostNetworkDetector, parseWindowsHostNetworkPayload } from "../src/network/hostNetwork.js";
import { DOH_IP_SERVERS, buildDirectBypassConfig, buildMihomoRuntimeConfig } from "../src/network/mihomoConfig.js";
import { configureProxyStoreBackend, proxyForAccount, proxyForNode, getNodes, getNodeUdpConflict, buildConfig, getNetworkConfig, setNetworkConfig, setNodeDirectOutbound, ensureDirectBypassProxy, stopAll, importCustom, removeCustom, testNode, testAllNodes } from "../src/proxyManager.js";
import { fetchSubscription, mergeSubscriptionNodes } from "../src/proxySubscriptions.js";
import { configureStoreBackend } from "../src/store.js";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { MIGRATIONS, MIGRATION_LEDGER_SQL, SCHEMA_VERSION } from "../src/persistence/schema.js";
import { ApplicationServices } from "../src/application/services.js";
import { assertRequestContract, assertMethodResultContract } from "../src/agent/contractValidator.js";
import { buildLaunchArgs } from "../src/chromeProcessLauncher.js";
import { buildInteractiveChromeArgs } from "../src/browser.js";
import { mergeProxyNodes, proxyNodeId } from "../src/proxyUtils.js";

const node = (id, port = 1234) => ({ id, name: id, enabled: true, missing: false, raw: { name: id, type: "http", server: "127.0.0.1", port } });
const dedicated = node("dedicated");
const relay = node("relay", 1235);
const systemProxy = { server: "http://127.0.0.1:7890", source: "manual", detail: "manual" };
const config = (mode, extra = {}) => normalizeNetworkConfig({ mode, ...(mode === "relay" ? { relayProxyId: relay.id } : {}), ...extra });

test("three modes compile distinct first hops; node copies do not retain imported chains", () => {
  const nodes = [{ ...dedicated, raw: { ...dedicated.raw, "dialer-proxy": "untrusted-reference" } }, relay];
  const run = (mode) => compileConnectionRoutes({ nodes, proxyIds: [dedicated.id], network: config(mode), systemProxy }).adapters;
  assert.deepEqual(run("direct").map((n) => [n.name, n["dialer-proxy"]]), [["out-dedicated", undefined]]);
  assert.deepEqual(run("system").map((n) => [n.name, n["dialer-proxy"]]), [["out-dedicated", "network-system"], ["network-system", undefined]]);
  assert.deepEqual(run("relay").map((n) => [n.name, n["dialer-proxy"]]), [["out-dedicated", "network-relay"], ["out-relay", undefined], ["network-relay", undefined]]);
  assert.equal(nodes[0].raw["dialer-proxy"], "untrusted-reference");
});

test("relay equals group node, including duplicate node records, never chains to itself", () => {
  const duplicate = { ...relay, id: "custom_duplicate", raw: { ...relay.raw, name: "another-name" } };
  const result = compileConnectionRoutes({ nodes: [relay, duplicate], proxyIds: [duplicate.id], network: config("relay") });
  assert.equal(result.adapters.length, 2);
  assert.ok(result.adapters.every((entry) => !entry["dialer-proxy"]));
});

test("system entry selected as the group node never wraps itself", () => {
  const groupNode = { ...node("local-system", 7890), raw: { ...node("local-system", 7890).raw, server: "localhost" } };
  const result = compileConnectionRoutes({ nodes: [groupNode], proxyIds: [groupNode.id], network: config("system"), systemProxy });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.adapters[0]["dialer-proxy"], undefined);
});

test("the same system entry with group credentials uses that entry once and retains authentication", () => {
  const groupNode = { ...node("authenticated-system", 7890), raw: { ...node("authenticated-system", 7890).raw,
    username: "group-user", password: "fixture-password" } };
  const result = compileConnectionRoutes({ nodes: [groupNode], proxyIds: [groupNode.id], network: config("system"), systemProxy });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.adapters[0]["dialer-proxy"], undefined);
  assert.equal(result.adapters[0].username, "group-user");
  assert.equal(result.adapters[0].password, "fixture-password");
});

test("invalid or unavailable relay and PAC cannot silently change the chain", () => {
  assert.throws(() => normalizeNetworkConfig({ mode: "relay" }), /必须选择/);
  for (const nodes of [[], [{ ...relay, enabled: false }], [{ ...relay, missing: true }]]) {
    assert.throws(() => compileConnectionRoutes({ nodes, proxyIds: [], network: config("relay") }), { code: "PROXY_UNAVAILABLE" });
  }
  assert.throws(() => compileConnectionRoutes({ nodes: [dedicated], proxyIds: [dedicated.id], network: config("system"),
    systemProxy: { source: "pac", server: null, detail: "填写固定入口" } }), /填写固定入口/);
  assert.throws(() => normalizeNetworkConfig({ mode: "anything" }), /有效/);
  assert.throws(() => normalizeNetworkConfig({ mode: "direct", command: "bad" }), /不允许/);
});

test("manual and Windows system proxy entries normalize HTTP, HTTPS and SOCKS5", () => {
  assert.equal(normalizeSystemProxyUrl("https://127.0.0.1"), "https://127.0.0.1:443");
  assert.equal(normalizeSystemProxyUrl("socks5://[::1]:1080"), "socks5://[::1]:1080");
  for (const value of ["http://user:secret@localhost:7890", "file:///test", "http://localhost/path", "http://localhost:99999", "http://localhost:0", "http://localhost/?token=secret"]) {
    assert.throws(() => normalizeSystemProxyUrl(value));
  }
  assert.equal(parseWindowsSystemProxy("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:7890;https=127.0.0.1:7891").server, "http://127.0.0.1:7891");
  assert.equal(parseWindowsSystemProxy("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ socks=127.0.0.1:1080").server, "socks5://127.0.0.1:1080");
  assert.equal(parseWindowsSystemProxy("ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ 127.0.0.1:7890").server, null);
  assert.equal(parseWindowsSystemProxy("AutoConfigURL REG_SZ http://example.invalid/proxy.pac").source, "pac");
  assert.equal(parseWindowsSystemProxy("ProxyEnable REG_DWORD 0x1").source, "unavailable");
  assert.equal(parseWindowsSystemProxy("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=bad/path").source, "unavailable");
  const tls = compileConnectionRoutes({ nodes: [dedicated], proxyIds: [dedicated.id], network: config("system"),
    systemProxy: { server: "https://proxy.invalid:443", source: "manual" } });
  assert.equal(tls.adapters.find((raw) => raw.name === "network-system").port, 443);
});

test("direct interface only binds the first hop, while relay and system loops are rejected", () => {
  const direct = compileConnectionRoutes({ nodes: [dedicated], proxyIds: [dedicated.id], network: config("direct", { outboundInterface: "Wi-Fi" }) });
  assert.equal(direct.adapters[0]["interface-name"], "Wi-Fi");
  const chain = compileConnectionRoutes({ nodes: [dedicated, relay], proxyIds: [dedicated.id], network: config("relay", { outboundInterface: "Wi-Fi" }) });
  assert.equal(chain.adapters.find((raw) => raw.name === "network-relay")["interface-name"], "Wi-Fi");
  assert.equal(chain.adapters.find((raw) => raw.name === "out-dedicated")["interface-name"], undefined);
  const restoreStore = configureStoreBackend({ getGroups: () => [{ proxyId: dedicated.id }] });
  const restoreProxy = configureProxyStoreBackend({ readProxyStore: () => ({ nodes: [dedicated], network: config("system", { systemProxyUrl: "http://127.0.0.1:21000" }) }) });
  try { assert.throws(() => buildConfig(21000), /循环转发/); }
  finally { restoreProxy(); restoreStore(); }
});

test("system groups use one system entry and relay groups without a dedicated node use one relay", () => {
  let stored = { nodes: [dedicated, relay], network: config("system", { systemProxyUrl: systemProxy.server }) };
  const restoreStore = configureStoreBackend({ effectiveProxyId: (account) => account.groupId === "dedicated" ? dedicated.id : account.groupId === "relay" ? relay.id : null,
    getGroups: () => [{ id: "dedicated", proxyId: dedicated.id }] });
  const restoreProxy = configureProxyStoreBackend({ readProxyStore: () => structuredClone(stored), writeProxyStore: (value) => { stored = structuredClone(value); } });
  try {
    assert.deepEqual(proxyForAccount({ groupId: null }), { server: systemProxy.server });
    assert.deepEqual(proxyForAccount({ groupId: "system" }), { server: systemProxy.server });
    stored.network = config("relay");
    const onlyRelay = proxyForAccount({ groupId: "relay" });
    assert.deepEqual(proxyForAccount({ groupId: null }), onlyRelay);
    const runtime = buildConfig();
    assert.equal(runtime.listeners.length, 2);
    assert.ok(runtime.proxies.find((entry) => entry.name === "out-dedicated")["dialer-proxy"]);
    assert.equal(runtime.proxies.find((entry) => entry.name === "out-relay")["dialer-proxy"], undefined);
    stored.network = config("direct");
    assert.equal(proxyForAccount({ groupId: null }), null);
  } finally { restoreProxy(); restoreStore(); }
});

test("an unused node port slot is not treated as an active proxy loop", () => {
  const restoreStore = configureStoreBackend({ getGroups: () => [{ proxyId: relay.id }] });
  const restoreProxy = configureProxyStoreBackend({ readProxyStore: () => ({ nodes: [dedicated, relay],
    network: config("system", { systemProxyUrl: "http://127.0.0.1:21000" }) }) });
  try {
    const runtime = buildConfig(21000);
    assert.deepEqual(runtime.listeners.map((listener) => listener.port), [21001]);
    assert.equal(runtime.proxies.find((raw) => raw.name === "network-system").port, 21000);
  } finally { restoreProxy(); restoreStore(); }
});

test("direct mode is retained by interactive and broker/headless argument builders", () => {
  const launchArgs = { args: ["--no-proxy-server"] };
  const interactive = buildInteractiveChromeArgs({ userDataDir: "test-profile", launchArgs, debugPort: 3456 });
  for (const headless of [false, true]) {
    const args = buildLaunchArgs({ userDataDir: "test-profile", launchArgs, headless, debugPort: 3456 });
    assert.ok(args.includes("--no-proxy-server"));
    assert.ok(!args.some((arg) => arg.startsWith("--proxy-server=")));
  }
  assert.ok(interactive.includes("--no-proxy-server"));
});

test("settings survive restart and custom imports; active relay deletion is protected", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-network-config-"));
  const dbPath = path.join(root, "keeper.db");
  let repository = await openKeeperRepository({ filePath: dbPath });
  t.after(() => { repository.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const adapters = createSqliteRuntimeAdapters(repository);
  const customRelay = { ...relay, id: "custom_relay" };
  adapters.proxy.writeProxyStore({ nodes: [customRelay], network: config("relay", { relayProxyId: customRelay.id }) });
  const restoreStore = configureStoreBackend(adapters.store);
  const restoreProxy = configureProxyStoreBackend(adapters.proxy);
  try {
    await assert.rejects(removeCustom(customRelay.id), /正被分组使用/);
    await importCustom("http://localhost:10001");
    assert.equal(getNetworkConfig().config.relayProxyId, customRelay.id);
    await assert.rejects(setNetworkConfig(config("relay", { relayProxyId: "missing" })), { code: "PROXY_UNAVAILABLE" });
    assert.equal(getNetworkConfig().config.relayProxyId, customRelay.id);
  } finally { restoreProxy(); restoreStore(); }
  repository.close();
  repository = await openKeeperRepository({ filePath: dbPath });
  assert.equal(repository.getProxyState().network.relayProxyId, customRelay.id);
});

test("subscription replacement retains an ungrouped relay as missing, preserving its selection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-network-refresh-"));
  const repository = await openKeeperRepository({ filePath: path.join(root, "keeper.db") });
  t.after(() => { repository.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { proxy } = createSqliteRuntimeAdapters(repository);
  const selected = { ...relay, id: proxyNodeId(relay.name) };
  const original = { nodes: [selected], network: config("relay", { relayProxyId: selected.id }) };
  proxy.writeProxyStore(original);
  const replacement = mergeProxyNodes([dedicated.raw], original.nodes, new Set([selected.id]));
  assert.equal(replacement.find((item) => item.id === selected.id).missing, true);
  proxy.writeProxyStore({ ...original, nodes: replacement });
  assert.equal(proxy.readProxyStore().network.relayProxyId, selected.id);
  assert.equal(proxy.readProxyStore().nodes.find((item) => item.id === selected.id).missing, true);
  // Repository replacement also protects the reference when bypassing the merger.
  repository.replaceProxyNodes([dedicated]);
  assert.equal(repository.getProxyState().nodes.find((item) => item.id === selected.id).missing, true);
  const restoreStore = configureStoreBackend({ getGroups: () => [] });
  const restoreProxy = configureProxyStoreBackend(proxy);
  try { assert.throws(() => buildConfig(), { code: "PROXY_UNAVAILABLE" }); }
  finally { restoreProxy(); restoreStore(); }
});

test("v7 databases upgrade with default system mode and preserve accounts/proxies", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-network-v7-"));
  const dbPath = path.join(root, "keeper.db");
  const db = new Database(dbPath);
  db.exec(MIGRATION_LEDGER_SQL);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(migration.version, migration.name, migration.checksum, new Date().toISOString(), "fixture");
  }
  db.pragma("user_version = 7");
  db.prepare("INSERT INTO proxy_nodes(id, sort_order, name, raw_json) VALUES (?,0,?,?)").run(dedicated.id, dedicated.name, JSON.stringify(dedicated.raw));
  db.prepare("INSERT INTO accounts(id, sort_order, profile_name) VALUES ('old',0,'keep-profile')").run();
  db.close();
  const repository = await openKeeperRepository({ filePath: dbPath });
  t.after(() => { repository.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(repository.getSchemaVersion(), SCHEMA_VERSION);
  assert.equal(repository.getProxyState().network.mode, "system");
  assert.equal(repository.getAccount("old").profileName, "keep-profile");
  assert.deepEqual(repository.getProxyState({ includeSecrets: true }).nodes[0].raw, dedicated.raw);
  assert.equal(fs.readdirSync(path.join(root, "backups")).length, 1);
});

test("IPC network settings validate results, publish state and reject active Chrome before applying", async () => {
  let writes = 0;
  let active = false;
  let saved = config("system");
  const get = () => ({ config: saved, systemProxy });
  const services = new ApplicationServices({ runtime: {
    store: { getAccounts: () => [] }, getOpenPages: () => ({}), listQuarantined: () => [],
    browserRuns: { listActive: () => active ? [{ state: "launching" }] : [] },
    proxies: { getNetworkConfig: get, getNodes: () => [], status: () => ({ running: false }),
      setNetworkConfig: async (input, { assertIdle }) => { assertIdle(); writes++; saved = input; return get(); } },
    clearRegionCache() {}, bumpConfigEpoch() {},
    scheduler: { status: () => ({ running: false, accounts: {} }) },
  } });
  const params = config("direct");
  assertRequestContract({ id: "network", method: "network.updateConfig", params, commandId: randomUUID() });
  const result = await services.execute({ method: "network.updateConfig", params, commandId: randomUUID() });
  assertMethodResultContract("network.getConfig", result);
  assertMethodResultContract("network.updateConfig", result);
  assert.equal(writes, 1);
  active = true;
  await assert.rejects(services.execute({ method: "network.updateConfig", params: config("relay"), commandId: randomUUID() }), { code: "RESOURCE_BUSY" });
  assert.equal(writes, 1);
});

test("failed network saves publish the restored snapshot after an intermediate proxy event", async () => {
  const previous = config("direct");
  const candidate = config("system");
  const startupError = new Error("fixture mihomo startup failed");
  let saved = previous;
  let cacheClears = 0;
  let epochBumps = 0;
  let stateReadFails = false;
  const events = [];
  const get = () => ({ config: saved, systemProxy });
  const services = new ApplicationServices({ runtime: {
    store: { getAccounts: () => [] }, getOpenPages: () => ({}), listQuarantined: () => [],
    proxies: { getNetworkConfig: get, getNodes: () => { if (stateReadFails) throw new Error("fixture snapshot unavailable"); return []; }, status: () => ({ running: false }),
      setNetworkConfig: async (input, { assertIdle }) => {
        assertIdle(); saved = input;
        // A concurrent proxy import can publish while the candidate is starting.
        services.events.publish("proxyState.changed", { nodes: [], status: { running: false }, network: get() });
        await Promise.resolve();
        saved = previous;
        throw startupError;
      } },
    clearRegionCache() { cacheClears++; }, bumpConfigEpoch() { epochBumps++; },
    scheduler: { status: () => ({ running: false, accounts: {} }) },
  } });
  services.events.subscribe((event) => { if (event.event === "proxyState.changed") events.push(event.payload); });
  await assert.rejects(services.execute({ method: "network.updateConfig", params: candidate, commandId: randomUUID() }), (error) => error.cause === startupError);
  assert.equal(events[0].network.config.mode, "system");
  assert.deepEqual(events.at(-1).network.config, previous);
  assert.equal(cacheClears, 0);
  assert.equal(epochBumps, 0);
  stateReadFails = true;
  await assert.rejects(services.execute({ method: "network.updateConfig", params: candidate, commandId: randomUUID() }), (error) => error.cause === startupError);
});

test("top-level interface-name and IP-DoH DNS bypass TUN and WFP port-53 in direct/relay modes", () => {
  const tunSnapshot = parseWindowsHostNetworkPayload({
    adapters: [
      { Name: "Mihomo", InterfaceDescription: "Meta Tunnel", InterfaceIndex: 55, Status: "Up", HardwareInterface: false, Virtual: true },
      { Name: "WLAN", InterfaceDescription: "Intel Wi-Fi 6E", InterfaceIndex: 11, Status: "Up", HardwareInterface: true, Virtual: false },
    ],
    routes: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, DestinationPrefix: "0.0.0.0/0", NextHop: "198.18.0.2", RouteMetric: 0, InterfaceMetric: 0 },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.4.1", RouteMetric: 0, InterfaceMetric: 35 },
    ],
    ips: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, IPAddress: "198.18.0.1" },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, IPAddress: "192.168.4.148" },
    ],
  });
  const restoreHost = configureHostNetworkDetector(() => tunSnapshot);
  const restoreStore = configureStoreBackend({ getGroups: () => [{ proxyId: dedicated.id }] });
  const restoreProxy = configureProxyStoreBackend({
    readProxyStore: () => ({ nodes: [dedicated], network: config("direct") }),
  });
  try {
    const runtime = buildConfig(21000);
    assert.equal(runtime["interface-name"], "WLAN");
    assert.equal(runtime.proxies[0]["interface-name"], "WLAN");
    assert.deepEqual(runtime.dns["default-nameserver"], [...DOH_IP_SERVERS]);
    assert.deepEqual(runtime.dns["proxy-server-nameserver"], [...DOH_IP_SERVERS]);
    assert.deepEqual(runtime.dns["direct-nameserver"], [...DOH_IP_SERVERS]);
    assert.ok(!runtime.dns.nameserver.includes("223.5.5.5"));
    assert.ok(!runtime.dns.nameserver.includes("1.1.1.1"));

    const info = getNetworkConfig();
    assert.equal(info.environment.effectiveOutboundInterface, "WLAN");
    assert.equal(info.environment.outboundInterfaceSource, "auto");
    assert.equal(info.environment.tunConflict.detected, true);
  } finally {
    restoreProxy();
    restoreStore();
    restoreHost();
  }
});

test("mixed system mode routes directOutbound nodes via physical NIC and #network-direct DNS while chaining others", () => {
  const hy2 = {
    id: "px_hy2",
    name: "HK HY2",
    enabled: true,
    missing: false,
    directOutbound: true,
    raw: { name: "HK HY2", type: "hysteria2", server: "hk.example.test", port: 443, password: "secret" },
  };
  const compiled = compileConnectionRoutes({
    nodes: [dedicated, hy2],
    proxyIds: [dedicated.id, hy2.id],
    network: config("system"),
    systemProxy,
    effectiveOutboundInterface: "WLAN",
  });
  assert.equal(compiled.mixedDirectAdapter, true);
  const outDedicated = compiled.adapters.find((item) => item.name === `out-${dedicated.id}`);
  const outHy2 = compiled.adapters.find((item) => item.name === "out-px_hy2");
  const directAdapter = compiled.adapters.find((item) => item.name === "network-direct");
  assert.equal(outDedicated["dialer-proxy"], "network-system");
  assert.equal(outDedicated["interface-name"], undefined);
  assert.equal(outHy2["dialer-proxy"], undefined);
  assert.equal(outHy2["interface-name"], "WLAN");
  assert.deepEqual(directAdapter, { name: "network-direct", type: "direct", "interface-name": "WLAN" });

  const cfg = buildMihomoRuntimeConfig({
    controlPort: 21999,
    adapters: compiled.adapters,
    listeners: [],
    mode: "system",
    effectiveOutboundInterface: "WLAN",
    mixedDirectAdapter: compiled.mixedDirectAdapter,
    tunConflictDetected: true,
  });
  assert.equal(cfg["interface-name"], undefined);
  assert.ok(cfg.dns["proxy-server-nameserver"].every((entry) => entry.endsWith("#network-direct")));
  assert.ok(cfg.dns.nameserver.every((entry) => entry.endsWith("#network-direct")));

  const bypass = buildDirectBypassConfig({ controlPort: 22999, listenerPort: 22998, outboundInterface: "WLAN" });
  assert.equal(bypass["interface-name"], "WLAN");
  assert.equal(bypass.listeners[0].proxy, "network-direct");
});

test("UDP protocols reject HTTP dialer-proxy clearly, support SOCKS5 udp:true, and do not abort batch tests", async () => {
  const hy2 = {
    id: "px_hy2",
    name: "JP HY2",
    enabled: true,
    missing: false,
    directOutbound: false,
    raw: { name: "JP HY2", type: "hysteria2", server: "jp.example.test", port: 443, password: "secret" },
  };
  assert.throws(
    () => compileConnectionRoutes({ nodes: [hy2], proxyIds: [hy2.id], network: config("system"), systemProxy }),
    (error) => error.code === "PROXY_UNAVAILABLE" && /hysteria2/.test(error.message) && /直连出站/.test(error.message)
  );
  assert.throws(
    () => compileConnectionRoutes({ nodes: [hy2, relay], proxyIds: [hy2.id], network: config("relay") }),
    (error) => error.code === "PROXY_UNAVAILABLE" && /hysteria2/.test(error.message)
  );
  const socksCompiled = compileConnectionRoutes({
    nodes: [hy2],
    proxyIds: [hy2.id],
    network: config("system"),
    systemProxy: { server: "socks5://127.0.0.1:7900", source: "manual", detail: "manual" },
  });
  const sysAdapter = socksCompiled.adapters.find((item) => item.name === "network-system");
  assert.equal(sysAdapter.type, "socks5");
  assert.equal(sysAdapter.udp, true);
  assert.equal(udpDialerConflict(hy2, { config: config("system"), systemProxy: { server: "socks5://127.0.0.1:7900" } }), null);

  const restoreStore = configureStoreBackend({ getGroups: () => [] });
  const restoreProxy = configureProxyStoreBackend({
    readProxyStore: () => ({ nodes: [hy2], network: config("system", { systemProxyUrl: systemProxy.server }) }),
  });
  try {
    const single = await testNode(hy2.id);
    assert.equal(single.ok, false);
    assert.match(single.message, /hysteria2/);
    const batch = await testAllNodes();
    assert.equal(batch.total, 1);
    assert.equal(batch.results[0].ok, false);
    assert.match(batch.results[0].message, /直连出站/);
  } finally {
    restoreProxy();
    restoreStore();
  }
});

test("SQLite v17 upgrades to v18 and preserves directOutbound across restarts and subscription refresh", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-direct-outbound-v17-"));
  const dbPath = path.join(root, "keeper.db");
  const db = new Database(dbPath);
  db.exec(MIGRATION_LEDGER_SQL);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 17)) {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)").run(
      migration.version,
      migration.name,
      migration.checksum,
      new Date().toISOString(),
      "fixture"
    );
  }
  db.pragma("user_version = 17");
  db.prepare("INSERT INTO proxy_nodes(id, sort_order, name, raw_json) VALUES (?,0,?,?)").run(
    dedicated.id,
    dedicated.name,
    JSON.stringify(dedicated.raw)
  );
  db.close();

  let repository = await openKeeperRepository({ filePath: dbPath });
  t.after(() => { repository.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(repository.getSchemaVersion(), SCHEMA_VERSION);
  assert.equal(repository.getProxyState().nodes[0].directOutbound, false);

  const adapters = createSqliteRuntimeAdapters(repository);
  const restoreStore = configureStoreBackend(adapters.store);
  const restoreProxy = configureProxyStoreBackend(adapters.proxy);
  try {
    const updated = await setNodeDirectOutbound(dedicated.id, true);
    assert.equal(updated.directOutbound, true);
    const merged = mergeSubscriptionNodes("src-1", [dedicated.raw], adapters.proxy.readProxyStore().nodes, new Set());
    assert.equal(merged.nodes[0].directOutbound, true);
    const legacyMerged = mergeProxyNodes([dedicated.raw], adapters.proxy.readProxyStore().nodes, new Set());
    assert.equal(legacyMerged.find((item) => item.name === dedicated.name).directOutbound, false);
    const persistedDirect = { ...dedicated, id: proxyNodeId(dedicated.name), directOutbound: true };
    const legacyKept = mergeProxyNodes([dedicated.raw], [persistedDirect], new Set());
    assert.equal(legacyKept[0].directOutbound, true);
  } finally {
    restoreProxy();
    restoreStore();
  }

  repository.close();
  repository = await openKeeperRepository({ filePath: dbPath });
  assert.equal(repository.getProxyState().nodes[0].directOutbound, true);
});

test("fetchSubscription routes through explicit HTTP proxy when provided", async (t) => {
  const http = await import("node:http");
  let proxiedHost = null;
  const proxyServer = http.createServer((req, res) => {
    proxiedHost = req.url;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("proxies:\n  - name: Proxied-Node\n    type: http\n    server: 198.51.100.10\n    port: 8080\n");
  });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => proxyServer.close(resolve)));

  const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
  const result = await fetchSubscription("http://sub.example.invalid/feed.yaml", { proxyUrl });
  assert.equal(result.error, undefined);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].name, "Proxied-Node");
  assert.equal(proxiedHost, "http://sub.example.invalid/feed.yaml");
});

test("single UDP conflict isolates only the conflicting node while healthy groups remain routable", () => {
  const hy2 = {
    id: "px_hy2_conflict",
    name: "JP HY2",
    enabled: true,
    missing: false,
    directOutbound: false,
    raw: { name: "JP HY2", type: "hysteria2", server: "jp.example.test", port: 443, password: "secret" },
  };
  const ssNoUdp = {
    id: "px_ss_no_udp",
    name: "SS No UDP",
    enabled: true,
    missing: false,
    directOutbound: false,
    raw: { name: "SS No UDP", type: "ss", server: "ss.example.test", port: 8388, cipher: "aes-256-gcm", password: "pw" },
  };
  const ssWithUdp = {
    id: "px_ss_udp",
    name: "SS With UDP",
    enabled: true,
    missing: false,
    directOutbound: false,
    raw: { name: "SS With UDP", type: "ss", server: "ss2.example.test", port: 8388, cipher: "aes-256-gcm", password: "pw", udp: true },
  };
  assert.equal(upstreamSupportsUdp(ssNoUdp.raw), false);
  assert.equal(upstreamSupportsUdp(ssWithUdp.raw), true);
  assert.equal(upstreamSupportsUdp(hy2.raw), true);

  const restoreStore = configureStoreBackend({
    getGroups: () => [{ proxyId: dedicated.id }, { proxyId: hy2.id }],
  });
  const restoreProxy = configureProxyStoreBackend({
    readProxyStore: () => ({
      nodes: [dedicated, hy2, ssNoUdp, ssWithUdp],
      network: config("system", { systemProxyUrl: systemProxy.server }),
    }),
  });
  try {
    const runtime = buildConfig(21000);
    assert.deepEqual(runtime.listeners.map((item) => item.name), [`in-${dedicated.id}`]);
    assert.ok(proxyForNode(dedicated.id)?.server);
    assert.equal(proxyForNode(hy2.id), null);
    assert.match(getNodeUdpConflict(hy2.id)?.message ?? "", /hysteria2/);
    assert.equal(getNodeUdpConflict(dedicated.id), null);

    const dto = getNodes();
    assert.ok(dto.find((item) => item.id === dedicated.id).localPort);
    assert.equal(dto.find((item) => item.id === hy2.id).localPort, null);
    assert.equal(dto.find((item) => item.id === ssNoUdp.id).udpSupported, false);
    assert.equal(dto.find((item) => item.id === ssWithUdp.id).udpSupported, true);
  } finally {
    restoreProxy();
    restoreStore();
  }
});

test("compileConnectionRoutes preserves existing node interface-name unless project overrides first hop", () => {
  const boundNode = {
    ...dedicated,
    raw: { ...dedicated.raw, "interface-name": "Ethernet-Sub" },
  };
  const directKeep = compileConnectionRoutes({
    nodes: [boundNode],
    proxyIds: [boundNode.id],
    network: config("direct"),
    effectiveOutboundInterface: null,
  });
  assert.equal(directKeep.adapters[0]["interface-name"], "Ethernet-Sub");

  const directOverride = compileConnectionRoutes({
    nodes: [boundNode],
    proxyIds: [boundNode.id],
    network: config("direct"),
    effectiveOutboundInterface: "WLAN",
  });
  assert.equal(directOverride.adapters[0]["interface-name"], "WLAN");

  const chainedStrip = compileConnectionRoutes({
    nodes: [boundNode],
    proxyIds: [boundNode.id],
    network: config("system"),
    systemProxy,
  });
  assert.equal(chainedStrip.adapters.find((item) => item.name === `out-${boundNode.id}`)["interface-name"], undefined);
});

test("setNodeDirectOutbound enforces assertIdle only for bound nodes with changed value", async () => {
  let proxyStore = {
    nodes: [dedicated, relay],
    network: config("direct"),
  };
  let idleChecks = 0;
  let active = true;
  const restoreStore = configureStoreBackend({
    getGroups: () => [{ id: "g1", proxyId: dedicated.id }],
    getAccounts: () => [],
  });
  const restoreProxy = configureProxyStoreBackend({
    readProxyStore: () => proxyStore,
    writeProxyStore: (value) => { proxyStore = value; },
  });
  try {
    // Unbound node does not touch runtime and skips assertIdle.
    const unbound = await setNodeDirectOutbound(relay.id, true, {
      assertIdle: () => { idleChecks++; throw Object.assign(new Error("busy"), { code: "RESOURCE_BUSY" }); },
    });
    assert.equal(unbound.directOutbound, true);
    assert.equal(idleChecks, 0);

    // Bound node calls assertIdle and rejects when Chrome is active.
    const services = new ApplicationServices({
      runtime: {
        store: { getAccounts: () => [], getGroups: () => [{ id: "g1", proxyId: dedicated.id }] },
        getOpenPages: () => ({}),
        listQuarantined: () => [],
        browserRuns: { listActive: () => (active ? [{ state: "running" }] : []) },
        proxies: { getNetworkConfig, getNodes, status: () => ({ running: false }), setNodeDirectOutbound },
        clearRegionCache() {},
        bumpConfigEpoch() {},
        scheduler: { status: () => ({ running: false, accounts: {} }) },
      },
    });
    const op = await services.invoke("proxies.setNodeDirectOutbound", { id: dedicated.id, directOutbound: true });
    const finished = await services.operations.waitForTerminal(op.id);
    assert.equal(finished.state, "failed");
    assert.equal(finished.error.code, "RESOURCE_BUSY");
    assert.equal(proxyStore.nodes.find((item) => item.id === dedicated.id).directOutbound, undefined);
    services.dispose();
  } finally {
    restoreProxy();
    restoreStore();
  }
});

test("ensureDirectBypassProxy fails closed when manual outboundInterface is set but mihomo is unavailable", async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-no-mihomo-"));
  const tunSnapshot = parseWindowsHostNetworkPayload({
    adapters: [
      { Name: "Mihomo", InterfaceDescription: "Meta Tunnel", InterfaceIndex: 55, Status: "Up", HardwareInterface: false, Virtual: true },
      { Name: "WLAN", InterfaceDescription: "Intel Wi-Fi", InterfaceIndex: 11, Status: "Up", HardwareInterface: true, Virtual: false },
    ],
    routes: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, DestinationPrefix: "0.0.0.0/0", NextHop: "198.18.0.2", RouteMetric: 0, InterfaceMetric: 0 },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.4.1", RouteMetric: 0, InterfaceMetric: 35 },
    ],
    ips: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, IPAddress: "198.18.0.1" },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, IPAddress: "192.168.4.148" },
    ],
  });
  const restoreHost = configureHostNetworkDetector(() => tunSnapshot);
  const restoreProxy = configureProxyStoreBackend({
    readProxyStore: () => ({
      nodes: [],
      clashVergeDir: emptyDir,
      mihomoPath: path.join(emptyDir, "missing-mihomo.exe"),
      network: config("direct", { outboundInterface: "WLAN" }),
    }),
  });
  try {
    // Only assert manual-NIC fail-closed when project bin/ has no bundled mihomo fallback;
    // otherwise skip if a host binary is found via fallback search paths.
    try {
      const bypass = await ensureDirectBypassProxy();
      assert.ok(bypass?.outboundInterface === "WLAN");
    } catch (error) {
      assert.equal(error.code, "PROXY_UNAVAILABLE");
      assert.match(error.message, /WLAN/);
    }
  } finally {
    stopAll();
    restoreProxy();
    restoreHost();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});
