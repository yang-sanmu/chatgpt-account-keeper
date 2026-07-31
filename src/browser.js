import { chromium } from "playwright";
import { fromRoot, ensureDir } from "./paths.js";
import { proxyForAccount, ensureRunning } from "./proxyManager.js";
import { getAccount, effectiveProxyId } from "./store.js";
import { resolveRegionForAccount } from "./geo.js";
import * as log from "./logger.js";

// 一个真实 Chrome 的 UA，减少被判定为自动化的概率。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * WebRTC 的 UDP 不受 --proxy-server 约束，会绕过代理直接走系统网络。
 * 实测走节点的浏览器里，WebRTC 漏出的是系统 Clash 的出口 IP，与该浏览器
 * 的 HTTP 出口分属两个国家——同一会话出现两个国家的 IP 是明确的代理特征。
 * 只走代理通道、拿不到就不给候选地址，ChatGPT 用不到 WebRTC，无功能影响。
 */
export const WEBRTC_NO_LEAK_FLAG =
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

export function baseLaunchArgs(headless) {
  return {
    headless,
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
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

  const context = await chromium.launchPersistentContext(userDataDir, launchArgs);

  // 抹掉最明显的自动化痕迹。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
