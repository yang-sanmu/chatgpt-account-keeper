import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { ChromeLauncherBroker } from "../src/chromeLauncherBroker.js";
import { ChromeProcessLauncher } from "../src/chromeProcessLauncher.js";
import { probeHeadlessIdentity, reserveLocalDebugPort } from "../src/browser.js";

for (const headless of [true, false]) {
  test(`environment reaches first scripts, popup and worker (${headless ? "headless" : "headed"})`, {
    skip: process.platform !== "win32" || process.env.GPT_ACCOUNT_NETWORK_LAB !== "1", timeout: 60_000,
  }, async t => {
    const root = path.resolve("artifacts/network-lab"); await fs.mkdir(root, { recursive: true });
    const profile = await fs.mkdtemp(path.join(root, "environment-"));
    const broker = new ChromeLauncherBroker(); let context;
    const server = http.createServer((req, res) => {
      const code = '({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language })';
      if (req.url === "/worker.js") { res.setHeader("Content-Type", "text/javascript"); res.end(`postMessage(${code});`); }
      else { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><script>window.initialEnvironment = ${code}</script>`); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { await context?.close().catch(() => {}); await broker.dispose(); server.closeAllConnections(); server.close(); });
    await broker.start(); const launcher = new ChromeProcessLauncher({ broker }); const token = broker.newRunToken();
    const identity = headless ? await probeHeadlessIdentity("chrome") : null;
    const launched = await launcher.launch({ userDataDir: profile, launchArgs: { timezoneId: "Europe/Berlin", locale: "de-DE",
      proxy: { server: `http://127.0.0.1:${await reserveLocalDebugPort()}`, bypass: "127.0.0.1" } },
    headless, headlessIdentity: identity, environmentMode: "fixed", accountId: "environment-fixture", runToken: token });
    context = launched.context; const page = launched.page; const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    const check = value => { assert.equal(value.timezone, "Europe/Berlin"); assert.equal(value.locale, "de-DE"); assert.equal(value.language, "de-DE"); };
    check(await page.evaluate(() => window.initialEnvironment));
    const pending = context.waitForEvent("page"); await page.evaluate(url => window.open(url), url);
    const popup = await pending; await popup.waitForLoadState(); check(await popup.evaluate(() => window.initialEnvironment));
    check(await page.evaluate(() => new Promise((resolve, reject) => { const w = new Worker("/worker.js"); w.onmessage = e => { w.terminate(); resolve(e.data); }; w.onerror = reject; })));
    await context.close(); context = null;
    assert.equal((await broker.waitForEmpty(token, 10_000)).count, 0); await broker.dispose_(token); await broker.forget(token);
  });
}
