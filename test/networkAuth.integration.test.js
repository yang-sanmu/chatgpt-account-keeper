import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { stringify } from "yaml";
import { ChromeLauncherBroker, resolveBrokerExecutable } from "../src/chromeLauncherBroker.js";
import { buildLaunchArgs } from "../src/chromeProcessLauncher.js";
import { RawCdpConnection, findChromeExecutable, probeHeadlessIdentity, reserveLocalDebugPort, waitForDevToolsEndpoint, waitForInteractiveCdp } from "../src/browser.js";
import { buildStrictProxyConfig, newProxyCredentials, STRICT_RESOLVER_ARGUMENT } from "../src/network/strictConfig.js";
import { installBrowserStartupBarrier } from "../src/network/browserStartupBarrier.js";
import { probeMihomoAuthentication } from "../src/network/proxyAuthenticationProbe.js";

// Explicit opt-in: uses only newly created test Profiles; never installs WFP rules.
const enabled = process.env.GPT_ACCOUNT_NETWORK_LAB === "1" && process.platform === "win32";
const mihomoPath = path.resolve(process.env.GPT_ACCOUNT_NETWORK_LAB_MIHOMO
  || "artifacts/release-input/mihomo/mihomo-windows-amd64-compatible.exe");

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
function proxyRequest(port, url, credentials) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: url, agent: false,
      headers: { Host: new URL(url).host, ...(credentials ? { "Proxy-Authorization": `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` } : {}) },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("Proxy request timed out")));
  });
}
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    if (await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => resolve(false)); socket.on("connect", () => { socket.destroy(); resolve(true); });
    })) return;
    await delay(100);
  }
  throw new Error("Lab proxy failed to listen");
}

for (const headless of [true, false]) {
  test(`M1 loopback authentication: ${headless ? "headless" : "headed"}`, { skip: !enabled, timeout: 100_000 }, async (t) => {
    assert.ok(resolveBrokerExecutable(), "Build the broker first");
    const chrome = findChromeExecutable(); assert.ok(chrome);
    await fs.access(mihomoPath);
    const base = path.resolve("artifacts/network-lab");
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, "auth-"));
    const broker = new ChromeLauncherBroker({ log: { warn() {}, info() {}, error() {} } });
    const sockets = new Set();
    const observations = { originRequests: 0, originReceivedProxyPassword: false, websiteReceivedAuthorization: false, upstreamRequests: 0 };
    const credentials = [newProxyCredentials(), newProxyCredentials()];
    const report = { kind: "loopback-auth", headless, wfpVerified: false, productionReady: false, checks: [] };
    const firstWorkerEnvironment = 'const first = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, ua: navigator.userAgent };';
    const mark = (check) => report.checks.push(check);
    let browser; let barrier; let failure; let rawCdp;
    const servers = [];
    const track = (server) => {
      servers.push(server);
      server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
      return server;
    };
    t.after(async () => {
      barrier?.close();
      if (browser) await browser.close().catch(() => {});
      await broker.dispose();
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
      report.observations = observations;
      report.auth = barrier?.state ?? null;
      report.failureCode = failure?.code ?? null;
      report.failureDetails = failure?.details ?? null;
      await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
      t.diagnostic(`Sanitized report: ${path.join(root, "report.json")}`);
      // Test passwords are no longer needed after all Job handles close.
      for (const id of ["a", "b"]) await fs.rm(path.join(root, id, "config.yaml"), { force: true });
    });
    const origin = track(http.createServer((req, res) => {
      observations.originRequests++;
      if (req.headers["proxy-authorization"]) observations.originReceivedProxyPassword = true;
      if (req.url === "/401") {
        if (req.headers.authorization) observations.websiteReceivedAuthorization = true;
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="website"' }); res.end("website authentication"); return;
      }
      if (req.url === "/403") { res.writeHead(403).end(); return; }
      if (req.url === "/worker.js") { res.setHeader("Content-Type", "text/javascript"); res.end(firstWorkerEnvironment + 'fetch("/worker-fetch").then(r=>r.text()).then(value=>postMessage({value,first}))'); return; }
      if (req.url === "/shared.js") { res.setHeader("Content-Type", "text/javascript"); res.end(firstWorkerEnvironment + 'onconnect=e=>fetch("/shared-fetch").then(r=>r.text()).then(value=>e.ports[0].postMessage({value,first}))'); return; }
      if (req.url === "/sw.js") { res.setHeader("Content-Type", "text/javascript"); res.end(firstWorkerEnvironment + 'addEventListener("install",e=>e.waitUntil(fetch("/service-fetch"))); addEventListener("activate",e=>e.waitUntil(clients.claim())); addEventListener("message",e=>e.ports[0].postMessage(first))'); return; }
      res.setHeader("Content-Type", req.url?.endsWith("fetch") ? "text/plain" : "text/html");
      res.end(req.url?.endsWith("fetch") ? "ok" : `<!doctype html><title>network lab</title><script>
        window.initialEnvironment = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, ua: navigator.userAgent };
      </script>`);
    }));
    const originPort = await listen(origin);
    const originUrl = `http://127.0.0.1:${originPort}`;
    const ws = new WebSocketServer({ server: origin }); ws.on("connection", (socket) => socket.send("ok"));
    t.after(() => ws.close());

    // This upstream refuses every destination except this test's own loopback server.
    const upstream = track(http.createServer((req, res) => {
      let target; try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
      if (target.hostname !== "127.0.0.1" || Number(target.port) !== originPort) { res.writeHead(403).end(); return; }
      observations.upstreamRequests++;
      const headers = { ...req.headers }; delete headers["proxy-authorization"];
      const forward = http.request(target, { method: req.method, headers }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      forward.on("error", () => res.destroy()); req.pipe(forward);
    }));
    upstream.on("connect", (req, client, head) => {
      if (req.url !== `127.0.0.1:${originPort}`) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      observations.upstreamRequests++;
      const remote = net.connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
      });
      sockets.add(remote); remote.on("error", () => client.destroy()); remote.on("close", () => { sockets.delete(remote); client.destroy(); }); client.on("close", () => remote.destroy());
    });
    const upstreamPort = await listen(upstream);
    await broker.start();
    const ports = [];
    for (const [index, id] of ["a", "b"].entries()) {
      const dir = path.join(root, id); await fs.mkdir(dir);
      const exe = path.join(dir, "mihomo.exe"); await fs.copyFile(mihomoPath, exe);
      const port = await reserveLocalDebugPort(); ports.push(port);
      const { config } = buildStrictProxyConfig({ raw: { name: "fixture", type: "http", server: "127.0.0.1", port: upstreamPort },
        approvedAddress: "127.0.0.1", listenerPort: port, credentials: credentials[index] });
      await fs.writeFile(path.join(dir, "config.yaml"), stringify(config));
      await broker.launch(broker.newRunToken(), exe, ["-d", dir, "-f", path.join(dir, "config.yaml")], dir);
      await waitPort(port);
    }
    for (const supplied of [null, { username: credentials[0].username, password: "wrong" }, credentials[1]]) {
      const before = observations.upstreamRequests;
      assert.ok([403, 407].includes(await proxyRequest(ports[0], `${originUrl}/denied`, supplied)));
      assert.equal(observations.upstreamRequests, before);
    }
    const beforeProbe = observations.upstreamRequests;
    for (const [index, expected] of [[0, "accepted"], [1, "rejected"]]) {
      const result = await probeMihomoAuthentication({ proxyOrigin: `http://127.0.0.1:${ports[0]}`, credentials: credentials[index] });
      assert.equal(result.status, expected); assert.equal(observations.upstreamRequests, beforeProbe);
    }
    mark("local-credential-probe-positive-negative-without-upstream");
    assert.equal(await proxyRequest(ports[0], `${originUrl}/allowed`, credentials[0]), 200);
    mark("missing-wrong-cross-group-credentials-denied-before-upstream");
    const profile = path.join(root, "profile"); await fs.mkdir(profile);
    const identity = headless ? await probeHeadlessIdentity("chrome") : null;
    const environment = { locale: "de-DE", timezone: "Europe/Berlin" };
    const debugPort = headless ? 0 : await reserveLocalDebugPort();
    const args = buildLaunchArgs({ userDataDir: profile, launchArgs: { locale: environment.locale, userAgent: identity?.userAgent,
      args: [STRICT_RESOLVER_ARGUMENT], proxy: { server: `http://127.0.0.1:${ports[0]}`, bypass: "<-loopback>" } }, headless, debugPort });
    args.unshift("--disable-background-networking");
    const token = broker.newRunToken(); const startedAt = Date.now();
    await broker.launch(token, chrome, args);
    const endpoint = headless ? await waitForDevToolsEndpoint(profile, startedAt) : (await waitForInteractiveCdp(debugPort), `http://127.0.0.1:${debugPort}`);
    let rawConnections = 0;
    barrier = await installBrowserStartupBarrier({ endpoint, proxyOrigin: `http://127.0.0.1:${ports[0]}`, credentials: credentials[0], identity, environment,
      connect: async endpoint => { rawConnections++; rawCdp = await RawCdpConnection.connect(endpoint); return rawCdp; },
      onFailure(error) { failure = error; void broker.terminate(token); } });
    browser = await chromium.connectOverCDP(endpoint); const context = browser.contexts()[0];
    const page = context.pages()[0]; page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(12_000);
    assert.equal((await page.goto(originUrl)).status(), 200); assert.ok(barrier.state.provided > 0); mark("first-navigation-authenticated");
    const assertEnvironment = first => {
      assert.equal(first.timezone, environment.timezone); assert.equal(first.locale, environment.locale);
      assert.equal(first.language, environment.locale); assert.doesNotMatch(first.ua, /HeadlessChrome/u);
    };
    const checkEnvironment = async target => assertEnvironment(await target.evaluate(() => window.initialEnvironment));
    await checkEnvironment(page); assert.equal(rawConnections, 1); mark("combined-environment-auth-first-script");
    assert.equal((await page.goto(`${originUrl}/401`)).status(), 401);
    assert.equal(observations.websiteReceivedAuthorization, false); assert.equal(observations.originReceivedProxyPassword, false); mark("website-401-does-not-receive-proxy-password");
    assert.equal(await page.evaluate(() => fetch("/403").then(response => response.status)), 403);
    assert.equal(barrier.state.ready, true); assert.equal(failure, undefined);
    assert.equal((await probeMihomoAuthentication({ proxyOrigin: `http://127.0.0.1:${ports[0]}`, credentials: credentials[0] })).status, "accepted");
    mark("website-403-preserved-with-separate-credential-diagnostic");
    await page.goto(originUrl);
    const popupPromise = context.waitForEvent("page"); await page.evaluate((url) => window.open(url), `${originUrl}/popup`);
    const popup = await popupPromise; await popup.waitForLoadState(); await checkEnvironment(popup); await popup.close(); mark("popup");
    await page.evaluate(() => new Promise((resolve, reject) => { const frame = document.createElement("iframe"); frame.src = "/iframe"; frame.onload = resolve; frame.onerror = reject; document.body.append(frame); })); mark("iframe");
    await checkEnvironment(page.frames().find(frame => frame.url() === `${originUrl}/iframe`));
    const wsResult = await page.evaluate((port) => new Promise((resolve, reject) => { const s = new WebSocket(`ws://127.0.0.1:${port}/ws`); s.onmessage = e => { resolve(e.data); s.close(); }; s.onerror = reject; }), originPort);
    assert.equal(wsResult, "ok"); mark("websocket");
    const dedicated = await page.evaluate(() => new Promise((resolve, reject) => { const w = new Worker("/worker.js"); w.onmessage = e => { resolve(e.data); w.terminate(); }; w.onerror = reject; }));
    assert.equal(dedicated.value, "ok"); assertEnvironment(dedicated.first); mark("dedicated-worker-first-environment-and-fetch");
    const shared = await page.evaluate(() => new Promise((resolve, reject) => { const w = new SharedWorker("/shared.js"); w.port.onmessage = e => { resolve(e.data); w.port.close(); }; w.onerror = reject; }));
    assert.equal(shared.value, "ok"); assertEnvironment(shared.first); mark("shared-worker-first-environment-and-fetch");
    const service = await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js"); const registration = await navigator.serviceWorker.ready;
      return new Promise(resolve => {
        const channel = new MessageChannel(); channel.port1.onmessage = e => { channel.port1.close(); resolve(e.data); };
        registration.active.postMessage("initial-environment", [channel.port2]);
      });
    });
    assertEnvironment(service); mark("service-worker-install-fetch-and-first-environment");
    assert.equal(failure, undefined); assert.equal(barrier.state.ready, true);
    rawCdp.socket.terminate();
    assert.equal((await broker.waitForEmpty(token, 10_000)).count, 0); mark("browser-job-empty");
    assert.equal(failure?.code, "PROXY_AUTH_BARRIER_FAILED"); mark("cdp-loss-closes-job");
    await broker.dispose_(token); await broker.forget(token);
    report.passed = true;
  });
}
