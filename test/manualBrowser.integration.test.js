import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { baseLaunchArgs, findChromeExecutable, launchInteractivePersistentContext, reserveLocalDebugPort } from "../src/browser.js";
import { ChromeLauncherBroker, resolveBrokerExecutable } from "../src/chromeLauncherBroker.js";
import { ChromeProcessLauncher } from "../src/chromeProcessLauncher.js";
import { checkSession } from "../src/health.js";

async function until(condition) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("manual browser condition timed out");
}

for (const mode of ["legacy", "broker"]) {
  test(`${mode} manual window navigates, preserves environment/cookies and tracks tabs without Playwright`, { timeout: 60_000 }, async t => {
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return t.skip("Headed Chrome needs a display");
    if (!findChromeExecutable()) return t.skip("Google Chrome is not installed");
    if (mode === "broker" && !resolveBrokerExecutable()) return t.skip("Chrome broker is not built");
    const root = path.resolve("tmp");
    await fs.mkdir(root, { recursive: true });
    const profile = await fs.mkdtemp(path.join(root, "manual-browser-"));
    const broker = mode === "broker" ? new ChromeLauncherBroker() : null;
    let launched;
    const server = http.createServer((req, res) => {
      if (req.url === "/api/auth/session" || req.url === "/backend-api/me") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url === "/api/auth/session"
          ? { user: { email: "manual@example.com", name: "Manual" }, accessToken: "fixture-token" }
          : { id: "fixture-user", email: "manual@example.com" }));
        return;
      }
      if (req.url === "/set") res.setHeader("Set-Cookie", "manual-persistent=present; Max-Age=3600; Path=/; SameSite=Lax");
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><script>window.initial = {language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,webdriver:navigator.webdriver};</script><title>manual test</title>`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await launched?.context.close().catch(() => {});
      await broker?.dispose();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(profile), root);
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const launchArgs = { ...baseLaunchArgs(false), locale: "de-DE", timezoneId: "Europe/Berlin",
      proxy: { server: `http://127.0.0.1:${await reserveLocalDebugPort()}`, bypass: "127.0.0.1" } };
    if (broker) await broker.start();
    const launcher = broker ? new ChromeProcessLauncher({ broker,
      connectOverCDP: () => assert.fail("manual windows must not attach Playwright") }) : null;
    const open = async () => launcher
      ? launcher.launch({ userDataDir: profile, launchArgs, headless: false, manual: true,
        environmentMode: "fixed", accountId: "manual-fixture", runToken: broker.newRunToken() })
      : launchInteractivePersistentContext(profile, launchArgs, { manual: true });
    const close = async () => {
      await launched.context.close();
      if (broker) {
        assert.equal((await broker.waitForEmpty(launched.runToken, 10_000)).count, 0);
        await broker.dispose_(launched.runToken);
        await broker.forget(launched.runToken);
      }
      launched = null;
    };
    launched = await open();
    const { context, page } = launched;
    await page.goto(`${url}/set`, { waitUntil: "domcontentloaded" });
    assert.deepEqual(await page.evaluate(() => window.initial), { language: "de-DE", timezone: "Europe/Berlin", webdriver: false });
    assert.match(await page.evaluate(() => document.cookie), /manual-persistent=present/);
    const health = await checkSession(page, { attempts: 1 });
    assert.equal(health.state, "ok");
    assert.equal(health.email, "manual@example.com");
    // Human clicks carry user activation. Supply it only in the test driver;
    // production health sampling must preserve Chrome's popup blocking.
    const clickSession = await context.newCDPSession(page);
    await clickSession.send("Runtime.evaluate", { expression: `void window.open(${JSON.stringify(`${url}/popup`)})`, userGesture: true });
    await clickSession.detach();
    await until(() => context.pages().some(candidate => candidate !== page && candidate.url() === `${url}/popup`));
    const popup = context.pages().find(candidate => candidate !== page);
    await until(async () => (await popup.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)) === "Europe/Berlin");
    if (broker) assert.equal((await popup.evaluate(() => window.initial)).timezone, "Europe/Berlin");
    await popup.bringToFront();
    await until(() => page.evaluate(() => document.hidden));
    assert.equal(await popup.evaluate(() => document.visibilityState), "visible");
    await popup.close();
    await until(() => context.pages().length === 1);
    await close();
    launched = await open();
    await launched.page.goto(`${url}/read`, { waitUntil: "domcontentloaded" });
    assert.match(await launched.page.evaluate(() => document.cookie), /manual-persistent=present/, "persistent cookie survives graceful restart");
    await close();
  });
}
