import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import YAML from "yaml";
import { waitMihomoConfigApplied } from "../src/network/mihomoReadiness.js";

async function controller(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("an open controller does not release readiness until config application is acknowledged", async (t) => {
  let acknowledge;
  let received;
  const requestReceived = new Promise((resolve) => { received = resolve; });
  const config = { proxies: [{ name: "fixture", type: "http", server: "127.0.0.1", port: 1234 }], listeners: [] };
  const port = await controller(t, (req, res) => {
    assert.equal(req.method, "PUT"); assert.equal(req.url, "/configs");
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      assert.deepEqual(YAML.parse(JSON.parse(body).payload), config);
      acknowledge = () => res.writeHead(204).end();
      received();
    });
  });
  let ready = false;
  const pending = waitMihomoConfigApplied(port, config, { timeoutMs: 1000 }).then((result) => { ready = true; return result; });
  await requestReceived;
  assert.equal(ready, false);
  acknowledge();
  assert.deepEqual(await pending, { ok: true });
});

test("rejected configuration and exited core remain unavailable, without probing a website", async (t) => {
  let requests = 0;
  const port = await controller(t, (_req, res) => { requests++; res.writeHead(400).end(); });
  assert.deepEqual(await waitMihomoConfigApplied(port, {}, { timeoutMs: 1000 }), { ok: false, status: 400 });
  assert.deepEqual(await waitMihomoConfigApplied(port, {}, { shouldStop: () => true }), { ok: false, stopped: true });
  assert.equal(requests, 1);
});

test("a control connection that never responds is bounded by the readiness budget", async (t) => {
  const port = await controller(t, () => {});
  assert.deepEqual(await waitMihomoConfigApplied(port, {}, { timeoutMs: 100 }), { ok: false, timedOut: true });
});
