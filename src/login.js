import { launchForAccount } from "./browser.js";
import { readResourceJson } from "./paths.js";
import { getAccount, displayName } from "./store.js";
import {
  checkSession,
  clearSession,
  SESSION_OK,
  SESSION_OUT,
  SESSION_REAUTH,
} from "./health.js";
import { setCachedStatus } from "./statusMonitor.js";
import {
  prepareSessionForLogin,
  shouldClearSessionBeforeLogin,
} from "./sessionPolicy.js";
import * as log from "./logger.js";

/**
 * 打开有头浏览器到 ChatGPT，等待用户手动完成登录（CLI 用）。
 * 因为用的是持久化 userDataDir，登录态会自动落盘，无需额外导出。
 *
 * 判定用 health.js：只看 DOM 输入框或 session 里的 email 都不可靠，
 * 改过密码/加过双重认证的账号两者都还在，但令牌已失效。
 */
export async function loginAccount(accountId, opts = {}) {
  const selectors = readResourceJson("config/selectors.json");
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(`找不到账号 id=${accountId}，请检查 config/accounts.json`);
  }

  const name = displayName(account);
  log.info(`为账号「${name}」(${account.id}) 打开浏览器，请手动登录…`);
  const { context, page } = await launchForAccount(account, { headless: false });

  try {
    let lastCachedObservation = null;
    const cacheChangedNonOkObservation = (observation, options = {}) => {
      if (!observation || observation.state === SESSION_OK) return;
      const next = {
        state: observation.state,
        email: observation.email ?? null,
        detail: observation.detail ?? null,
      };
      if (
        options.force !== true &&
        lastCachedObservation &&
        lastCachedObservation.state === next.state &&
        lastCachedObservation.email === next.email &&
        lastCachedObservation.detail === next.detail
      ) {
        return;
      }
      lastCachedObservation = next;
      setCachedStatus(account.id, next.state, next.email, next.detail);
    };

    // 强制重登直接清理，不先等待一次健康检查。清理结果必须可验证，且清后
    // 若仍为 ok 会直接失败，绝不能把旧会话误报成新登录成功。
    const force = shouldClearSessionBeforeLogin(opts);
    if (!force) {
      await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
    }
    if (force) {
      log.warn("用户已确认强制重登，正在清除旧登录态");
    }
    const { current } = await prepareSessionForLogin({
      opts,
      context,
      page,
      url: selectors.url,
      checkSession,
      clearSession,
      onCleared: () =>
        setCachedStatus(
          account.id,
          SESSION_OUT,
          null,
          "用户已强制清理旧登录态，等待完成新登录"
        ),
    });
    if (!force) cacheChangedNonOkObservation(current);

    if (!force && current.state === SESSION_OK) {
      setCachedStatus(account.id, SESSION_OK, current.email, null);
      log.info(`账号「${name}」当前已是登录状态（${current.email}），无需重新登录`);
      return true;
    } else if (current.state === SESSION_REAUTH) {
      log.warn(
        `检测到会话需要重新认证（${current.detail}）。若页面没有登录入口，请关闭窗口后用 login ${account.id} --force 明确强制重登`
      );
    }

    log.info("请在打开的浏览器窗口里完成登录（含验证码/二步验证）。");
    log.info("登录成功后本程序会自动检测到并保存，无需手动操作。");

    // 轮询等待真正登录成功，最多 5 分钟。
    const deadline = Date.now() + 5 * 60 * 1000;
    let health = null;
    while (Date.now() < deadline) {
      health = await checkSession(page);
      if (health.state === SESSION_OK) break;
      if (!force) cacheChangedNonOkObservation(health);
      await page.waitForTimeout(2000);
    }
    if (!force && health?.state !== SESSION_OK) {
      // 相同的异常不需要每两秒落盘，但任务结束时要记录最后检查时间。
      cacheChangedNonOkObservation(health, { force: true });
    }

    if (health?.state === SESSION_OK) {
      // 持久化上下文会在关闭时把状态写盘，稍等确保落盘。
      await page.waitForTimeout(1500);
      setCachedStatus(account.id, SESSION_OK, health.email, null);
      log.info(`账号「${health.email}」登录态已保存到 ${account.profileDir}`);
      return true;
    }

    log.warn("5 分钟内未检测到登录成功。若已登录可忽略，否则请重试 login。");
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}
