import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { updateAccount } from "./store.js";
import { withAccountLock } from "./locks.js";
import { setCachedStatus } from "./statusMonitor.js";
import * as log from "./logger.js";

/**
 * 从已登录的 ChatGPT 页面抓取当前账号身份（邮箱等）。
 * 数据来源是 ChatGPT 自己的 /api/auth/session 接口，登录后才可用。
 * 返回 { email, name } 或 null。
 */
async function fetchIdentity(page) {
  try {
    const data = await page.evaluate(async () => {
      const res = await fetch("/api/auth/session", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      return res.json();
    });
    const user = data?.user;
    if (!user) return null;
    return { email: user.email ?? null, name: user.name ?? null };
  } catch {
    return null;
  }
}

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
 */
export async function startLogin(account) {
  const selectors = readJson("config/selectors.json");
  const taskId = newTaskId();
  const task = {
    accountId: account.id,
    status: "opening", // opening -> waiting -> success | failed | timeout
    message: "正在打开浏览器…",
    startedAt: new Date().toISOString(),
  };
  tasks.set(taskId, task);

  // 后台异步跑，不阻塞 API 响应。套账号锁：同一 profile 不能被两个浏览器同时打开。
  withAccountLock(account.id, async () => {
    let context;
    try {
      const launched = await launchForAccount(account, { headless: false });
      context = launched.context;
      const page = launched.page;
      task.context = context;
      task.page = page;
      task.status = "waiting";
      task.message = "请在弹出的浏览器窗口完成登录（含验证码/二步验证）";

      await page.goto(selectors.url, { waitUntil: "domcontentloaded" });

      // 真相来源：/api/auth/session 返回带 email 的用户，才算真正登录。
      // 不能用“输入框出现”判定 —— ChatGPT 未登录首页也有输入框。
      const deadline = Date.now() + 5 * 60 * 1000;
      let identity = null;
      while (Date.now() < deadline) {
        identity = await fetchIdentity(page);
        if (identity?.email) break;
        await page.waitForTimeout(2000);
      }

      if (identity?.email) {
        await page.waitForTimeout(1000); // 确保登录态落盘
        updateAccount(account.id, {
          email: identity.email,
          gptName: identity.name ?? null,
        });
        setCachedStatus(account.id, true, identity.email);
        task.email = identity.email;
        task.status = "success";
        task.message = `登录成功: ${identity.email}`;
        log.info(`账号 ${account.id} 绑定邮箱: ${identity.email}`);
      } else {
        task.status = "timeout";
        task.message = "5 分钟内未检测到登录成功";
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

/**
 * 检查账号当前是否已登录（无头打开，看登录标志）。用于页面显示账号状态。
 */
export async function checkLoggedIn(account) {
  const selectors = readJson("config/selectors.json");
  let context;
  try {
    const launched = await launchForAccount(account, { headless: true });
    context = launched.context;
    const page = launched.page;
    await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
    // 以 session 接口的 email 为准，DOM 输入框在未登录时也存在，不可靠。
    const identity = await fetchIdentity(page);
    if (identity?.email) {
      updateAccount(account.id, {
        email: identity.email,
        gptName: identity.name ?? null,
      });
      return { loggedIn: true, email: identity.email };
    }
    return { loggedIn: false };
  } catch {
    return { loggedIn: false };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
