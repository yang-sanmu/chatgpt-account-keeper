import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import * as log from "./logger.js";
import { firstVisible } from "./chat.js";

/**
 * 打开有头浏览器到 ChatGPT，等待用户手动完成登录。
 * 检测到登录态标志（输入框出现）后，保存并退出。
 * 因为用的是持久化 userDataDir，登录态会自动落盘，无需额外导出。
 */
export async function loginAccount(accountId) {
  const { accounts } = readJson("config/accounts.json");
  const selectors = readJson("config/selectors.json");
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new Error(`找不到账号 id=${accountId}，请检查 config/accounts.json`);
  }

  log.info(`为账号「${account.label}」(${account.id}) 打开浏览器，请手动登录…`);
  const { context, page } = await launchForAccount(account, { headless: false });

  await page.goto(selectors.url, { waitUntil: "domcontentloaded" });

  log.info("请在打开的浏览器窗口里完成登录（含验证码/二步验证）。");
  log.info("登录成功后本程序会自动检测到并保存，无需手动操作。");

  // 轮询等待登录成功标志，最多 5 分钟。
  const deadline = Date.now() + 5 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const el = await firstVisible(page, selectors.loginIndicators, 2000).catch(
      () => null
    );
    if (el) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (loggedIn) {
    // 持久化上下文会在关闭时把状态写盘，稍等确保落盘。
    await page.waitForTimeout(1500);
    log.info(`账号「${account.label}」登录态已保存到 ${account.profileDir}`);
  } else {
    log.warn("5 分钟内未检测到登录成功。若已登录可忽略，否则请重试 login。");
  }

  await context.close();
  return loggedIn;
}
