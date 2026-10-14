import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { compileConnectionRoutes, normalizeNetworkConfig } from "../src/network/connectionMode.js";
import { waitMihomoConfigApplied } from "../src/network/mihomoReadiness.js";

const enabled = process.env.GPT_ACCOUNT_CONNECTION_LAB === "1";
const core = path.resolve(process.env.GPT_ACCOUNT_CONNECTION_LAB_MIHOMO || "artifacts/release-input/mihomo/mihomo-windows-amd64-compatible.exe");

test("real mihomo forwards three modes and duplicate hops through loopback fixtures", { skip: !enabled, timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keeper-connection-lab-"));
  const servers = [], sockets = new Set(), observations = [], counts = { system: 0, relay: 0, dedicated: 0, origin: 0 };
  let child = null;
  const listen = async (server) => { servers.push(server); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return server.address().port; };
  const track = (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket; };
  const stopCore = async () => {
    const proc = child; child = null;
    if (!proc || proc.exitCode !== null) return;
    await new Promise((resolve) => { proc.once("exit", resolve); proc.kill(); });
  };
  t.after(async () => { await stopCore(); for (const socket of sockets) socket.destroy(); await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });
  const origin = http.createServer((_req, res) => { counts.origin++; res.end("local-chain-ok"); });
  origin.on("connection", track);
  const originPort = await listen(origin);
  const allowed = new Set([originPort]);
  const tunnel = async (label) => {
    const proxy = http.createServer((_req, res) => res.writeHead(403).end());
    proxy.on("connection", track);
    proxy.on("connect", (req, client, head) => {
      const [host, value] = req.url.split(":"); const port = Number(value);
      observations.push({ proxy: label, target: req.url, authenticated: req.headers["proxy-authorization"] === `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}` });
      if (host !== "127.0.0.1" || !allowed.has(port)) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      counts[label]++;
      const remote = track(net.connect({ host, port }, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); }));
      client.on("close", () => remote.destroy());
      remote.on("error", () => client.destroy());
    });
    const port = await listen(proxy); allowed.add(port); return port;
  };
  const dedicatedPort = await tunnel("dedicated"), relayPort = await tunnel("relay"), systemPort = await tunnel("system");
  const node = (id, port) => ({ id, name: id, enabled: true, raw: { name: id, type: "http", server: "127.0.0.1", port } });
  const dedicated = node("dedicated", dedicatedPort), relay = node("relay", relayPort), system = node("system", systemPort);
  const authenticatedSystem = { ...system, id: "authenticated-system", raw: { ...system.raw, username: "fixture-user", password: "fixture-password" } };
  const reserve = net.createServer(); const entryPort = await listen(reserve); await new Promise((resolve) => reserve.close(resolve)); servers.splice(servers.indexOf(reserve), 1);
  const control = net.createServer(); const controlPort = await listen(control); await new Promise((resolve) => control.close(resolve)); servers.splice(servers.indexOf(control), 1);
  const request = () => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: entryPort, path: `http://127.0.0.1:${originPort}/`, headers: { Host: `127.0.0.1:${originPort}` }, agent: false }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    }); req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("loopback request timed out")));
  });
  for (const [mode, selected, expected] of [
    ["direct", dedicated, { dedicated: 1, relay: 0, system: 0 }],
    ["system", dedicated, { dedicated: 1, relay: 0, system: 1 }],
    ["relay", dedicated, { dedicated: 1, relay: 1, system: 0 }],
    ["relay", relay, { dedicated: 0, relay: 1, system: 0 }],
    ["system", system, { dedicated: 0, relay: 0, system: 1 }],
    ["system", authenticatedSystem, { dedicated: 0, relay: 0, system: 1 }],
  ]) {
    await stopCore();
    const network = normalizeNetworkConfig({ mode, ...(mode === "relay" ? { relayProxyId: relay.id } : {}) });
    const { adapters } = compileConnectionRoutes({ nodes: [dedicated, relay, system, authenticatedSystem], proxyIds: [selected.id], network,
      systemProxy: { server: `http://127.0.0.1:${systemPort}`, source: "manual" } });
    const cfg = { "mixed-port": 0, "allow-lan": false, ipv6: false, mode: "rule", "log-level": "warning", "external-controller": `127.0.0.1:${controlPort}`,
      proxies: adapters, listeners: [{ name: "fixture", type: "http", listen: "127.0.0.1", port: entryPort, proxy: `out-${selected.id}` }], rules: ["MATCH,REJECT"] };
    const cfgPath = path.join(root, "config.yaml"); await fs.writeFile(cfgPath, YAML.stringify(cfg));
    child = spawn(core, ["-d", root, "-f", cfgPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "", failure = null;
    child.on("error", (error) => { failure = error; }); child.stdout.on("data", (chunk) => { diagnostic += chunk; }); child.stderr.on("data", (chunk) => { diagnostic += chunk; });
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`mihomo stopped: ${diagnostic}`);
      ready = await new Promise((resolve) => { const socket = net.connect({ host: "127.0.0.1", port: entryPort }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); });
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, diagnostic);
    assert.deepEqual(await waitMihomoConfigApplied(controlPort, cfg, { timeoutMs: 3000, shouldStop: () => child.exitCode !== null }), { ok: true }, diagnostic);
    const before = { ...counts };
    const response = await request();
    if (response.status !== 200) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(response, { status: 200, body: "local-chain-ok" }, `${mode}/${selected.id}: ${JSON.stringify({ counts, before, observations })}\n${diagnostic}`);
    for (const key of ["system", "relay", "dedicated"]) assert.equal(counts[key] - before[key], expected[key], `${mode}/${selected.id}: ${key} forwarding count`);
    assert.equal(counts.origin - before.origin, 1);
    if (selected.id === authenticatedSystem.id) assert.equal(observations.at(-1).authenticated, true);
  }
});

test("network runtime handles failed startup and occupied ports", { skip: !enabled, timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keeper-connection-rollback-"));
  // Set the cache root before importing paths/proxyManager, whose roots are immutable.
  const oldCacheRoot = process.env.GPT_ACCOUNT_KEEPER_CACHE_ROOT;
  process.env.GPT_ACCOUNT_KEEPER_CACHE_ROOT = root;
  const { configureProxyStoreBackend, getNetworkConfig, setNetworkConfig, testNode, stopAll } = await import("../src/proxyManager.js");
  const { configureStoreBackend } = await import("../src/store.js");
  const invalid = { id: "invalid", name: "invalid", enabled: true, raw: { name: "invalid", type: "unsupported-fixture", server: "127.0.0.1", port: 1234 } };
  let stored = { nodes: [invalid], mihomoPath: core, network: normalizeNetworkConfig({ mode: "direct" }) };
  let candidateSaved = false;
  let concurrentImport = false;
  let groups = [];
  const restoreStore = configureStoreBackend({ getGroups: () => groups });
  const restoreProxy = configureProxyStoreBackend({ readProxyStore: () => {
    if (candidateSaved && !concurrentImport) {
      concurrentImport = true;
      stored.nodes.push({ id: "custom_concurrent", name: "concurrent", enabled: true, raw: { name: "concurrent", type: "http", server: "127.0.0.1", port: 1235 } });
    }
    return structuredClone(stored);
  }, writeProxyStore: (value) => { stored = structuredClone(value); if (value.network.mode === "relay") candidateSaved = true; } });
  t.after(async () => { stopAll(); restoreProxy(); restoreStore(); if (oldCacheRoot == null) delete process.env.GPT_ACCOUNT_KEEPER_CACHE_ROOT; else process.env.GPT_ACCOUNT_KEEPER_CACHE_ROOT = oldCacheRoot; assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });
  await t.test("failed startup restores the mode without losing concurrent imports", async () => {
    await assert.rejects(setNetworkConfig(normalizeNetworkConfig({ mode: "relay", relayProxyId: invalid.id })), /mihomo/);
    assert.equal(getNetworkConfig().config.mode, "direct");
    assert.equal(stored.nodes.length, 2);
    assert.equal(stored.nodes[1].id, "custom_concurrent");
  });

  const usable = { id: "usable", name: "usable", enabled: true, raw: { name: "usable", type: "http", server: "127.0.0.1", port: 1235 } };
  const occupy = async (subtest, port, onRequest) => {
    const server = http.createServer(onRequest);
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      subtest.skip(`fixture port ${port} already occupied`);
      return null;
    }
    subtest.after(() => new Promise((resolve) => server.close(resolve)));
    return server;
  };
  await t.test("latency testing never sends config to an occupied control port", async (subtest) => {
    let requests = 0;
    const server = await occupy(subtest, 20999, (_request, response) => { requests++; response.writeHead(204).end(); });
    if (!server) return;
    stored = { nodes: [usable], mihomoPath: core, network: normalizeNetworkConfig({ mode: "direct" }) };
    await assert.rejects(testNode(usable.id), /20999.*占用/);
    assert.equal(requests, 0);
    assert.equal(server.listening, true);
  });
  await t.test("a system proxy on the preferred port makes the private runtime choose another range", async (subtest) => {
    let requests = 0;
    const server = await occupy(subtest, 30000, (_request, response) => { requests++; response.writeHead(204).end(); });
    if (!server) return;
    stopAll();
    stored = { nodes: [usable], mihomoPath: core, basePort: 30000, network: normalizeNetworkConfig({ mode: "direct" }) };
    groups = [{ proxyId: usable.id }];
    subtest.after(() => { groups = []; return setNetworkConfig(normalizeNetworkConfig({ mode: "direct" })); });
    const result = await setNetworkConfig(normalizeNetworkConfig({ mode: "system", systemProxyUrl: "http://127.0.0.1:30000" }));
    assert.equal(result.config.mode, "system");
    const { status, buildConfig } = await import("../src/proxyManager.js");
    assert.equal(status().running, true);
    assert.notEqual(status().basePort, 30000);
    assert.equal(buildConfig().proxies.find((entry) => entry.name === "network-system").port, 30000);
    await assert.rejects(setNetworkConfig(normalizeNetworkConfig({ mode: "system", systemProxyUrl: `http://127.0.0.1:${status().basePort}` })), /循环转发/);
    assert.equal(getNetworkConfig().config.systemProxyUrl, "http://127.0.0.1:30000");
    assert.equal(status().running, true);
    assert.equal(requests, 0);
    assert.equal(server.listening, true);
  });
});
