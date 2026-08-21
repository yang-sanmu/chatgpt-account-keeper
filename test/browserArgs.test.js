import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyInteractiveTimezone,
  applyWebrtcProfilePolicy,
  baseLaunchArgs,
  applyProxyBypass,
  buildInteractiveChromeArgs,
  chromeExecutableCandidates,
  findChromeExecutable,
  installInteractiveContextClose,
  launchInteractivePersistentContext,
  isMissingChannelError,
  isMissingCdpSessionError,
  initializeLaunchedContext,
  normalizeHeadlessIdentity,
  normalizeHeadlessUserAgent,
  normalizeChromeLaunchError,
  ChromeNotFoundError,
} from "../src/browser.js";

test("代理直连域名会保留已有规则、去重且不修改原对象", () => {
  const proxy = {
    server: "http://127.0.0.1:21001",
    bypass: "localhost,gw.alipayobjects.com",
  };

  const result = applyProxyBypass(proxy, [
    "gw.alipayobjects.com",
    " cdn.example.com ",
    "",
  ]);

  assert.deepEqual(result, {
    server: proxy.server,
    bypass: "localhost,gw.alipayobjects.com,cdn.example.com",
  });
  assert.equal(proxy.bypass, "localhost,gw.alipayobjects.com");
});

test("没有代理时不创建直连配置", () => {
  assert.equal(applyProxyBypass(null, ["gw.alipayobjects.com"]), null);
});

test("只忽略已经消失的精确 CDP child session 错误", () => {
  const gone = Object.assign(new Error("gone"), {
    code: -32001,
    cdpMessage: "Session with given id not found.",
  });
  assert.equal(isMissingCdpSessionError(gone), true);

  assert.equal(
    isMissingCdpSessionError(
      Object.assign(new Error("other"), {
        code: -32001,
        cdpMessage: "Another error",
      })
    ),
    false
  );
  assert.equal(
    isMissingCdpSessionError(
      Object.assign(new Error("method"), {
        code: -32601,
        cdpMessage: "Session with given id not found.",
      })
    ),
    false
  );
});

test("品牌 Chrome 的 WebRTC 防漏不再依赖无效启动参数", () => {
  const interactive = baseLaunchArgs(false);
  assert.equal(
    interactive.args.some((arg) => arg.includes("webrtc-ip-handling-policy")),
    false
  );

  const background = baseLaunchArgs(true);
  assert.equal(
    background.args.some((arg) => arg.includes("webrtc-ip-handling-policy")),
    false
  );
});

test("账号 Profile 原子写入 WebRTC 正式偏好并保留其它设置", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gptaccount-webrtc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, "Default");
  fs.mkdirSync(profileDir, { recursive: true });
  const preferencesFile = path.join(profileDir, "Preferences");
  fs.writeFileSync(
    preferencesFile,
    JSON.stringify({ intl: { accept_languages: "en-GB" }, webrtc: { other: 1 } }),
    "utf8"
  );

  assert.equal(applyWebrtcProfilePolicy(root), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, "utf8")), {
    intl: { accept_languages: "en-GB" },
    webrtc: {
      other: 1,
      ip_handling_policy: "disable_non_proxied_udp",
    },
  });
  assert.equal(applyWebrtcProfilePolicy(root), false, "重复启动不得反复改写文件");
  assert.deepEqual(
    fs.readdirSync(profileDir).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("损坏的 Chrome Preferences 会失败关闭且绝不被覆盖", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gptaccount-webrtc-bad-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, "Default");
  fs.mkdirSync(profileDir, { recursive: true });
  const preferencesFile = path.join(profileDir, "Preferences");
  fs.writeFileSync(preferencesFile, "{broken", "utf8");

  assert.throws(() => applyWebrtcProfilePolicy(root), /无法解析，拒绝覆盖/);
  assert.equal(fs.readFileSync(preferencesFile, "utf8"), "{broken");
});

test("反自动化 Blink 开关只用于 Headless，不进入交互付款窗口", () => {
  const interactive = baseLaunchArgs(false);
  assert.equal(interactive.headless, false);
  assert.equal(
    interactive.args.includes("--disable-blink-features=AutomationControlled"),
    false
  );

  const background = baseLaunchArgs(true);
  assert.ok(background.args.includes("--disable-blink-features=AutomationControlled"));
});

test("交互式 Chrome 只接收最小参数并正确映射代理、语言和绕过规则", () => {
  const launchArgs = baseLaunchArgs(false);
  launchArgs.locale = "en-US";
  launchArgs.proxy = {
    server: "http://127.0.0.1:21001",
    bypass: "localhost, stripe.test ",
  };
  // 即使未来上层误加，也不能被允许列表带进交互窗口。
  launchArgs.args.push("--no-sandbox", "--disable-extensions");

  const args = buildInteractiveChromeArgs({
    userDataDir: "profiles/a1",
    launchArgs,
    debugPort: 32123,
  });

  assert.ok(args.includes(`--user-data-dir=${path.resolve("profiles/a1")}`));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--remote-debugging-port=32123"));
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:21001"));
  assert.ok(args.includes("--proxy-bypass-list=localhost;stripe.test"));
  assert.ok(args.includes("--lang=en-US"));
  assert.ok(args.includes("--accept-lang=en-US"));
  assert.equal(
    args.some((arg) => arg.includes("webrtc-ip-handling-policy")),
    false
  );
  assert.equal(args.includes("--no-sandbox"), false);
  assert.equal(args.includes("--disable-extensions"), false);
  assert.equal(
    args.includes("--disable-blink-features=AutomationControlled"),
    false
  );
  assert.equal(args.at(-1), "about:blank");
});

test("Chrome 可执行文件候选覆盖 Windows 系统级与用户级安装", () => {
  const candidates = chromeExecutableCandidates(
    {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      PATH: "",
    },
    "win32"
  );
  assert.deepEqual(candidates, [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
  assert.equal(
    findChromeExecutable(candidates, (candidate) => candidate === candidates[1]),
    candidates[1]
  );
});

test("Chrome 可执行文件候选覆盖 macOS 用户安装与 Unix PATH", () => {
  const mac = chromeExecutableCandidates(
    {
      HOME: "/Users/tester",
      PATH: "/custom/bin:/usr/bin",
    },
    "darwin"
  );
  assert.ok(
    mac.includes(
      "/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
  );
  assert.ok(mac.includes("/custom/bin/google-chrome"));

  const linux = chromeExecutableCandidates(
    { PATH: "/custom/bin:/usr/bin" },
    "linux"
  );
  assert.ok(linux.includes("/custom/bin/google-chrome-stable"));
  assert.equal(
    linux.filter((candidate) => candidate === "/usr/bin/google-chrome").length,
    1,
    "固定目录与 PATH 重复时必须去重"
  );
});

test("CDP 默认 Context 的 close 会关闭原生 Chrome 且可重复调用", async (t) => {
  const browser = { close: t.mock.fn(async () => {}) };
  const child = {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: t.mock.fn(function () {
      this.killed = true;
    }),
  };
  const context = {};
  installInteractiveContextClose(context, browser, child);

  await Promise.all([context.close(), context.close()]);
  assert.equal(browser.close.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 1);
});

test("交互式 Context 的 close 等待原生 Chrome 进程退出", async (t) => {
  const browser = { close: t.mock.fn(async () => {}) };
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = t.mock.fn(function (signal = "SIGTERM") {
    this.killed = true;
    setTimeout(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }, 10);
    return true;
  });
  const context = {};
  installInteractiveContextClose(context, browser, child);

  await context.close();
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.kill.mock.callCount(), 1);
});

test("原生交互启动返回既有 API 形状并保留关闭约定", async (t) => {
  const page = { url: () => "about:blank" };
  const context = {
    pages: () => [page],
    addInitScript: t.mock.fn(async () => {}),
  };
  const browser = {
    contexts: () => [context],
    close: t.mock.fn(async () => {}),
  };
  const child = {
    exitCode: null,
    signalCode: null,
    killed: false,
    on: t.mock.fn(),
    kill: t.mock.fn(function () {
      this.killed = true;
    }),
  };
  const spawnProcess = t.mock.fn(() => child);
  const applyTimezone = t.mock.fn(async () => {});

  const launched = await launchInteractivePersistentContext(
    "profiles/a1",
    baseLaunchArgs(false),
    {
      executable: "C:\\Chrome\\chrome.exe",
      port: 32123,
      spawnProcess,
      waitForCdp: async () => {},
      connectOverCDP: async () => browser,
      applyTimezone,
    }
  );
  assert.equal(launched.context, context);
  assert.equal(launched.page, page);
  assert.equal(spawnProcess.mock.callCount(), 1);
  assert.equal(applyTimezone.mock.callCount(), 1);
  assert.equal(
    context.addInitScript.mock.callCount(),
    0,
    "原生有头路径不得注入 navigator/WebRTC 页面脚本"
  );
  await launched.context.close();
  assert.equal(browser.close.mock.callCount(), 1);
});

test("原生交互启动在地区设置失败时关闭浏览器并清理进程", async (t) => {
  const page = { url: () => "about:blank" };
  const context = { pages: () => [page] };
  const browser = {
    contexts: () => [context],
    close: t.mock.fn(async () => {}),
  };
  const child = {
    exitCode: null,
    signalCode: null,
    killed: false,
    on: t.mock.fn(),
    kill: t.mock.fn(function () {
      this.killed = true;
    }),
  };

  await assert.rejects(
    () =>
      launchInteractivePersistentContext(
        "profiles/a1",
        baseLaunchArgs(false),
        {
          executable: "C:\\Chrome\\chrome.exe",
          port: 32123,
          spawnProcess: () => child,
          waitForCdp: async () => {},
          connectOverCDP: async () => browser,
          applyTimezone: async () => {
            throw new Error("timezone failed");
          },
        }
      ),
    /timezone failed/
  );
  assert.equal(browser.close.mock.callCount(), 1);
  assert.equal(child.kill.mock.callCount(), 1);
});

test("交互时区 CDP Session 保持到页面关闭，避免覆盖立即失效", async (t) => {
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.pages = () => [page];
  const session = {
    send: t.mock.fn(async () => {}),
    detach: t.mock.fn(async () => {}),
  };
  context.newCDPSession = t.mock.fn(async () => session);

  await applyInteractiveTimezone(context, page, "Europe/London");
  assert.equal(session.send.mock.callCount(), 1);
  assert.deepEqual(session.send.mock.calls[0].arguments, [
    "Emulation.setTimezoneOverride",
    { timezoneId: "Europe/London" },
  ]);
  assert.equal(
    session.detach.mock.callCount(),
    0,
    "设置后立即 detach 会让 Chrome 恢复系统时区"
  );

  page.emit("close");
  await Promise.resolve();
  assert.equal(session.detach.mock.callCount(), 1);
});

test("交互时区会覆盖 Profile 启动时已恢复的所有标签页", async (t) => {
  const selected = new EventEmitter();
  const restored = new EventEmitter();
  const context = new EventEmitter();
  context.pages = () => [restored, selected];
  const sessions = new Map(
    [selected, restored].map((targetPage) => [
      targetPage,
      {
        send: t.mock.fn(async () => {}),
        detach: t.mock.fn(async () => {}),
      },
    ])
  );
  context.newCDPSession = t.mock.fn(async (targetPage) => sessions.get(targetPage));

  await applyInteractiveTimezone(context, selected, "Australia/Eucla");
  assert.equal(context.newCDPSession.mock.callCount(), 2);
  for (const session of sessions.values()) {
    assert.deepEqual(session.send.mock.calls[0].arguments, [
      "Emulation.setTimezoneOverride",
      { timezoneId: "Australia/Eucla" },
    ]);
  }
});

test("浏览器启动参数限制磁盘与媒体缓存", () => {
  const args = baseLaunchArgs(false);
  assert.ok(args.args.includes(`--disk-cache-size=${64 * 1024 * 1024}`));
  assert.ok(args.args.includes(`--media-cache-size=${16 * 1024 * 1024}`));
});

test("默认用真实 Chrome 且不硬编码 UA", () => {
  // 自带 Chromium 的 userAgentData 缺少 Google Chrome 品牌，是弹验证码的关键差异；
  // 启动参数本身不写死任何版本，Headless 的实际 UA 会在运行时读取。
  const args = baseLaunchArgs(true);
  assert.equal(args.channel, "chrome");
  assert.equal("userAgent" in args, false);
});

test("Headless UA 只移除产品标记并保留实际 Chrome 版本", () => {
  const native =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36";
  const normalized = normalizeHeadlessUserAgent(native);
  assert.equal(normalized.includes("HeadlessChrome"), false);
  assert.match(normalized, /Chrome\/151\.0\.0\.0/);

  const headed = native.replace("HeadlessChrome", "Chrome");
  assert.equal(normalizeHeadlessUserAgent(headed), headed);
});

test("身份规范化同时移除 UA-CH 中的 HeadlessChrome 品牌", () => {
  const native = {
    userAgent:
      "Mozilla/5.0 HeadlessChrome/149.0.7827.55 Safari/537.36",
    platform: "Win32",
    metadata: {
      brands: [
        { brand: "HeadlessChrome", version: "149" },
        { brand: "Chromium", version: "149" },
        { brand: "Not)A;Brand", version: "24" },
      ],
      fullVersionList: [
        { brand: "HeadlessChrome", version: "149.0.7827.55" },
        { brand: "Chromium", version: "149.0.7827.55" },
        { brand: "Not)A;Brand", version: "24.0.0.0" },
      ],
      platform: "Windows",
      platformVersion: "19.0.0",
      architecture: "x86",
      bitness: "64",
      mobile: false,
    },
  };

  const normalized = normalizeHeadlessIdentity(native);
  assert.doesNotMatch(normalized.userAgent, /HeadlessChrome/);
  assert.equal(
    normalized.metadata.brands.some((item) => item.brand === "HeadlessChrome"),
    false
  );
  assert.equal(
    normalized.metadata.fullVersionList.some(
      (item) => item.brand === "HeadlessChrome"
    ),
    false
  );
  assert.equal(
    normalized.metadata.brands.filter((item) => item.brand === "Chromium")
      .length,
    1,
    "已有 Chromium 品牌时不能制造重复项"
  );
  assert.equal(
    normalized.metadata.fullVersionList.find(
      (item) => item.brand === "Chromium"
    ).version,
    "149.0.7827.55"
  );
  assert.equal(
    native.metadata.brands[0].brand,
    "HeadlessChrome",
    "规范化不能修改探测结果原对象"
  );
});

test("后台任务使用真正的 Headless，不创建屏幕外窗口", () => {
  const background = baseLaunchArgs(true);
  assert.equal(background.headless, true);
  assert.deepEqual(background.viewport, { width: 1280, height: 900 });
  assert.equal(background.args.includes("--window-position=-32000,-32000"), false);
  assert.equal(background.args.includes("--start-maximized"), false);

  const interactive = baseLaunchArgs(false);
  assert.equal(interactive.headless, false);
  assert.equal(interactive.viewport, null);
  assert.equal(interactive.args.includes("--window-position=-32000,-32000"), false);
  assert.equal(interactive.args.includes("--start-maximized"), true);
});

test("浏览器启动后的初始化失败会关闭 Context 且保留原始错误", async (t) => {
  const initError = new Error("identity init failed");
  const close = t.mock.fn(async () => {});
  const page = {};
  const context = {
    addInitScript: t.mock.fn(async () => {}),
    pages: () => [page],
    on: t.mock.fn(),
    close,
  };

  await assert.rejects(
    () =>
      initializeLaunchedContext(context, {
        headless: true,
        headlessIdentity: {
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0",
          platform: "Win32",
          metadata: null,
        },
        userDataDir: "test-profile",
        targetIdentityInstaller: async () => {
          throw initError;
        },
      }),
    (error) => error === initError
  );
  assert.equal(close.mock.callCount(), 1);
});

test("识别缺少系统 Chrome 的启动错误", () => {
  assert.equal(
    isMissingChannelError(new Error("Chromium distribution 'chrome' is not found")),
    true
  );
  assert.equal(
    isMissingChannelError(
      new Error("browserType.launch: Executable doesn't exist at C:\\Program Files\\Google\\Chrome\\chrome.exe")
    ),
    true
  );
  assert.equal(
    isMissingChannelError(
      Object.assign(new Error("spawn chrome ENOENT"), {
        code: "ENOENT",
        path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      })
    ),
    true
  );
  assert.equal(
    isMissingChannelError(
      Object.assign(new Error("spawn chrome ENOENT"), {
        code: "ENOENT",
        path: "/usr/bin/google-chrome-stable",
      })
    ),
    true
  );
  // Profile 锁、进程崩溃等普通启动失败绝不能切换到另一种浏览器读取同一 Profile。
  assert.equal(isMissingChannelError(new Error("browserType.launch: Failed to launch browser")), false);
  assert.equal(isMissingChannelError(new Error("net::ERR_PROXY_CONNECTION_FAILED")), false);
});

test("缺少系统 Chrome 时返回稳定错误且绝不回退 bundled Chromium", () => {
  const original = new Error("Chromium distribution 'chrome' is not found");
  const normalized = normalizeChromeLaunchError(original);
  assert.ok(normalized instanceof ChromeNotFoundError);
  assert.equal(normalized.code, "CHROME_NOT_FOUND");
  assert.equal(normalized.retryable, false);
  assert.equal(normalized.cause, original);

  const proxyError = new Error("net::ERR_PROXY_CONNECTION_FAILED");
  assert.equal(normalizeChromeLaunchError(proxyError), proxyError);
});
