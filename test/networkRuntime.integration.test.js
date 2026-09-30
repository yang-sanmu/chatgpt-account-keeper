import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { ChromeLauncherBroker } from "../src/chromeLauncherBroker.js";
import { buildLaunchArgs } from "../src/chromeProcessLauncher.js";
import { findChromeExecutable, reserveLocalDebugPort, waitForDevToolsEndpoint } from "../src/browser.js";
import { STRICT_RESOLVER_ARGUMENT } from "../src/network/strictConfig.js";

test("M1 runtime copy preserves a fresh synthetic Profile", {
  skip: process.platform !== "win32" || process.env.GPT_ACCOUNT_NETWORK_LAB !== "1", timeout: 180_000,
}, async (t) => {
  const source = findChromeExecutable(); assert.ok(source);
  const base = path.resolve("artifacts/network-lab"); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "runtime-"));
  const profile = path.join(root, "profile"); await fs.mkdir(profile);
  const copy = path.join(root, "chrome");
  const copiedExe = path.join(copy, path.basename(source));
  const report = { kind: "chrome-copy", passed: false, productionReady: false,
    limitation: "Fresh synthetic Profile only; does not prove migration of existing app-bound encrypted accounts", checks: [] };
  const broker = new ChromeLauncherBroker();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/seed") res.setHeader("Set-Cookie", "lab-session=synthetic-login; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/");
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>${req.headers.cookie?.includes("lab-session=synthetic-login") ? "authenticated" : "anonymous"}</title>`);
  });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await broker.dispose(); for (const socket of sockets) socket.destroy(); server.close();
    await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
    t.diagnostic(`Sanitized report: ${path.join(root, "report.json")}`);
  });
  await broker.start();
  const unusedPort = await reserveLocalDebugPort();
  async function run(exe, seed) {
    const token = broker.newRunToken(); const now = Date.now();
    // A prior fully closed run can leave this discovery file behind.
    await fs.rm(path.join(profile, "DevToolsActivePort"), { force: true });
    const args = buildLaunchArgs({ userDataDir: profile, headless: true, launchArgs: {
      args: [STRICT_RESOLVER_ARGUMENT], proxy: { server: `http://127.0.0.1:${unusedPort}`, bypass: "127.0.0.1" },
    } });
    args.unshift("--disable-background-networking");
    await broker.launch(token, exe, args);
    const endpoint = await waitForDevToolsEndpoint(profile, now);
    const browser = await chromium.connectOverCDP(endpoint); const page = browser.contexts()[0].pages()[0];
    try {
      await page.goto(`${origin}/${seed ? "seed" : "verify"}`);
      const value = await page.evaluate(async (seed) => {
        if (seed) localStorage.setItem("lab", "persisted");
        const database = await new Promise((resolve, reject) => {
          const req = indexedDB.open("lab", 1); req.onupgradeneeded = () => req.result.createObjectStore("values");
          req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        if (seed) await new Promise((resolve, reject) => {
          const txn = database.transaction("values", "readwrite"); txn.objectStore("values").put("persisted", "key");
          txn.oncomplete = resolve; txn.onerror = () => reject(txn.error);
        });
        const idb = await new Promise((resolve, reject) => { const req = database.transaction("values").objectStore("values").get("key"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        database.close(); return { local: localStorage.getItem("lab"), idb, title: document.title };
      }, seed);
      assert.equal(value.local, "persisted"); assert.equal(value.idb, "persisted");
      if (!seed) assert.equal(value.title, "authenticated", "Persistent HttpOnly cookie must reach the local server");
      report.checks.push(seed ? "seeded" : exe === source ? "original-restart-preserved" : "copied-runtime-preserved");
    } finally {
      const session = await browser.newBrowserCDPSession(); await session.send("Browser.close").catch(() => {});
      assert.equal((await broker.waitForEmpty(token, 10_000)).count, 0);
      await broker.dispose_(token); await broker.forget(token); await browser.close().catch(() => {});
    }
  }
  await run(source, true); await run(source, false);
  // Complete copy: no hardlinks, binary patches, encryption flags or live file replacement.
  await fs.cp(path.dirname(source), copy, { recursive: true, errorOnExist: true, force: false });
  const hash = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
  assert.equal(await hash(source), await hash(copiedExe));
  report.chromeExecutableSha256 = await hash(copiedExe);
  await run(copiedExe, false);
  const cookies = new Database(path.join(profile, "Default", "Network", "Cookies"), { readonly: true });
  try { report.cookieCipherPrefixes = cookies.prepare("SELECT DISTINCT hex(substr(encrypted_value,1,3)) AS prefix FROM cookies WHERE name='lab-session'").all().map(r => r.prefix); }
  finally { cookies.close(); }
  report.passed = true;
});
