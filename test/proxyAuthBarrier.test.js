import test from "node:test";
import assert from "node:assert/strict";
import { installProxyAuthBarrier, proxyAuthResponse } from "../src/network/proxyAuthBarrier.js";

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

function fakeConnection({ fetchFails = false, networkWaitsForResume = false } = {}) {
  const calls = [];
  let handler;
  let resumeNetwork;
  return {
    calls, closed: false,
    onEvent(fn) { handler = fn; }, onUnexpectedClose(fn) { this.disconnect = fn; },
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") handler({ method: "Target.attachedToTarget", params: { sessionId: "s1", targetInfo: { type: "page" } } });
      if (method === "Fetch.enable" && fetchFails) throw Object.assign(new Error("unsupported"), { code: -32601 });
      if (method === "Network.enable" && networkWaitsForResume) return new Promise(resolve => { resumeNetwork = resolve; });
      if (method === "Runtime.runIfWaitingForDebugger") resumeNetwork?.({});
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
  const cdp = fakeConnection({ networkWaitsForResume: true });
  const barrier = await installProxyAuthBarrier({ endpoint: "ws://127.0.0.1:9001/devtools/browser/test", proxyOrigin: snapshot.origin,
    credentials: snapshot, onFailure() { assert.fail("unexpected barrier failure"); }, connect: async () => cdp });
  assert.equal(barrier.state.ready, true); barrier.close();
});
