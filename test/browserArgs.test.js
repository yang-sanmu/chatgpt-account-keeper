import test from "node:test";
import assert from "node:assert/strict";
import {
  baseLaunchArgs,
  applyProxyBypass,
  applyWebrtcPolicy,
  webrtcGuardScript,
  isMissingChannelError,
  isMissingCdpSessionError,
  initializeLaunchedContext,
  normalizeHeadlessIdentity,
  normalizeHeadlessUserAgent,
  normalizeChromeLaunchError,
  ChromeNotFoundError,
  WEBRTC_NO_LEAK_FLAG,
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

test("走代理的浏览器必须堵住 WebRTC 泄露", () => {
  // 实测：不加这个开关时，走韩国节点的浏览器会通过 WebRTC 漏出系统 Clash
  // 的美国出口 IP，同一会话出现两个国家的 IP。
  const args = applyWebrtcPolicy(baseLaunchArgs(true), true);
  assert.ok(args.args.includes(WEBRTC_NO_LEAK_FLAG));
});

test("未走代理时不改动 WebRTC 行为", () => {
  // 未绑节点的账号 HTTP 与 WebRTC 都走系统网络，本来就一致，无需干预。
  const args = applyWebrtcPolicy(baseLaunchArgs(true), false);
  assert.equal(args.args.includes(WEBRTC_NO_LEAK_FLAG), false);
});

test("重复调用不会累积重复开关", () => {
  let args = baseLaunchArgs(true);
  args = applyWebrtcPolicy(args, true);
  args = applyWebrtcPolicy(args, true);
  const hits = args.args.filter((a) => a === WEBRTC_NO_LEAK_FLAG);
  assert.equal(hits.length, 1);
});

test("基础启动参数保留既有的反自动化开关", () => {
  const args = baseLaunchArgs(false);
  assert.equal(args.headless, false);
  assert.ok(args.args.includes("--disable-blink-features=AutomationControlled"));
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
  assert.equal(background.args.includes("--window-position=-32000,-32000"), false);

  const interactive = baseLaunchArgs(false);
  assert.equal(interactive.headless, false);
  assert.equal(interactive.args.includes("--window-position=-32000,-32000"), false);
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

test("WebRTC 防护清空 iceServers 但保留原生外观", () => {
  // 在最小的 window/RTCPeerConnection 替身上跑守卫脚本
  let seenConfig = null;
  class FakeNative {
    constructor(cfg) {
      seenConfig = cfg;
    }
    static toString() {
      return "function RTCPeerConnection() { [native code] }";
    }
  }
  // 脚本在页面里以 window 为全局对象，这里用 globalThis.window 模拟
  const win = { RTCPeerConnection: FakeNative };
  globalThis.window = win;
  webrtcGuardScript();

  const Patched = win.RTCPeerConnection;
  new Patched({ iceServers: [{ urls: "stun:example.com" }] });
  assert.deepEqual(seenConfig.iceServers, [], "STUN 服务器必须被清空");
  assert.equal(Patched.name, "RTCPeerConnection", "name 需与原生一致");
  assert.match(Patched.toString(), /native code/, "toString 需伪装成原生");
  delete globalThis.window;
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
