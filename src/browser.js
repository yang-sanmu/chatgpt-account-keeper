import { chromium } from "playwright";
import { fromRoot, ensureDir } from "./paths.js";
import { proxyForAccount, ensureRunning } from "./proxyManager.js";
import { getAccount, effectiveProxyId } from "./store.js";
import { resolveRegionForAccount } from "./geo.js";
import * as log from "./logger.js";

/**
 * 用本机安装的真实 Google Chrome，而不是 Playwright 自带的 Chromium。
 *
 * 为什么必须这样：Chromium 的 userAgentData.brands 只有 "Chromium"，
 * 真实 Chrome 会多一项 "Google Chrome"。Cloudflare 会交叉校验这个列表，
 * 而它无法像 UA 字符串那样被伪造。实测同一节点、同一时间窗口下，
 * 真实 Chrome/Edge（即使开无痕）都不弹验证，自带 Chromium 会弹。
 *
 * 同时**不再伪造 UA**：过去硬编码 Chrome/131 而内核实际是 149，
 * UA 与 userAgentData 自相矛盾，反倒是比不改更强的自动化特征。
 * 用真实 Chrome 自带的 UA，两者天然一致。
 */
const BROWSER_CHANNEL = "chrome";
const FORCE_TRUE_HEADLESS_ENV = "CHATGPT_ACCOUNT_KEEPER_FORCE_HEADLESS";

/**
 * WebRTC 的 UDP 不受 --proxy-server 约束，会绕过代理直接走系统网络。
 * 实测走节点的浏览器里，WebRTC 漏出的是系统 Clash 的出口 IP，与该浏览器
 * 的 HTTP 出口分属两个国家——同一会话出现两个国家的 IP 是明确的代理特征。
 *
 * 注意：品牌版 Chrome 会忽略 --force-webrtc-ip-handling-policy
 * （该策略只认企业策略配置），自带 Chromium 才吃这个开关。所以保留开关做兜底，
 * 真正生效的是下面在页面层清空 iceServers 的做法。
 */
export const WEBRTC_NO_LEAK_FLAG =
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

/**
 * 页面层堵 WebRTC：保留 RTCPeerConnection 本身，只把 iceServers 清空。
 *
 * 不直接删掉这个 API——真实 Chrome 一定有它，删了反而是更明显的特征。
 * 清空 STUN 服务器后页面仍能正常构造连接对象，但收集不到公网候选地址，
 * 也就漏不出出口 IP。ChatGPT 不使用 WebRTC，无功能影响。
 */
export function webrtcGuardScript() {
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  const Patched = function (config, ...rest) {
    return new Native({ ...(config || {}), iceServers: [] }, ...rest);
  };
  Patched.prototype = Native.prototype;
  // 保持 name / toString 与原生一致，避免被指纹脚本看出是包装过的
  Object.defineProperty(Patched, "name", { value: "RTCPeerConnection" });
  Patched.toString = () => Native.toString();
  window.RTCPeerConnection = Patched;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
}

// 把窗口挪到屏幕外的坐标。用于"本该无头"的后台任务：
// Cloudflare 看到的是真实有头浏览器，而用户看不到窗口。
const OFFSCREEN_ARGS = ["--window-position=-32000,-32000", "--window-size=1280,900"];

/**
 * 判断当前进程能否使用图形桌面。
 *
 * Linux/容器没有 DISPLAY 或 Wayland socket 时，有头 Chrome 无法启动；
 * Windows 服务会话同样没有可交互桌面。其余平台默认允许，并保留环境变量
 * 作为无法自动识别的后台环境（例如特殊计划任务）的显式兜底。
 */
export function hasGraphicalDesktop(platform = process.platform, env = process.env) {
  const forced = String(env?.[FORCE_TRUE_HEADLESS_ENV] ?? "").toLowerCase();
  if (["1", "true", "yes"].includes(forced)) return false;
  if (platform === "linux") return !!(env?.DISPLAY || env?.WAYLAND_DISPLAY);
  if (platform === "win32" && /^services$/i.test(String(env?.SESSIONNAME ?? ""))) {
    return false;
  }
  return true;
}

/**
 * 构造启动参数。
 *
 * headless 语义变了：真实 Chrome 的无头模式会被 Cloudflare 稳定拦下
 * （实测无头必 403 挑战页、有头必 200），所以这里**不真的开无头**，
 * 而是在图形桌面中启动有头浏览器并把窗口移到屏幕外。没有图形桌面时
 * 必须退回真正的无头模式，否则浏览器根本无法启动。
 */
export function baseLaunchArgs(headless, runtime = {}) {
  const desktopAvailable = hasGraphicalDesktop(
    runtime.platform ?? process.platform,
    runtime.env ?? process.env
  );
  const trueHeadless = !!headless && !desktopAvailable;
  return {
    headless: trueHeadless,
    channel: BROWSER_CHANNEL,
    // 不设 userAgent：让真实 Chrome 用它自己的 UA，避免与 userAgentData 矛盾
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      // 有图形桌面时优先用"移出屏幕"代替真正的 Headless。
      ...(headless && !trueHeadless ? OFFSCREEN_ARGS : []),
    ],
  };
}

/**
 * 只有走代理的浏览器才需要堵 WebRTC：未绑节点的账号 HTTP 本来就走系统网络，
 * 与 WebRTC 出口一致，没有可暴露的矛盾，不必改动其行为。
 */
export function applyWebrtcPolicy(launchArgs, usingProxy) {
  if (usingProxy && !launchArgs.args.includes(WEBRTC_NO_LEAK_FLAG)) {
    launchArgs.args.push(WEBRTC_NO_LEAK_FLAG);
  }
  return launchArgs;
}

/**
 * 判断启动失败是否因为本机没装对应的浏览器渠道。
 * Playwright 找不到 channel 时报的是 "Chromium distribution 'chrome' is not found"。
 */
export function isMissingChannelError(err) {
  const msg = String(err?.message || err);
  return (
    /Chromium distribution ['"]?chrome['"]? is not found/i.test(msg) ||
    /channel ['"]?chrome['"]? is not installed/i.test(msg) ||
    (/executable doesn't exist/i.test(msg) &&
      /(?:Google[\\/ ]Chrome|chrome(?:\.exe)?)/i.test(msg))
  );
}

/**
 * 为某个账号启动持久化浏览器上下文。
 * 关键点：userDataDir 落盘，登录态（cookies/localStorage）随之持久化，
 * 手动登录一次后，后续任务复用同一目录即免登录。
 *
 * @param {object} account accounts.json 里的单个账号对象
 * @param {object} opts { headless: boolean }
 * @returns {Promise<{context, page}>}
 */
export async function launchForAccount(account, opts = {}) {
  // 调用可能在账号锁后排队很久（例如用户一直开着“打开网页”窗口）。
  // 真正启动时重新读取，避免期间改过的分组/分组代理没生效、任务走了旧出口。
  const liveAccount = getAccount(account?.id) ?? account;
  const headless = opts.headless ?? true;
  const userDataDir = ensureDir(fromRoot(liveAccount.profileDir));

  const launchArgs = baseLaunchArgs(headless);

  // 定向代理：账号所属分组绑了节点就走该节点的本地端口，否则走系统默认网络。
  if (effectiveProxyId(liveAccount)) {
    // 边车必须先就绪，否则 Chromium 会连到一个还没监听的端口。
    await ensureRunning();
    const p = proxyForAccount(liveAccount);
    if (p) {
      launchArgs.proxy = p;
      log.info(`账号 ${liveAccount.id} 使用代理节点 -> ${p.server}`);
    } else {
      // 绑了节点却拿不到端口（节点被停用/已从订阅移除）。宁可报错也不静默裸奔，
      // 否则账号会用错误的出口 IP 访问，风险更高。
      throw new Error(
        `账号所属分组绑定的代理节点不可用（可能已停用或不在订阅中），请到分组管理里重新选择节点`
      );
    }

    // 时区/语言跟着出口走：境外 IP 配本机东八区时区是明显的不一致信号。
    // 探测失败就沿用默认，不阻断登录。
    const region = await resolveRegionForAccount(liveAccount);
    if (region.timezoneId) launchArgs.timezoneId = region.timezoneId;
    if (region.locale) launchArgs.locale = region.locale;

    applyWebrtcPolicy(launchArgs, true);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchArgs);
  } catch (e) {
    // 没装 Chrome 就退回自带 Chromium：指纹差一些（会更容易撞验证码），
    // 但总比完全跑不起来好。明确警告，让用户知道该装 Chrome。
    if (!isMissingChannelError(e)) throw e;
    log.warn(
      "未找到本机 Google Chrome，退回 Playwright 自带 Chromium。" +
        "自带内核的 userAgentData 缺少 Google Chrome 品牌，更容易触发人机验证，" +
        "建议安装 Chrome 后重试。"
    );
    delete launchArgs.channel;
    context = await chromium.launchPersistentContext(userDataDir, launchArgs);
  }

  // 抹掉最明显的自动化痕迹。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // 走代理时才需要堵 WebRTC：未走代理的浏览器 HTTP 与 WebRTC 同源，无矛盾可暴露。
  if (launchArgs.proxy) {
    await context.addInitScript(webrtcGuardScript);
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
