import { chromium } from "playwright";
import { fromRoot, ensureDir } from "./paths.js";

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
  const headless = opts.headless ?? true;
  const userDataDir = ensureDir(fromRoot(account.profileDir));

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

  if (account.proxy) {
    // proxy 形如 { server: "http://ip:port", username, password }
    launchArgs.proxy =
      typeof account.proxy === "string"
        ? { server: account.proxy }
        : account.proxy;
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchArgs);

  // 抹掉最明显的自动化痕迹。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
