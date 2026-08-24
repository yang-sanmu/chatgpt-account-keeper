import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ChromeLauncherBroker, resolveBrokerExecutable } from "../src/chromeLauncherBroker.js";
import { ChromeProcessLauncher, buildLaunchArgs } from "../src/chromeProcessLauncher.js";
import {
  baseLaunchArgs,
  configureChromeLauncher,
  launchForAccount,
  probeHeadlessIdentity,
} from "../src/browser.js";
import { fromRoot } from "../src/paths.js";

const HIGH_ENTROPY_HINTS = ["architecture", "bitness", "platformVersion", "fullVersionList"];

function skipUnlessReady(t) {
  if (process.platform !== "win32") {
    t.skip("broker 路径仅 Windows");
    return false;
  }
  if (!resolveBrokerExecutable()) {
    t.skip("chrome-launcher broker 未构建");
    return false;
  }
  const chrome = [
    path.join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!chrome) {
    t.skip("本机没有 branded Chrome");
    return false;
  }
  return true;
}

/**
 * 计划 §9.3.1 的三层断言，跑在 broker 创建路径上。
 *
 * 第 1 层只断言 legacy UA 与低熵 Sec-CH-UA，**不断言高熵 hints**：首个 document 在
 * 收到 Accept-CH 之前发出，按 UA-CH 协议本就不带高熵头，对它断言高熵会把一个正常
 * 协议行为误判成 spike 失败。
 */
test(
  "broker 路径：身份在首次外部交互前已生效（三层）",
  { timeout: 120_000 },
  async (t) => {
    if (!skipUnlessReady(t)) return;

    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({
        url: req.url,
        userAgent: req.headers["user-agent"] ?? "",
        brands: req.headers["sec-ch-ua"] ?? "",
        fullVersionList: req.headers["sec-ch-ua-full-version-list"] ?? "",
        platformVersion: req.headers["sec-ch-ua-platform-version"] ?? "",
        architecture: req.headers["sec-ch-ua-arch"] ?? "",
        bitness: req.headers["sec-ch-ua-bitness"] ?? "",
      });
      res.setHeader(
        "Accept-CH",
        ["Sec-CH-UA-Full-Version-List", "Sec-CH-UA-Platform-Version", "Sec-CH-UA-Arch", "Sec-CH-UA-Bitness"].join(", ")
      );
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>identity</title>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const broker = new ChromeLauncherBroker();
    const relativeProfile = path.join("tmp", `launcher-identity-${Date.now()}`);
    fs.mkdirSync(fromRoot(relativeProfile), { recursive: true });
    let context;
    try {
      await broker.start();
      const launcher = new ChromeProcessLauncher({ broker });
      configureChromeLauncher(launcher);

      const expected = await probeHeadlessIdentity("chrome");
      // 生产里 runToken 由 BrowserRun 登记后传入；launchForAccount 不再自造，所以
      // 直连调用方必须自己提供一个。
      const launched = await launchForAccount(
        { id: "identity-probe", profileDir: relativeProfile, groupId: null },
        { headless: true, runToken: launcher.newRunToken() }
      );
      context = launched.context;
      const page = launched.page;

      assert.ok(launched.rootPid > 0, "broker 应报告 root pid");
      assert.ok(launched.runToken, "应带回 runToken");

      // Layer 2: the JS-visible identity must already match before page script runs.
      // This is what the pre-connectOverCDP barrier buys.
      await page.goto(`http://127.0.0.1:${port}/main`, { waitUntil: "domcontentloaded" });
      const inPage = await page.evaluate(async (hints) => ({
        userAgent: navigator.userAgent,
        metadata: navigator.userAgentData
          ? await navigator.userAgentData.getHighEntropyValues(hints)
          : null,
      }), HIGH_ENTROPY_HINTS);
      assert.doesNotMatch(inPage.userAgent, /HeadlessChrome/i, "JS UA 不得暴露 HeadlessChrome");
      assert.equal(inPage.userAgent, expected.userAgent, "JS UA 应等于探测到的身份");
      assert.ok(inPage.metadata, "应保留 UA-CH metadata");
      assert.equal(
        inPage.metadata.fullVersionList?.some((item) => /HeadlessChrome/i.test(item.brand)),
        false,
        "高熵 fullVersionList 不得包含 HeadlessChrome"
      );

      // Layer 3: after Accept-CH, subsequent requests must carry matching high-entropy
      // headers.
      await page.evaluate(() => fetch("/after-accept-ch"));
      await new Promise((resolve) => setTimeout(resolve, 800));

      const first = requests.find((entry) => entry.url === "/main");
      assert.ok(first, "服务端应收到首个 document 请求");
      // Layer 1: legacy UA and low-entropy brands. High-entropy hints are deliberately
      // NOT asserted here.
      assert.doesNotMatch(first.userAgent, /HeadlessChrome/i, "首个 document 的 legacy UA 不得暴露 HeadlessChrome");
      assert.ok(first.brands.length > 0, "首个 document 应带低熵 Sec-CH-UA（否则断言会变成空断言）");
      assert.doesNotMatch(first.brands, /HeadlessChrome/i, "首个 document 的低熵 brands 不得暴露 HeadlessChrome");

      const after = requests.find((entry) => entry.url === "/after-accept-ch");
      assert.ok(after, "服务端应收到 Accept-CH 之后的请求");
      assert.ok(after.fullVersionList.length > 0, "后续请求应带完整版本列表");
      assert.doesNotMatch(after.fullVersionList, /HeadlessChrome/i);
      assert.ok(after.platformVersion.length > 0, "后续请求应带平台版本");
      assert.ok(after.architecture.length > 0, "后续请求应带架构");
    } finally {
      configureChromeLauncher(null);
      if (context) await context.close().catch(() => {});
      await broker.dispose();
      server.close();
      try {
        fs.rmSync(fromRoot(relativeProfile), { recursive: true, force: true });
      } catch {
        // Chrome 可能仍在释放 Profile 文件锁；测试主体不是文件系统时序。
      }
    }
  }
);

test(
  "broker 路径：既有 Profile 不恢复外部标签，唯一初始页是 about:blank",
  { timeout: 120_000 },
  async (t) => {
    if (!skipUnlessReady(t)) return;

    const broker = new ChromeLauncherBroker();
    const relativeProfile = path.join("tmp", `launcher-restore-${Date.now()}`);
    const absoluteProfile = fromRoot(relativeProfile);
    fs.mkdirSync(path.join(absoluteProfile, "Default"), { recursive: true });
    // Seed a session that asks Chrome to restore an external URL on next start.
    fs.writeFileSync(
      path.join(absoluteProfile, "Default", "Preferences"),
      JSON.stringify({
        session: { restore_on_startup: 4, startup_urls: ["https://example.invalid/restored"] },
        profile: { exit_type: "Crashed" },
      }),
      "utf8"
    );

    let context;
    try {
      await broker.start();
      const launcher = new ChromeProcessLauncher({ broker });
      configureChromeLauncher(launcher);
      // 同上：token 由调用方提供，launchForAccount 不再自造。
      const launched = await launchForAccount(
        { id: "restore-probe", profileDir: relativeProfile, groupId: null },
        { headless: true, runToken: launcher.newRunToken() }
      );
      context = launched.context;
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const urls = context.pages().map((page) => page.url());
      assert.ok(urls.length > 0, "应至少有一个页面");
      for (const url of urls) {
        assert.doesNotMatch(
          url,
          /example\.invalid/i,
          `不得恢复外部标签，实际打开了 ${url}`
        );
      }
      assert.ok(
        urls.every((url) => url === "about:blank" || url === "chrome://new-tab-page/" || url.startsWith("chrome://")),
        `初始页应只有 about:blank / 新标签页，实际 ${urls.join(", ")}`
      );
    } finally {
      configureChromeLauncher(null);
      if (context) await context.close().catch(() => {});
      await broker.dispose();
      try {
        fs.rmSync(absoluteProfile, { recursive: true, force: true });
      } catch {
        // 同上：Profile 文件锁释放有延迟
      }
    }
  }
);

test(
  "broker 交互路径不向网页暴露 webdriver",
  { timeout: 120_000 },
  async (t) => {
    if (!skipUnlessReady(t)) return;

    const broker = new ChromeLauncherBroker();
    const relativeProfile = path.join("tmp", `launcher-interactive-${Date.now()}`);
    const absoluteProfile = fromRoot(relativeProfile);
    fs.mkdirSync(absoluteProfile, { recursive: true });
    let context;
    try {
      await broker.start();
      const launcher = new ChromeProcessLauncher({ broker });
      const launched = await launcher.launch({
        userDataDir: absoluteProfile,
        launchArgs: baseLaunchArgs(false),
        headless: false,
        accountId: "interactive-probe",
        runToken: launcher.newRunToken(),
      });
      context = launched.context;
      assert.equal(await launched.page.evaluate(() => navigator.webdriver), false);
    } finally {
      if (context) await context.close().catch(() => {});
      await broker.dispose();
      try {
        fs.rmSync(absoluteProfile, { recursive: true, force: true });
      } catch {
        // Chrome 可能仍在释放 Profile 文件锁
      }
    }
  }
);

test(
  "broker 交互路径正常关闭后持久 Cookie 可跨 Chrome 重启读取",
  { timeout: 120_000 },
  async (t) => {
    if (!skipUnlessReady(t)) return;

    const server = http.createServer((_req, res) => {
      res.setHeader(
        "Set-Cookie",
        "keeper-session-persistence=present; Max-Age=3600; Path=/; SameSite=Lax"
      );
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>session persistence</title>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;

    const broker = new ChromeLauncherBroker();
    const relativeProfile = path.join("tmp", `launcher-session-${Date.now()}`);
    const absoluteProfile = fromRoot(relativeProfile);
    fs.mkdirSync(absoluteProfile, { recursive: true });
    const launchedRuns = [];

    const closeAndDispose = async (launched) => {
      if (!launched) return;
      await launched.context.close();
      const drained = await broker.waitForEmpty(launched.runToken, 5_000);
      assert.equal(drained.count, 0, "Browser.close 后 Chrome 进程树应自然归零");
      const disposed = await broker.dispose_(launched.runToken);
      assert.equal(disposed.ok, true);
      await broker.forget(launched.runToken);
      launchedRuns.splice(launchedRuns.indexOf(launched), 1);
    };

    try {
      await broker.start();
      const launcher = new ChromeProcessLauncher({ broker });
      const launch = async () => {
        const launched = await launcher.launch({
          userDataDir: absoluteProfile,
          launchArgs: baseLaunchArgs(false),
          headless: false,
          accountId: "session-persistence-probe",
          runToken: launcher.newRunToken(),
        });
        launchedRuns.push(launched);
        return launched;
      };

      const first = await launch();
      await first.page.goto(url, { waitUntil: "domcontentloaded" });
      assert.match(await first.page.evaluate(() => document.cookie), /keeper-session-persistence=present/);
      await closeAndDispose(first);

      const second = await launch();
      // 在服务端再次 Set-Cookie 前读取 Context，证明值来自上一次正常关闭的 Profile。
      const restored = await second.context.cookies(url);
      assert.ok(
        restored.some(
          (cookie) =>
            cookie.name === "keeper-session-persistence" && cookie.value === "present"
        ),
        "持久 Cookie 应在重新启动后仍存在"
      );
      await closeAndDispose(second);
    } finally {
      for (const launched of [...launchedRuns]) {
        await launched.context.close().catch(() => {});
        await broker.terminate(launched.runToken).catch(() => {});
        await broker.waitForEmpty(launched.runToken, 5_000).catch(() => {});
        await broker.dispose_(launched.runToken).catch(() => {});
      }
      await broker.dispose();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        fs.rmSync(absoluteProfile, { recursive: true, force: true });
      } catch {
        // 测试失败时仍可能有 Chrome 正在释放 Profile 文件锁。
      }
    }
  }
);

test("broker 启动参数唯一初始页是 about:blank 且抑制会话恢复", () => {
  const args = buildLaunchArgs({
    userDataDir: "C:/profiles/acc",
    launchArgs: baseLaunchArgs(true),
    headless: true,
  });
  assert.equal(args.at(-1), "about:blank", "唯一初始页必须是 about:blank");
  assert.equal(args.filter((arg) => !arg.startsWith("--")).length, 1, "不得有第二个初始 URL");
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--disable-session-crashed-bubble"));
  assert.ok(args.some((arg) => arg.startsWith("--user-data-dir=")));
  // 抑制恢复走命令行，不改 Preferences；若将来改为写 Preferences，禁止写 1
  // （那是"恢复上次会话"），只能写 5（新标签页）。
  assert.equal(args.some((arg) => arg.includes("restore_on_startup")), false);
});

test("broker 交互窗口使用非零调试端口，避免暴露 webdriver", () => {
  const args = buildLaunchArgs({
    userDataDir: "C:/profiles/acc",
    launchArgs: baseLaunchArgs(false),
    headless: false,
    debugPort: 32123,
  });
  assert.ok(args.includes("--remote-debugging-port=32123"));
  assert.equal(args.includes("--remote-debugging-port=0"), false);
  assert.throws(
    () =>
      buildLaunchArgs({
        userDataDir: "C:/profiles/acc",
        launchArgs: baseLaunchArgs(false),
        headless: false,
      }),
    /有效的非零本地调试端口/
  );
});
