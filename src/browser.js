import { chromium } from "playwright";
import { fromRoot, ensureDir } from "./paths.js";
import { proxyForAccount, ensureRunning } from "./proxyManager.js";
import { getAccount } from "./store.js";
import * as log from "./logger.js";

// 一个真实 Chrome 的 UA，减少被判定为自动化的概率。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
  // 真正启动时重新读取，避免期间修改过的 proxyId 没生效、任务走了旧出口。
  const liveAccount = getAccount(account?.id) ?? account;
  const headless = opts.headless ?? true;
  const userDataDir = ensureDir(fromRoot(liveAccount.profileDir));

  const launchArgs = {
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

  // 定向代理：账号绑定了节点就走该节点的本地端口，否则走系统默认网络。
  if (liveAccount.proxyId) {
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
        `账号绑定的代理节点不可用（可能已停用或不在订阅中），请重新选择节点或改为跟随系统`
      );
    }
  } else if (liveAccount.proxy) {
    // 兼容旧配置：proxy 形如 "http://ip:port" 或 { server, username, password }
    launchArgs.proxy =
      typeof liveAccount.proxy === "string"
        ? { server: liveAccount.proxy }
        : liveAccount.proxy;
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchArgs);

  // 抹掉最明显的自动化痕迹。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
