import test from "node:test";
import assert from "node:assert/strict";
import {
  baseLaunchArgs,
  applyWebrtcPolicy,
  webrtcGuardScript,
  isMissingChannelError,
  WEBRTC_NO_LEAK_FLAG,
} from "../src/browser.js";

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

test("默认用真实 Chrome 且不伪造 UA", () => {
  // 自带 Chromium 的 userAgentData 缺少 Google Chrome 品牌，是弹验证码的关键差异；
  // 同时伪造 UA 会与真实内核版本矛盾，反而更容易被识别。
  const args = baseLaunchArgs(true);
  assert.equal(args.channel, "chrome");
  assert.equal("userAgent" in args, false);
});

test("后台任务使用屏幕外的有头 Chrome，避免无头模式触发验证页", () => {
  const desktopRuntime = { platform: "win32", env: {} };
  const background = baseLaunchArgs(true, desktopRuntime);
  assert.equal(background.headless, false);
  assert.ok(background.args.includes("--window-position=-32000,-32000"));

  const interactive = baseLaunchArgs(false, desktopRuntime);
  assert.equal(interactive.headless, false);
  assert.equal(interactive.args.includes("--window-position=-32000,-32000"), false);
});

test("无图形桌面时后台任务退回真正的无头模式", () => {
  const linuxWithoutDisplay = baseLaunchArgs(true, { platform: "linux", env: {} });
  assert.equal(linuxWithoutDisplay.headless, true);
  assert.equal(
    linuxWithoutDisplay.args.includes("--window-position=-32000,-32000"),
    false
  );

  const windowsService = baseLaunchArgs(true, {
    platform: "win32",
    env: { SESSIONNAME: "Services" },
  });
  assert.equal(windowsService.headless, true);

  const explicitlyForced = baseLaunchArgs(true, {
    platform: "darwin",
    env: { CHATGPT_ACCOUNT_KEEPER_FORCE_HEADLESS: "1" },
  });
  assert.equal(explicitlyForced.headless, true);
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

test("识别缺少浏览器渠道的启动错误以便回退", () => {
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
