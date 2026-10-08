import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { probeMihomoAuthentication } from "../src/network/proxyAuthenticationProbe.js";

const credentials = { username: "fixture-group", password: "fixture-secret" };
async function fixture(t, mode = "normal") {
  const ports = new Set(); const requests = [];
  const server = http.createServer((req, res) => {
    ports.add(req.socket.remotePort); requests.push({ path: req.url, method: req.method });
    if (mode === "hang") return;
    const authorization = req.headers["proxy-authorization"];
    if (mode === "no-auth") { res.writeHead(400).end(); return; }
    if (!authorization) { res.writeHead(407, { "Proxy-Authenticate": "Basic" }).end(); return; }
    if (mode === "accept-any") { res.writeHead(400).end(); return; }
    if (authorization !== `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`) { res.writeHead(403).end(); return; }
    res.writeHead(mode === "unsupported" ? 502 : 400).end();
  });
  const sockets = new Set(); server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { proxyOrigin: `http://127.0.0.1:${server.address().port}`, ports, requests };
}
test("local auth diagnostic uses three fresh connections and never an absolute proxy target", async t => {
  const server = await fixture(t);
  const result = await probeMihomoAuthentication({ proxyOrigin: server.proxyOrigin, credentials });
  assert.deepEqual(result, { status: "accepted", reason: "LOCAL_AUTH_CHECK_PASSED" });
  assert.equal(server.ports.size, 3);
  assert.deepEqual(server.requests, Array.from({ length: 3 }, () => ({ path: "/", method: "GET" })));
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-group/u);
});
test("local auth diagnostic refuses incorrect credentials without classifying website responses", async t => {
  const server = await fixture(t);
  assert.deepEqual(await probeMihomoAuthentication({ proxyOrigin: server.proxyOrigin, credentials: { ...credentials, password: "wrong" } }),
    { status: "rejected", reason: "CREDENTIALS_REJECTED" });
});
test("missing auth, ignored passwords, unknown protocol and timeouts never report accepted", async t => {
  for (const mode of ["no-auth", "accept-any", "unsupported", "hang"]) {
    const server = await fixture(t, mode);
    const result = await probeMihomoAuthentication({ proxyOrigin: server.proxyOrigin, credentials, timeoutMs: 100 });
    assert.equal(result.status, "unconfirmed", mode);
  }
});
test("local auth diagnostic rejects non-numeric or non-loopback origins before making a request", async () => {
  for (const proxyOrigin of ["http://localhost:23001", "http://192.0.2.1:23001", "https://127.0.0.1:23001", "http://127.0.0.1:23001/path"]) {
    await assert.rejects(probeMihomoAuthentication({ proxyOrigin, credentials }));
  }
});
