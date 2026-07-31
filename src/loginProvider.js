import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { getAccount, updateAccount } from "./store.js";
import { withAccountLock } from "./locks.js";
import { setCachedStatus } from "./statusMonitor.js";
import { checkSession, clearSession, SESSION_OK, SESSION_REAUTH } from "./health.js";
import * as log from "./logger.js";

/**
 * 登录任务状态跟踪。因为网页登录是交互式的（要点验证码/二步验证），
 * API 不能同步等待，所以做成异步任务：前端发起 → 轮询状态。
 *
 * 关键抽象：本机模式下，startLogin 打开真实浏览器窗口给用户登录。
 * 以后上服务器时，只需换一个 provider（noVNC 远程浏览器），
 * 保持相同的 { taskId, status } 契约，上层 API 和前端都不用动。
 */

// taskId -> { accountId, status, message, startedAt, context }
const tasks = new Map();

function newTaskId() {
  const arr = new Uint32Array(2);
  globalThis.crypto.getRandomValues(arr);
  return "login_" + arr[0].toString(36) + arr[1].toString(36);
}

export function getLoginTask(taskId) {
  const t = tasks.get(taskId);
  if (!t) return null;
  const { context, page, ...pub } = t;
  return pub;
}

/**
 * 发起某账号的登录。立即返回 taskId，浏览器窗口在后台打开。
 * 用户登录成功后，任务状态变为 success。
 *
 * opts.force = true 时，进入前先清掉旧会话。用于“改了密码/加了双重认证”的账号：
 * 这类账号的旧 cookie 仍能让 /api/auth/session 返回 email，若不清就会一进来
 * 立刻被判定成功、窗口秒关，用户根本没机会重新登录。
 */
export async function startLogin(account, opts = {}) {
  const selectors = readJson("config/selectors.json");
  const taskId = newTaskId();
  const task = {
    accountId: account.id,
    status: "opening", // opening -> waiting -> saving -> success | failed | timeout
    message: "正在打开浏览器…",
    startedAt: new Date().toISOString(),
  };
  tasks.set(taskId, task);

  // 后台异步跑，不阻塞 API 响应。套账号锁：同一 profile 不能被两个浏览器同时打开。
  withAccountLock(account.id, async () => {
    let context;
    try {
      const liveAccount = getAccount(account.id) ?? account;
      const launched = await launchForAccount(liveAccount, { headless: false });
      context = launched.context;
      const page = launched.page;
      task.context = context;
      task.page = page;

      await page.goto(selectors.url, { waitUntil: "domcontentloaded" });

      // 先看现状：已有会话是否还真的可用。
      let current = await checkSession(page);

      // 会话失效（或调用方强制），必须先清干净，否则用户看不到登录页。
      if (opts.force || current.state === SESSION_REAUTH) {
        task.status = "clearing";
        task.message = "检测到会话已失效，正在清除旧登录态…";
        log.info(`账号 ${account.id} 会话失效（${current.detail ?? "强制重登"}），清除旧登录态`);
        await clearSession(context);
        await page.goto(selectors.url, { waitUntil: "domcontentloaded" }).catch(() => {});
        current = await checkSession(page);
      } else if (current.state === SESSION_OK) {
        // 本来就是好的，直接完成，不折腾用户。
        task.status = "saving";
        task.message = "正在确认并保存登录状态…";
        await context.close();
        context = null;
        finishSuccess(task, account, current);
        return;
      }

      task.status = "waiting";
      task.message = "请在弹出的浏览器窗口完成登录（含验证码/二步验证）";

      // 真相来源：session 有 email **且** 后端鉴权通过，才算真正登录。
      // 只看 email 会把“令牌已失效”的旧会话误判为成功。
      const deadline = Date.now() + 5 * 60 * 1000;
      let health = null;
      while (Date.now() < deadline) {
        health = await checkSession(page);
        if (health.state === SESSION_OK) break;
        await page.waitForTimeout(2000);
      }

      if (health?.state === SESSION_OK) {
        await page.waitForTimeout(1000); // 确保登录态落盘
        // 必须等持久化 Profile 完全关闭后才能向前端报告成功。
        // 否则用户立刻点“运行”时，新浏览器可能赶在 Cookie 落盘前启动，
        // 看起来就是“登录显示成功，但立即运行仍提示未登录”。
        task.status = "saving";
        task.message = "登录成功，正在保存 Session…";
        await context.close();
        context = null;
        finishSuccess(task, account, health);
      } else {
        task.status = "timeout";
        task.message =
          health?.state === SESSION_REAUTH
            ? `会话仍未通过验证：${health.detail ?? "需重新登录"}`
            : "5 分钟内未检测到登录成功";
      }
    } catch (e) {
      task.status = "failed";
      task.message = String(e.message || e);
      log.error(`账号 ${account.id} 登录出错: ${task.message}`);
    } finally {
      if (context) await context.close().catch(() => {});
      delete task.context;
      delete task.page;
    }
  });

  return { taskId, status: task.status };
}

function finishSuccess(task, account, health) {
  updateAccount(account.id, {
    email: health.email,
    gptName: health.name ?? null,
  });
  setCachedStatus(account.id, SESSION_OK, health.email);
  task.email = health.email;
  task.status = "success";
  task.message = `登录成功: ${health.email}`;
  log.info(`账号 ${account.id} 绑定邮箱: ${health.email}`);
}

/**
 * 检查账号当前会话状态（无头打开）。用于页面显示账号状态。
 * 返回 { state, loggedIn, email }：state 为 ok / reauth / out 三态，
 * loggedIn 仅在 ok 时为 true，保持与旧调用方的兼容语义。
 */
export async function checkLoggedIn(account) {
  const selectors = readJson("config/selectors.json");
  let context;
  try {
    const liveAccount = getAccount(account.id);
    if (!liveAccount) {
      return {
        state: null,
        loggedIn: false,
        email: null,
        detail: "账号已删除，已跳过状态检查",
        skipped: true,
        deleted: true,
      };
    }
    const launched = await launchForAccount(liveAccount, { headless: true });
    context = launched.context;
    const page = launched.page;
    await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
    const health = await checkSession(page);
    if (health.email) {
      updateAccount(account.id, {
        email: health.email,
        gptName: health.name ?? null,
      });
    }
    return {
      state: health.state,
      loggedIn: health.state === SESSION_OK,
      email: health.email,
      detail: health.detail,
    };
  } catch (e) {
    return {
      state: "unknown",
      loggedIn: false,
      email: null,
      detail: `状态检查失败：${String(e.message || e)}`,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
