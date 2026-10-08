import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { stringify } from "yaml";
import { ChromeLauncherBroker, resolveBrokerExecutable } from "../src/chromeLauncherBroker.js";
import { buildLaunchArgs } from "../src/chromeProcessLauncher.js";
import { RawCdpConnection, findChromeExecutable, probeHeadlessIdentity, reserveLocalDebugPort, waitForDevToolsEndpoint, waitForInteractiveCdp } from "../src/browser.js";
import { buildStrictProxyConfig, newProxyCredentials, STRICT_RESOLVER_ARGUMENT } from "../src/network/strictConfig.js";
import { installBrowserStartupBarrier } from "../src/network/browserStartupBarrier.js";
import { createLabCertificates, createTrustedLabProfile } from "./helpers/networkTlsFixture.js";

const enabled = process.env.GPT_ACCOUNT_NETWORK_LAB === "1" && process.platform === "win32";
const mihomoPath = path.resolve(process.env.GPT_ACCOUNT_NETWORK_LAB_MIHOMO || "artifacts/release-input/mihomo/mihomo-windows-amd64-compatible.exe");
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    const ready = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => resolve(false)); socket.on("connect", () => { socket.destroy(); resolve(true); });
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error("Local proxy did not start");
}
function assertEnvironment(first, expected) {
  assert.equal(first.timezone, expected.timezone); assert.equal(first.locale, expected.locale);
  assert.equal(first.language, expected.locale); assert.doesNotMatch(first.ua, /HeadlessChrome/u);
}

for (const [headless, coldAuthOnly] of [[true, false], [true, true], [false, false], [false, true]]) {
  test(`${coldAuthOnly ? "M1 cold authentication acceptance gate" : "M1 HTTPS/WSS, OOPIF and concurrent groups"}: ${headless ? "headless" : "headed"}`, { skip: !enabled, timeout: 150_000 }, async t => {
    assert.ok(resolveBrokerExecutable(), "Build the broker first"); const chrome = findChromeExecutable(); assert.ok(chrome);
    await fs.access(mihomoPath);
    const base = path.resolve("artifacts/network-lab"); await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, "matrix-")); const certificateDirectory = path.join(root, "certificates");
    const report = { kind: coldAuthOnly ? "cold-auth-gate" : "https-auth-matrix", headless, passed: false, wfpVerified: false, productionReady: false, checks: [] };
    const broker = new ChromeLauncherBroker({ log: { warn() {}, info() {}, error() {} } });
    const runs = []; const groups = []; const servers = []; const sockets = new Set(); const sources = new Map();
    const observations = { connect: { a: 0, b: 0 }, unexpectedDestinations: 0, originRequests: 0, directRequests: 0, leakedAuthorization: false };
    const track = server => {
      servers.push(server);
      server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
      return server;
    };
    let ws;
    t.after(async () => {
      for (const run of runs) { run.barrier?.close(); await run.browser?.close().catch(() => {}); }
      await broker.dispose();
      for (const socket of sockets) socket.destroy(); ws?.close();
      for (const server of servers) server.close();
      for (const id of ["a", "b"]) await fs.rm(path.join(root, id, "config.yaml"), { force: true });
      for (const file of ["server.key", "untrusted.key"]) await fs.rm(path.join(certificateDirectory, file), { force: true });
      report.observations = observations;
      report.runs = runs.map(run => ({ label: run.label, failureCode: run.failure?.code ?? null,
        failureDetails: run.failure?.details ?? null, networkErrors: run.networkErrors, navigationError: run.navigationError ?? null,
        auth: run.barrier?.state ?? null, jobEmpty: run.jobEmpty ?? false }));
      await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
      t.diagnostic(`Sanitized report: ${path.join(root, "report.json")}`);
    });
    const certificates = await createLabCertificates(certificateDirectory);
    report.testRootSha256 = createHash("sha256").update(certificates.rootDer).digest("hex");
    report.certificateTrustScope = "fresh-test-profiles-only";
    const origin = track(https.createServer(certificates.trusted, (req, res) => {
      const via = sources.get(req.socket.remotePort) ?? "direct";
      observations.originRequests++; if (via === "direct") observations.directRequests++;
      if (req.headers["proxy-authorization"] || req.headers.authorization) observations.leakedAuthorization = true;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.url === "/cold-fetch") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ via })); return; }
      if (req.url === "/401") { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="website"' }); res.end("website authentication"); return; }
      if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ via, cookie: req.headers.cookie ?? "" })); return; }
      if (req.url === "/seed") res.setHeader("Set-Cookie", `fixture-group=${via}; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/`);
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><title>network lab</title><script>
        window.initialEnvironment = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, ua: navigator.userAgent };
        window.via = ${JSON.stringify(via)};
      </script>`);
    }));
    const originPort = await listen(origin); const originUrl = `https://127.0.0.1:${originPort}`;
    const untrusted = track(https.createServer(certificates.untrusted, (_req, res) => res.end("must never load")));
    const untrustedPort = await listen(untrusted);
    ws = new WebSocketServer({ server: origin });
    ws.on("connection", (socket, req) => {
      if (req.headers["proxy-authorization"] || req.headers.authorization) observations.leakedAuthorization = true;
      socket.send(JSON.stringify({ via: sources.get(req.socket.remotePort) ?? "direct" }));
    });
    // Only these exact fixture endpoints can be reached. The alternate numeric
    // loopback sites map to the same local origin; no hosts/DNS setting is changed.
    const allowed = new Map([[`127.0.0.1:${originPort}`, originPort], [`127.0.0.2:${originPort}`, originPort],
      [`127.0.0.3:${originPort}`, originPort], [`127.0.0.1:${untrustedPort}`, untrustedPort]]);
    await broker.start();
    for (const [id, environment] of [["a", { locale: "de-DE", timezone: "Europe/Berlin" }], ["b", { locale: "en-US", timezone: "America/New_York" }]]) {
      const upstream = track(http.createServer((_req, res) => { res.writeHead(403).end(); }));
      upstream.on("connect", (req, client, head) => {
        const port = allowed.get(req.url);
        if (!port) { observations.unexpectedDestinations++; client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
        observations.connect[id]++;
        const remote = net.connect(port, "127.0.0.1", () => {
          sources.set(remote.localPort, id);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head);
          client.pipe(remote); remote.pipe(client);
        });
        let sourcePort; remote.on("connect", () => { sourcePort = remote.localPort; });
        sockets.add(remote); remote.on("error", () => client.destroy());
        remote.on("close", () => { sources.delete(sourcePort); sockets.delete(remote); client.destroy(); });
        client.on("close", () => remote.destroy()); client.on("error", () => remote.destroy());
      });
      const upstreamPort = await listen(upstream); const directory = path.join(root, id); await fs.mkdir(directory);
      const exe = path.join(directory, "mihomo.exe"); await fs.copyFile(mihomoPath, exe);
      const port = await reserveLocalDebugPort(); const credentials = newProxyCredentials();
      const { config } = buildStrictProxyConfig({ raw: { name: "fixture", type: "http", server: "127.0.0.1", port: upstreamPort },
        approvedAddress: "127.0.0.1", listenerPort: port, credentials });
      config["log-level"] = "silent"; // Fixture only; broker stdout handling remains a separate production gate.
      await fs.writeFile(path.join(directory, "config.yaml"), stringify(config));
      await broker.launch(broker.newRunToken(), exe, ["-d", directory, "-f", path.join(directory, "config.yaml")], directory);
      await waitPort(port);
      const profile = await createTrustedLabProfile(root, `profile-${id}`, certificates.rootDer);
      groups.push({ id, port, credentials, profile, environment });
    }
    const identity = headless ? await probeHeadlessIdentity("chrome") : null;
    async function launch(group, label, { profile = group.profile, expectedPort = group.port, credentials = group.credentials } = {}) {
      const token = broker.newRunToken(); const run = { label, token, networkErrors: [] }; runs.push(run);
      await fs.rm(path.join(profile, "DevToolsActivePort"), { force: true });
      const debugPort = headless ? 0 : await reserveLocalDebugPort();
      const args = buildLaunchArgs({ userDataDir: profile, headless, debugPort, launchArgs: {
        locale: group.environment.locale, userAgent: identity?.userAgent,
        args: [STRICT_RESOLVER_ARGUMENT],
        proxy: { server: `http://127.0.0.1:${group.port}`, bypass: "<-loopback>" },
      } });
      args.unshift("--site-per-process", "--disable-background-networking");
      assert.equal(args.some(arg => /ignore-certificate|allow-insecure|disable-web-security/u.test(arg)), false);
      const startedAt = Date.now(); await broker.launch(token, chrome, args);
      const endpoint = headless ? await waitForDevToolsEndpoint(profile, startedAt) : (await waitForInteractiveCdp(debugPort), `http://127.0.0.1:${debugPort}`);
      run.barrier = await installBrowserStartupBarrier({ endpoint, proxyOrigin: `http://127.0.0.1:${expectedPort}`, credentials, identity, environment: group.environment,
        connect: async endpoint => {
          run.cdp = await RawCdpConnection.connect(endpoint);
          run.cdp.onEvent(message => {
            if (message.method === "Network.loadingFailed" && /^net::ERR_[A-Z_]+$/u.test(message.params.errorText)) {
              run.networkErrors.push(message.params.errorText);
            }
            if (message.method === "Network.webSocketFrameError") {
              run.networkErrors.push(message.params.errorMessage === "Proxy authentication failed" ? "WEBSOCKET_PROXY_AUTH_FAILED"
                : message.params.errorMessage.match(/(?:net::)?ERR_[A-Z_]+/u)?.[0] ?? "WEBSOCKET_ERROR_UNCLASSIFIED");
            }
          });
          return run.cdp;
        },
        onFailure(error) { run.failure = error; void broker.terminate(token).catch(() => {}); } });
      run.browser = await chromium.connectOverCDP(endpoint); run.context = run.browser.contexts()[0];
      report.browserVersion ??= run.browser.version();
      run.page = run.context.pages()[0]; run.page.setDefaultTimeout(12_000); run.page.setDefaultNavigationTimeout(12_000);
      return run;
    }
    async function close(run) {
      if (run.jobEmpty) return;
      if (!run.failure) await run.barrier.requestBrowserClose();
      assert.equal((await broker.waitForEmpty(run.token, 10_000)).count, 0); run.jobEmpty = true;
      run.barrier.close(); await run.browser.close().catch(() => {});
      await broker.dispose_(run.token); await broker.forget(run.token);
    }
    if (coldAuthOnly) {
      const coldProfile = await createTrustedLabProfile(root, "profile-cold-wss", certificates.rootDer);
      const cold = await launch(groups[0], "cold-wss", { profile: coldProfile });
      const providedBeforeWss = cold.barrier.state.provided;
      const attemptWss = run => run.page.evaluate(port => new Promise(resolve => {
        const timer = setTimeout(() => { ws.close(); resolve({ status: "timeout" }); }, 8000);
        const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`);
        ws.onmessage = e => { clearTimeout(timer); ws.close(); resolve({ status: "connected", ...JSON.parse(e.data) }); };
        ws.onerror = () => { clearTimeout(timer); resolve({ status: "error" }); };
      }), originPort);
      const coldWss = await attemptWss(cold).catch(() => ({ status: cold.failure ? "closed-on-auth-failure" : "evaluation-failed" }));
      report.coldWss = { ...coldWss, newChallenges: cold.barrier.state.provided - providedBeforeWss };
      await close(cold);
      const warmProfile = await createTrustedLabProfile(root, "profile-warm-wss", certificates.rootDer);
      const warm = await launch(groups[0], "warm-wss-control", { profile: warmProfile });
      assert.equal((await warm.page.goto(`${originUrl}/warmup-control`)).status(), 200);
      await warm.page.goto("about:blank");
      report.warmWss = await attemptWss(warm);
      assert.equal(report.warmWss.via, "a", "The identical WSS endpoint must work with an authenticated proxy cache");
      await close(warm); report.checks.push("warm-wss-positive-control", "cold-failure-job-empty");
      const workerProfile = await createTrustedLabProfile(root, "profile-cold-worker", certificates.rootDer);
      const workerRun = await launch(groups[0], "cold-dedicated-worker", { profile: workerProfile });
      const workerBefore = workerRun.barrier.state.provided;
      const workerResult = await workerRun.page.evaluate(url => new Promise((resolve, reject) => {
        const blob = new Blob([`fetch(${JSON.stringify(url)}).then(r=>r.json()).then(v=>postMessage(v)).catch(()=>postMessage({error:true}))`], { type: "text/javascript" });
        const objectUrl = URL.createObjectURL(blob); const worker = new Worker(objectUrl);
        const cleanup = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(objectUrl); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("Cold Worker timed out")); }, 8000);
        worker.onmessage = e => { cleanup(); resolve(e.data); }; worker.onerror = () => { cleanup(); reject(new Error("Cold Worker failed")); };
      }), `${originUrl}/cold-fetch`);
      report.coldWorker = { ...workerResult, newChallenges: workerRun.barrier.state.provided - workerBefore };
      assert.equal(workerResult.via, "a"); assert.ok(report.coldWorker.newChallenges > 0);
      await close(workerRun); report.checks.push("cold-dedicated-worker-first-fetch");
      assert.equal(observations.directRequests, 0); assert.equal(observations.leakedAuthorization, false);
      assert.equal(coldWss.status, "connected", "M1 gate: WSS must authenticate without a previous page request");
      assert.equal(coldWss.via, "a"); assert.ok(report.coldWss.newChallenges > 0, "Cold WSS must cause a new proxy challenge");
      report.checks.push("cold-wss-authentication-without-page-warmup");
      report.passed = true;
      return;
    }
    const a = await launch(groups[0], "a"); const b = await launch(groups[1], "b");
    report.browserVersion = a.browser.version();
    await Promise.all([a, b].map(async (run, index) => {
      const group = groups[index];
      assert.equal((await run.page.goto(`${originUrl}/seed`)).status(), 200);
      assert.ok(run.barrier.state.provided > 0, "HTTPS first request must authenticate the CONNECT tunnel");
      assert.equal(await run.page.evaluate(() => window.via), group.id);
      assertEnvironment(await run.page.evaluate(() => window.initialEnvironment), group.environment);
      await run.page.evaluate(id => localStorage.setItem("fixture-group", id), group.id);
      const state = await run.page.evaluate(() => fetch("/state").then(r => r.json()));
      assert.equal(state.via, group.id); assert.equal(state.cookie, `fixture-group=${group.id}`);
      assert.equal(await run.page.evaluate(() => localStorage.getItem("fixture-group")), group.id);
      const frameUrl = `https://127.0.0.2:${originPort}/iframe`;
      await run.page.evaluate(url => new Promise((resolve, reject) => {
        const frame = document.createElement("iframe"); frame.src = url; frame.onload = resolve; frame.onerror = reject; document.body.append(frame);
      }), frameUrl);
      const frame = run.page.frames().find(frame => frame.url() === frameUrl); assert.ok(frame);
      assertEnvironment(await frame.evaluate(() => window.initialEnvironment), group.environment);
      assert.equal(await frame.evaluate(() => window.via), group.id);
      const targets = await run.cdp.send("Target.getTargets");
      assert.ok(targets.targetInfos.some(target => target.type === "iframe" && target.url === frameUrl), "Must exercise a real out-of-process iframe target");
      assert.ok(run.barrier.state.targetTypes.includes("iframe"));
      const socket = await run.page.evaluate(port => new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`);
        ws.onmessage = e => { ws.close(); resolve(JSON.parse(e.data)); }; ws.onerror = () => reject(new Error("WSS failed"));
      }), originPort);
      assert.equal(socket.via, group.id);
      assert.equal((await run.page.goto(`${originUrl}/401`)).status(), 401);
      assert.equal(run.failure, undefined);
    }));
    report.checks.push("concurrent-groups-first-https-connect", "profile-cookie-storage-isolation", "oopif-first-environment-and-proxy", "wss-through-own-upstream", "https-401-no-proxy-password");
    // Negative certificate controls: success here would hide a TLS-validation bypass.
    await assert.rejects(a.page.goto(`https://127.0.0.1:${untrustedPort}/untrusted`), /ERR_CERT_AUTHORITY_INVALID/u);
    await assert.rejects(a.page.goto(`https://127.0.0.3:${originPort}/wrong-name`), /ERR_CERT_COMMON_NAME_INVALID/u);
    assert.equal(a.failure, undefined, "Site certificate errors must not be misclassified as proxy authentication failure");
    report.checks.push("untrusted-ca-and-wrong-hostname-rejected");
    await close(a);
    const beforeWrong = observations.connect.b;
    const wrongProfile = await createTrustedLabProfile(root, "profile-wrong", certificates.rootDer);
    const wrong = await launch(groups[1], "a-snapshot-on-b-entry", { profile: wrongProfile, expectedPort: groups[0].port, credentials: groups[0].credentials });
    await assert.rejects(wrong.page.goto(originUrl)); await close(wrong);
    assert.equal(wrong.failure?.code, "PROXY_AUTH_BARRIER_FAILED"); assert.equal(wrong.barrier.state.provided, 0);
    assert.equal(observations.connect.b, beforeWrong); report.checks.push("wrong-entry-challenge-closes-before-credentials");
    const badPasswordProfile = await createTrustedLabProfile(root, "profile-bad-password", certificates.rootDer);
    const badPassword = await launch(groups[1], "a-credentials-on-b-entry", { profile: badPasswordProfile, credentials: groups[0].credentials });
    await assert.rejects(badPassword.page.goto(originUrl), error => {
      badPassword.navigationError = error.message.match(/net::ERR_[A-Z_]+/u)?.[0] ?? "navigation-closed"; return true;
    }); await close(badPassword);
    assert.equal(observations.connect.b, beforeWrong);
    assert.equal(badPassword.failure?.code, "PROXY_AUTH_BARRIER_FAILED");
    assert.equal(badPassword.barrier.state.provided, 1, "Only one credential attempt is permitted per failed challenge");
    report.checks.push("cross-group-credentials-on-matching-entry-rejected-before-upstream");
    // Reuse only a test Profile, after the old Job reached zero. Group B must be
    // authenticated afresh while its already-running browser remains unaffected.
    const switched = await launch(groups[1], "a-profile-switched-to-b", { profile: groups[0].profile });
    assert.equal((await switched.page.goto(`${originUrl}/state`)).status(), 200);
    const switchedState = await switched.page.evaluate(() => JSON.parse(document.body.innerText));
    assert.equal(switchedState.via, "b"); assert.equal(switchedState.cookie, "fixture-group=a");
    assert.ok(switched.barrier.state.provided > 0);
    assert.equal((await b.page.goto(`${originUrl}/state`)).status(), 200);
    const bState = await b.page.evaluate(() => JSON.parse(document.body.innerText));
    assert.equal(bState.via, "b"); assert.equal(bState.cookie, "fixture-group=b"); assert.equal(b.failure, undefined);
    report.checks.push("closed-profile-group-switch-reauthenticates", "other-group-survives-wrong-entry-and-switch");
    await close(switched); await close(b); report.checks.push("all-browser-jobs-empty");
    assert.equal(observations.directRequests, 0); assert.equal(observations.leakedAuthorization, false);
    report.passed = true;
  });
}
