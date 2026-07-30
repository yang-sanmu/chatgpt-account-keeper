import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { getAccount, displayName } from "./store.js";
import { checkSession, clearSession, SESSION_OK, SESSION_REAUTH } from "./health.js";
import * as log from "./logger.js";

/**
 * 打开有头浏览器到 ChatGPT，等待用户手动完成登录（CLI 用）。
 * 因为用的是持久化 userDataDir，登录态会自动落盘，无需额外导出。
 *
 * 判定用 health.js：只看 DOM 输入框或 session 里的 email 都不可靠，
 * 改过密码/加过双重认证的账号两者都还在，但令牌已失效。
 */
export async function loginAccount(accountId) {
  const selectors = readJson("config/selectors.json");
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(`找不到账号 id=${accountId}，请检查 config/accounts.json`);
  }

  const name = displayName(account);
  log.info(`为账号「${name}」(${account.id}) 打开浏览器，请手动登录…`);
  const { context, page } = await launchForAccount(account, { headless: false });

  try {
    await page.goto(selectors.url, { waitUntil: "domcontentloaded" });

    // 旧会话若已失效，必须先清掉，否则用户看不到登录页。
    const current = await checkSession(page);
    if (current.state === SESSION_REAUTH) {
      log.warn(`检测到会话已失效（${current.detail}），清除旧登录态后请重新登录`);
      await clearSession(context);
      await page.goto(selectors.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    } else if (current.state === SESSION_OK) {
      log.info(`账号「${name}」当前已是登录状态（${current.email}），无需重新登录`);
      return true;
    }

    log.info("请在打开的浏览器窗口里完成登录（含验证码/二步验证）。");
    log.info("登录成功后本程序会自动检测到并保存，无需手动操作。");

    // 轮询等待真正登录成功，最多 5 分钟。
    const deadline = Date.now() + 5 * 60 * 1000;
    let health = null;
    while (Date.now() < deadline) {
      health = await checkSession(page);
      if (health.state === SESSION_OK) break;
      await page.waitForTimeout(2000);
    }

    if (health?.state === SESSION_OK) {
      // 持久化上下文会在关闭时把状态写盘，稍等确保落盘。
      await page.waitForTimeout(1500);
      log.info(`账号「${health.email}」登录态已保存到 ${account.profileDir}`);
      return true;
    }

    log.warn("5 分钟内未检测到登录成功。若已登录可忽略，否则请重试 login。");
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}
