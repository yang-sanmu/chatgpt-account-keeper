import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  baseLaunchArgs,
  findChromeExecutable,
  launchInteractivePersistentContext,
  reserveLocalDebugPort,
} from "../src/browser.js";
import { ChromeLauncherBroker, resolveBrokerExecutable } from "../src/chromeLauncherBroker.js";
import { ChromeProcessLauncher } from "../src/chromeProcessLauncher.js";

for (const mode of ["legacy", "broker"]) {
  test(`${mode} interactive Chrome preserves native background-tab visibility`, {
    timeout: 60_000,
  }, async t => {
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return t.skip("Headed Chrome needs a display (run under Xvfb on headless Linux)");
    }
    if (!findChromeExecutable()) return t.skip("Google Chrome is not installed");
    if (mode === "broker" && !resolveBrokerExecutable()) return t.skip("Chrome broker is not built");

    const root = path.resolve("tmp");
    await fs.mkdir(root, { recursive: true });
    const profile = await fs.mkdtemp(path.join(root, "interactive-defaults-"));
    const broker = mode === "broker" ? new ChromeLauncherBroker() : null;
    let launched;
    t.after(async () => {
      await launched?.context.close().catch(() => {});
      await broker?.dispose();
      // Only remove this test's newly-created Profile after Chrome exits.
      assert.equal(path.dirname(profile), root);
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    const launchArgs = baseLaunchArgs(false);
    // The test uses only about:blank; block Chrome background Internet traffic.
    launchArgs.proxy = { server: `http://127.0.0.1:${await reserveLocalDebugPort()}` };
    if (broker) {
      await broker.start();
      launched = await new ChromeProcessLauncher({ broker }).launch({
        userDataDir: profile, launchArgs, headless: false,
        accountId: "interactive-defaults-test", runToken: broker.newRunToken(),
      });
    } else {
      launched = await launchInteractivePersistentContext(profile, launchArgs);
    }

    const first = launched.page;
    const second = await launched.context.newPage();
    await second.bringToFront();
    // With Playwright's default focus emulation, *both* tabs claim to be visible.
    // Check each direction so a detached/minimized browser cannot mask the bug.
    await first.waitForFunction(() => document.hidden, undefined, { timeout: 5_000 });
    assert.equal(await first.evaluate(() => document.hasFocus()), false);
    assert.equal(await second.evaluate(() => document.visibilityState), "visible");
    await first.bringToFront();
    await second.waitForFunction(() => document.hidden, undefined, { timeout: 5_000 });
    assert.equal(await second.evaluate(() => document.hasFocus()), false);
    assert.equal(await first.evaluate(() => document.visibilityState), "visible");
    assert.equal(await first.evaluate(() => navigator.webdriver), false);
  });
}
