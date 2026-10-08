import test from "node:test";
import assert from "node:assert/strict";
import { installProxyAuthBarrier, proxyAuthResponse } from "../src/network/proxyAuthBarrier.js";
import { installBrowserStartupBarrier } from "../src/network/browserStartupBarrier.js";

const snapshot = Object.freeze({ origin: "http://127.0.0.1:23001", username: "group-a", password: "a-secret" });
test("only the snapshot's proxy challenge receives credentials", () => {
  assert.equal(proxyAuthResponse(snapshot, { source: "Proxy", origin: snapshot.origin }).response, "ProvideCredentials");
  for (const challenge of [{ source: "Server", origin: snapshot.origin }, { source: "Proxy", origin: "http://127.0.0.1:23002" },
    { source: "Proxy", origin: "http://localhost:23001" }, { source: "Proxy", origin: "https://site.example" }, {}, { source: "Proxy", origin: "garbage" }]) {
    const decision = proxyAuthResponse(snapshot, challenge);
    assert.deepEqual(decision, { response: "CancelAuth" });
    assert.equal(JSON.stringify(decision).includes("a-secret"), false);
  }
  assert.deepEqual(proxyAuthResponse(snapshot, { source: "Proxy", origin: snapshot.origin }, true), { response: "CancelAuth" });
});

function fakeConnection({ fetchFails = false, networkWaitsForResume = false, targetType = "page", networkWaitsForInstallFetch = false } = {}) {
  const calls = [];
  let handler;
  let resumeNetwork;
  return {
    calls, closed: false,
    onEvent(fn) { handler = fn; }, onUnexpectedClose(fn) { this.disconnect = fn; },
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") handler({ method: "Target.attachedToTarget", params: { sessionId: "s1", targetInfo: { type: targetType } } });
      if (method === "Fetch.enable" && fetchFails) throw Object.assign(new Error("unsupported"), { code: -32601 });
      if (method === "Network.enable" && networkWaitsForInstallFetch) return new Promise(resolve => {
        resumeNetwork = resolve;
        handler({ method: "Fetch.requestPaused", sessionId, params: { requestId: "install-fetch", networkId: "install-network" } });
      });
      if (method === "Network.enable" && networkWaitsForResume) return new Promise(resolve => { resumeNetwork = resolve; });
      if (method === "Runtime.runIfWaitingForDebugger" && networkWaitsForResume) resumeNetwork?.({});
      if (method === "Fetch.continueRequest" && networkWaitsForInstallFetch) resumeNetwork?.({});
      return {};
    },
    emit(message) { handler(message); }, close() { this.closed = true; },
  };
}

test("target authentication is installed before the target resumes; startup failure closes the run", async () => {
  for (const fetchFails of [false, true]) {
    const cdp = fakeConnection({ fetchFails });
    let failed = false;
    const result = installProxyAuthBarrier({ endpoint: "ws://127.0.0.1:9001/devtools/browser/test", proxyOrigin: snapshot.origin,
      credentials: snapshot, onFailure() { failed = true; }, connect: async () => cdp });
    if (fetchFails) {
      await assert.rejects(result, { code: "PROXY_AUTH_BARRIER_FAILED" });
      assert.equal(cdp.calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger"), false);
      assert.equal(failed, true);
      assert.equal(cdp.closed, true);
    } else {
      const barrier = await result;
      const methods = cdp.calls.map((call) => call.method);
      assert.ok(methods.indexOf("Fetch.enable") < methods.indexOf("Runtime.runIfWaitingForDebugger"));
      cdp.disconnect();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(failed, true);
      assert.equal(barrier.state.ready, false);
      barrier.close();
    }
  }
});

test("paused worker observation may acknowledge after resume, with Fetch already installed", async () => {
  const cdp = fakeConnection({ targetType: "service_worker", networkWaitsForResume: true });
  const barrier = await installProxyAuthBarrier({ endpoint: "ws://127.0.0.1:9001/devtools/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, onFailure() { assert.fail("unexpected barrier failure"); }, connect: async () => cdp });
  assert.equal(barrier.state.ready, true); barrier.close();
});

test("Service Worker installation fetch can finish before observation acknowledges without bypassing auth", async () => {
  const cdp = fakeConnection({ targetType: "service_worker", networkWaitsForInstallFetch: true });
  const barrier = await installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, identity: { userAgent: "Chrome/test", platform: "Win32" }, commandTimeoutMs: 1000,
    onFailure() { assert.fail("worker installation must not deadlock"); }, connect: async () => cdp });
  const methods = cdp.calls.map(call => call.method);
  const continued = methods.indexOf("Fetch.continueRequest");
  assert.ok(continued > methods.indexOf("Fetch.enable"));
  assert.ok(continued > methods.indexOf("Emulation.setUserAgentOverride"));
  assert.ok(continued > methods.indexOf("Network.enable"));
  assert.equal(cdp.calls.find(call => call.method === "Fetch.enable").params.handleAuthRequests, true);
  cdp.emit({ method: "Fetch.authRequired", sessionId: "s1", params: { requestId: "install-fetch",
    authChallenge: { source: "Proxy", origin: snapshot.origin } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cdp.calls.find(call => call.method === "Fetch.continueWithAuth").params.authChallengeResponse,
    { response: "ProvideCredentials", username: snapshot.username, password: snapshot.password });
  assert.equal(barrier.state.ready, true); barrier.close();
});

test("one target owner queues identity and environment before resume and holds requests until acknowledgements", async () => {
  const cdp = fakeConnection(); const originalSend = cdp.send.bind(cdp);
  let releaseLocale; let resumed; let connections = 0;
  const hasResumed = new Promise(resolve => { resumed = resolve; });
  cdp.send = async (method, params, sessionId) => {
    const result = originalSend(method, params, sessionId);
    if (method === "Emulation.setLocaleOverride") return new Promise(resolve => { releaseLocale = resolve; });
    if (method === "Runtime.runIfWaitingForDebugger") {
      cdp.emit({ method: "Fetch.requestPaused", sessionId, params: { requestId: "first", networkId: "net-first" } });
      resumed();
    }
    return result;
  };
  const identity = { userAgent: "Chrome/test", platform: "Win32" };
  const environment = { locale: "de-DE", timezone: "Europe/Berlin" };
  const installing = installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, identity, environment, onFailure() { assert.fail("unexpected failure"); },
    connect: async () => { connections++; return cdp; } });
  identity.userAgent = "mutated"; environment.locale = "fr-FR";
  await hasResumed;
  assert.equal(cdp.calls.some(call => call.method === "Fetch.continueRequest"), false);
  releaseLocale({}); const barrier = await installing;
  assert.equal(connections, 1);
  const methods = cdp.calls.map(call => call.method);
  for (const method of ["Fetch.enable", "Emulation.setUserAgentOverride", "Emulation.setTimezoneOverride", "Emulation.setLocaleOverride"]) {
    assert.ok(methods.indexOf(method) < methods.indexOf("Runtime.runIfWaitingForDebugger"));
  }
  assert.equal(cdp.calls.find(call => call.method === "Emulation.setUserAgentOverride").params.userAgent, "Chrome/test");
  assert.equal(cdp.calls.find(call => call.method === "Emulation.setLocaleOverride").params.locale, "de-DE");
  assert.ok(methods.includes("Fetch.continueRequest"));
  assert.equal(barrier.state.environmentConfigured, true); barrier.close();
});

test("emulation failure never releases a queued first request", async () => {
  const cdp = fakeConnection(); const originalSend = cdp.send.bind(cdp); let failures = 0;
  cdp.send = async (method, params, sessionId) => {
    const result = originalSend(method, params, sessionId);
    if (method === "Emulation.setTimezoneOverride") throw Object.assign(new Error("bad timezone; secret URL"), { code: -32602 });
    if (method === "Runtime.runIfWaitingForDebugger") cdp.emit({ method: "Fetch.requestPaused", sessionId, params: { requestId: "r" } });
    return result;
  };
  await assert.rejects(installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, environment: { locale: "de-DE", timezone: "Europe/Berlin" },
    connect: async () => cdp, onFailure(error) { failures++; assert.doesNotMatch(error.message, /secret/u); } }), { code: "PROXY_AUTH_BARRIER_FAILED" });
  assert.equal(failures, 1); assert.equal(cdp.closed, true);
  assert.equal(cdp.calls.some(call => call.method === "Fetch.continueRequest"), false);
});

test("a connected CDP transport that stops replying becomes control_error, never frozen", async () => {
  const cdp = fakeConnection(); const originalSend = cdp.send.bind(cdp); let failure;
  cdp.send = (method, params, sessionId) => method === "Fetch.continueRequest" ? new Promise(() => {}) : originalSend(method, params, sessionId);
  const failed = new Promise(resolve => { failure = resolve; });
  const barrier = await installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, connect: async () => cdp, commandTimeoutMs: 20, onFailure: failure });
  cdp.emit({ method: "Fetch.requestPaused", sessionId: "s1", params: { requestId: "stalled" } });
  await failed;
  assert.equal(barrier.state.ready, false); assert.equal(barrier.state.controlState, "control_error");
  assert.equal(Object.hasOwn(barrier.state, "frozen"), false); barrier.close();
});

test("requested Browser.close disconnect does not kill Chrome while its Profile is flushing", async () => {
  const cdp = fakeConnection(); const originalSend = cdp.send.bind(cdp); let failures = 0;
  cdp.send = async (method, params, sessionId) => {
    const result = originalSend(method, params, sessionId);
    if (method === "Browser.close") { cdp.disconnect(); throw new Error("CDP connection closed"); }
    return result;
  };
  const barrier = await installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, connect: async () => cdp, onFailure() { failures++; } });
  await Promise.all([barrier.requestBrowserClose(), barrier.requestBrowserClose()]);
  assert.equal(failures, 0); assert.equal(barrier.state.ready, false);
  assert.equal(barrier.state.controlState, "closing", "CDP disconnect is not a process-close proof");
  assert.equal(cdp.calls.filter(call => call.method === "Browser.close").length, 1);
  barrier.close(); assert.equal(barrier.state.controlState, "closed");
});

test("a requested close without a reply or disconnect still fails and requires fallback", async () => {
  const cdp = fakeConnection(); const originalSend = cdp.send.bind(cdp); let failures = 0;
  cdp.send = (method, params, sessionId) => method === "Browser.close" ? new Promise(() => {}) : originalSend(method, params, sessionId);
  const barrier = await installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, commandTimeoutMs: 20, connect: async () => cdp, onFailure() { failures++; } });
  await assert.rejects(barrier.requestBrowserClose(), { code: "PROXY_AUTH_BARRIER_FAILED" });
  assert.equal(failures, 1); assert.equal(barrier.state.controlState, "control_error"); barrier.close();
});

test("CONNECT rejection after credentials fails without a repeated challenge; unrelated network errors do not", async () => {
  for (const [errorText, supplied, completed, shouldFail] of [
    ["net::ERR_TUNNEL_CONNECTION_FAILED", true, false, true],
    ["net::ERR_INVALID_AUTH_CREDENTIALS", true, false, true],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", false, false, false],
    ["net::ERR_CERT_AUTHORITY_INVALID", true, false, false],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", true, true, false],
  ]) {
    const cdp = fakeConnection(); let failures = 0;
    const barrier = await installBrowserStartupBarrier({ endpoint: "ws://127.0.0.1:9001/browser/test", proxyOrigin: snapshot.origin,
      credentials: snapshot, connect: async () => cdp, onFailure() { failures++; } });
    cdp.emit({ method: "Fetch.requestPaused", sessionId: "s1", params: { requestId: "connect", networkId: "network-connect" } });
    if (supplied) cdp.emit({ method: "Fetch.authRequired", sessionId: "s1", params: { requestId: "connect",
      authChallenge: { source: "Proxy", origin: snapshot.origin } } });
    if (completed) cdp.emit({ method: "Network.loadingFinished", sessionId: "s1", params: { requestId: "network-connect" } });
    cdp.emit({ method: "Network.loadingFailed", sessionId: "s1", params: { requestId: "network-connect", errorText } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failures, Number(shouldFail), `${errorText}, supplied=${supplied}, completed=${completed}`);
    assert.equal(barrier.state.ready, !shouldFail); barrier.close();
  }
});
