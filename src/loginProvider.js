import { launchForAccount } from "./browser.js";
import { readResourceJson } from "./paths.js";
import { getAccount, updateAccount } from "./store.js";
import { isBusy, isHeld, withAccountLock } from "./locks.js";
import { setCachedStatus } from "./statusMonitor.js";
import {
  checkSession,
  clearSession,
  SESSION_OK,
  SESSION_OUT,
  SESSION_REAUTH,
} from "./health.js";
import {
  prepareSessionForLogin,
  shouldClearSessionBeforeLogin,
} from "./sessionPolicy.js";
import { checkPromoEligibility } from "./promoEligibility.js";
import * as log from "./logger.js";

export { shouldClearSessionBeforeLogin } from "./sessionPolicy.js";

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
// accountId -> taskId；同一账号只允许一个交互式登录任务，避免请求重试或
// 双击按钮在账号锁后排队，前一个窗口关闭后又突然弹出第二个窗口。
const activeTaskByAccount = new Map();
const TERMINAL_TASK_STATUSES = new Set(["success", "failed", "timeout"]);
const LOGIN_TASK_RETENTION_MS = 30 * 60 * 1000;
const MAX_LOGIN_TASKS = 200;

/** 清理已结束任务，保留所有 active task；参数仅用于确定性测试。 */
export function pruneLoginTasks(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const retentionMs = Number.isFinite(options.retentionMs)
    ? Math.max(0, options.retentionMs)
    : LOGIN_TASK_RETENTION_MS;
  const maxTasks = Number.isFinite(options.maxTasks)
    ? Math.max(0, Math.floor(options.maxTasks))
    : MAX_LOGIN_TASKS;
  const activeIds = new Set(activeTaskByAccount.values());
  let removed = 0;

  for (const [taskId, task] of tasks) {
    if (activeIds.has(taskId) || !TERMINAL_TASK_STATUSES.has(task.status)) continue;
    const timestamp = Date.parse(task.finishedAt ?? task.startedAt);
    if (Number.isFinite(timestamp) && now - timestamp >= retentionMs) {
      tasks.delete(taskId);
      removed++;
    }
  }

  if (tasks.size > maxTasks) {
    const removable = [...tasks.entries()]
      .filter(
        ([taskId, task]) =>
          !activeIds.has(taskId) && TERMINAL_TASK_STATUSES.has(task.status)
      )
      .sort((a, b) => {
        const aTime = Date.parse(a[1].finishedAt ?? a[1].startedAt) || 0;
        const bTime = Date.parse(b[1].finishedAt ?? b[1].startedAt) || 0;
        return aTime - bTime;
      });
    for (const [taskId] of removable) {
      if (tasks.size <= maxTasks) break;
      if (tasks.delete(taskId)) removed++;
    }
  }
  return removed;
}

function newTaskId() {
  const arr = new Uint32Array(2);
  globalThis.crypto.getRandomValues(arr);
  return "login_" + arr[0].toString(36) + arr[1].toString(36);
}

export function getLoginTask(taskId) {
  pruneLoginTasks();
  const t = tasks.get(taskId);
  if (!t) return null;
  const { context, page, ...pub } = t;
  return pub;
}

export async function closeAllLoginTasks() {
  const contexts = [...tasks.values()]
    .map((task) => task.context)
    .filter(Boolean);
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  return contexts.length;
}

/**
 * 发起某账号的登录。立即返回 taskId，浏览器窗口在后台打开。
 * 用户登录成功后，任务状态变为 success。
 *
 * opts.force = true 时，进入前先清掉旧会话。用于“改了密码/加了双重认证”的账号：
 * 这类账号的旧 cookie 仍能让 /api/auth/session 返回 email，若不清就会一进来
 * 立刻被判定成功、窗口秒关，用户根本没机会重新登录。
 */
export async function startLogin(account, opts = {}, runtime = {}) {
  pruneLoginTasks();
  const launchBrowser = runtime.launchForAccount ?? launchForAccount;
  const inspectSession = runtime.checkSession ?? checkSession;
  const clearBrowserSession = runtime.clearSession ?? clearSession;
  const cacheStatus = runtime.setCachedStatus ?? setCachedStatus;
  const requestedForce = shouldClearSessionBeforeLogin(opts);
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
    cacheStatus(account.id, next.state, next.email, next.detail);
  };
  const existingTaskId = activeTaskByAccount.get(account.id);
  if (existingTaskId) {
    const existing = tasks.get(existingTaskId);
    if (existing && !TERMINAL_TASK_STATUSES.has(existing.status)) {
      // force 是不可逆的用户意图：普通任务不能冒充已经执行了强制清理。
      // 相同模式可复用；已有 force 任务也能满足后续普通登录请求。
      if (requestedForce && existing.force !== true) {
        const conflictTaskId = newTaskId();
        const conflictTask = {
          accountId: account.id,
          force: true,
          status: "failed",
          code: "LOGIN_FORCE_CONFLICT",
          conflictTaskId: existingTaskId,
          message:
            "该账号已有普通登录任务正在进行，强制重登尚未执行；请先完成或关闭当前登录窗口后重试",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        tasks.set(conflictTaskId, conflictTask);
        pruneLoginTasks();
        return {
          taskId: conflictTaskId,
          status: conflictTask.status,
          code: conflictTask.code,
          conflictTaskId: existingTaskId,
          force: true,
          message: conflictTask.message,
        };
      }
      return {
        taskId: existingTaskId,
        status: existing.status,
        reused: true,
        force: existing.force === true,
      };
    }
    activeTaskByAccount.delete(account.id);
  }

  const taskId = newTaskId();
  const task = {
    accountId: account.id,
    force: requestedForce,
    status: "opening", // opening -> waiting -> saving -> success | failed | timeout
    message: "正在打开浏览器…",
    startedAt: new Date().toISOString(),
  };

  // 长期开着“打开网页”的浏览器，或其它运行/巡检已经占用 Profile 时，
  // 登录请求必须立即给出结果，不能悄悄排队并在未来突然弹窗。
  if (isHeld(account.id) || isBusy(account.id)) {
    task.status = "failed";
    task.finishedAt = new Date().toISOString();
    task.code = isHeld(account.id)
      ? "LOGIN_ACCOUNT_HELD"
      : "LOGIN_ACCOUNT_BUSY";
    task.message = isHeld(account.id)
      ? "该账号的网页窗口仍在使用中，请先关闭窗口后再登录"
      : "该账号正在执行其它浏览器操作，请稍后重试登录";
    tasks.set(taskId, task);
    pruneLoginTasks();
    return {
      taskId,
      status: task.status,
      code: task.code,
      force: task.force,
      message: task.message,
    };
  }

  const selectors = readResourceJson("config/selectors.json");
  tasks.set(taskId, task);
  activeTaskByAccount.set(account.id, taskId);
  pruneLoginTasks();

  // 注入后走 BrowserRun：占 Chrome 槽、登记 run、用登记的 runToken 启动，关闭也经
  // BrowserRun 的完整确认序列。没注入时（旧 CLI / 测试替身）保留直接 launch。
  const acquireChrome = runtime.acquireInteractiveChrome ?? null;
  // 关闭必须与获取配对：BrowserRun 路径下直接 context.close() 会留下无人 dispose 的 Job。
  let releaseChrome = null;
  const closeChrome = async () => {
    if (releaseChrome) {
      const release = releaseChrome;
      releaseChrome = null;
      await release("login-complete");
      return;
    }
    if (task.context) await task.context.close();
  };

  // 后台异步跑，不阻塞 API 响应。套账号锁：同一 profile 不能被两个浏览器同时打开。
  withAccountLock(account.id, async () => {
    let context;
    try {
      const liveAccount = getAccount(account.id) ?? account;
      const launched = acquireChrome
        ? await acquireChrome({
            accountId: liveAccount.id,
            account: liveAccount,
            purpose: "login",
            headless: false,
          })
        : await launchBrowser(liveAccount, { headless: false });
      if (acquireChrome) releaseChrome = launched.release;
      context = launched.context;
      const page = launched.page;
      task.context = context;
      task.page = page;

      // 清登录数据是不可逆操作，只能响应用户明确点击“重新登录/强制重登”。
      // 自动健康判定即使得到 reauth，也可能来自未来尚未识别的 WAF/接口变化；
      // 普通“登录”绝不能据此清掉仍可能有效的 Session。
      const force = requestedForce;
      if (!force) {
        await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
      }
      if (force) {
        task.status = "clearing";
        task.message = "正在按你的要求清除旧登录态…";
        log.info(`账号 ${account.id} 用户已确认强制重登，清除旧登录态`);
      }
      const { current } = await prepareSessionForLogin({
        opts,
        context,
        page,
        url: selectors.url,
        checkSession: inspectSession,
        clearSession: clearBrowserSession,
        onCleared: () =>
          cacheStatus(
            account.id,
            SESSION_OUT,
            null,
            "用户已强制清理旧登录态，等待完成新登录"
          ),
      });
      if (!force) cacheChangedNonOkObservation(current);

      if (!force && current.state === SESSION_OK) {
        // 本来就是好的，直接完成，不折腾用户。
        task.status = "saving";
        task.message = "正在确认并保存登录状态…";
        await closeChrome();
        context = null;
        finishSuccess(task, account, current, cacheStatus);
        return;
      }

      task.status = "waiting";
      task.message =
        current.state === SESSION_REAUTH
          ? "会话需要重新认证；若页面未显示登录入口，请关闭窗口后点“重新登录”"
          : "请在弹出的浏览器窗口完成登录（含验证码/二步验证）";

      // 真相来源：session 有 email **且** 后端鉴权通过，才算真正登录。
      // 只看 email 会把“令牌已失效”的旧会话误判为成功。
      const deadline = Date.now() + 5 * 60 * 1000;
      let health = null;
      while (Date.now() < deadline) {
        health = await inspectSession(page);
        if (health.state === SESSION_OK) break;
        if (!force) cacheChangedNonOkObservation(health);
        await page.waitForTimeout(2000);
      }
      if (!force && health?.state !== SESSION_OK) {
        // 相同的异常不需要每两秒落盘，但任务结束时要记录最后检查时间。
        cacheChangedNonOkObservation(health, { force: true });
      }

      if (health?.state === SESSION_OK) {
        await page.waitForTimeout(1000); // 确保登录态落盘
        // 必须等持久化 Profile 完全关闭后才能向前端报告成功。
        // 否则用户立刻点“运行”时，新浏览器可能赶在 Cookie 落盘前启动，
        // 看起来就是“登录显示成功，但立即运行仍提示未登录”。
        task.status = "saving";
        task.message = "登录成功，正在保存 Session…";
        await closeChrome();
        context = null;
        finishSuccess(task, account, health, cacheStatus);
      } else {
        task.status = "timeout";
        task.finishedAt = new Date().toISOString();
        task.message =
          health?.state === SESSION_REAUTH
            ? `会话仍未通过验证：${health.detail ?? "需重新登录"}`
            : "5 分钟内未检测到登录成功";
      }
    } catch (e) {
      task.status = "failed";
      task.finishedAt = new Date().toISOString();
      if (e?.code) task.code = String(e.code);
      task.message = String(e.message || e);
      log.error(`账号 ${account.id} 登录出错: ${task.message}`);
    } finally {
      if (context) await closeChrome().catch(() => {});
      delete task.context;
      delete task.page;
      if (activeTaskByAccount.get(account.id) === taskId) {
        activeTaskByAccount.delete(account.id);
      }
      pruneLoginTasks();
    }
  });

  return { taskId, status: task.status, force: task.force };
}

function finishSuccess(task, account, health, cacheStatus = setCachedStatus) {
  updateAccount(account.id, {
    email: health.email,
    gptName: health.name ?? null,
  });
  cacheStatus(account.id, SESSION_OK, health.email);
  task.email = health.email;
  task.status = "success";
  task.finishedAt = new Date().toISOString();
  task.message = `登录成功: ${health.email}`;
  log.info(`账号 ${account.id} 绑定邮箱: ${health.email}`);
}

/**
 * 检查账号当前会话状态（无头打开）。用于页面显示账号状态。
 * 返回 { state, loggedIn, email }：state 为 ok / reauth / out / unknown，
 * loggedIn 仅在 ok 时为 true，保持与旧调用方的兼容语义。
 */
export async function checkLoggedIn(account, runtime = {}) {
  const findAccount = runtime.getAccount ?? getAccount;
  const launchBrowser = runtime.launchForAccount ?? launchForAccount;
  const inspectSession = runtime.checkSession ?? checkSession;
  const inspectPromo = runtime.checkPromoEligibility ?? checkPromoEligibility;
  const persistAccount = runtime.updateAccount ?? updateAccount;
  const selectors = readResourceJson("config/selectors.json");
  let context;
  try {
    const liveAccount = findAccount(account.id);
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
    // 调用方给了页面（队列路径）：账号锁、Chrome 与关闭都归 BrowserRun，这里不再
    // 自行 launch，也不在 finally 里关闭别人的 context。
    let page = runtime.page ?? null;
    if (!page) {
      const launched = await launchBrowser(liveAccount, {
        headless: true,
        runToken: runtime.runToken,
      });
      context = launched.context;
      page = launched.page;
    }
    await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
    const health = await inspectSession(page);
    let promo;
    if (health.state === SESSION_OK) {
      try {
        promo = await inspectPromo(page);
      } catch (error) {
        // 优惠是状态刷新里的附加观测；它失败不能把已由 /me 确认的健康会话降成 unknown。
        promo = {
          ok: false,
          detail: `优惠资格检查失败：${String(error?.message || error)}`,
        };
      }
    } else {
      promo = {
        ok: false,
        detail: "账号会话未确认，本次未检查优惠资格",
      };
    }
    // 只有 /me 已验证且邮箱与 session 一致的 SESSION_OK 才能写回账号资料。
    // WAF/unknown 响应里的邮箱只是未验证观测，不能永久覆盖绑定信息。
    if (health.state === SESSION_OK && health.email) {
      persistAccount(account.id, {
        email: health.email,
        gptName: health.name ?? null,
      });
    }
    return {
      state: health.state,
      loggedIn: health.state === SESSION_OK,
      email: health.email,
      detail: health.detail,
      promo,
    };
  } catch (e) {
    return {
      state: "unknown",
      loggedIn: false,
      email: null,
      detail: `状态检查失败：${String(e.message || e)}`,
      promo: {
        ok: false,
        detail: "状态检查失败，本次未检查优惠资格",
      },
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
