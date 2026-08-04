import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { withAccountLock, markHeld, releaseHeld } from "./locks.js";
import { setCachedStatus } from "./statusMonitor.js";
import { checkSession } from "./health.js";
import { displayName, getAccount, getSettings } from "./store.js";
import * as log from "./logger.js";

/**
 * “打开网页”：用账号的持久化 profile 打开一个有头浏览器窗口，交给用户自己用。
 *
 * 与登录流程的区别：登录流程一检测到登录成功就收窗口；这里**不会**自动关，
 * 一直开到用户手动关闭为止（默认不限时，可在设置里配 openPageTimeoutMinutes 兜底）。
 *
 * 窗口开着期间持有账号锁，避免调度器同时打开同一个 profile
 * （同一 userDataDir 被两个 Chromium 打开会锁冲突）。期间顺带定期采样一次
 * 会话状态，用户在窗口里刚完成的重新登录能立刻反映到面板上。
 */

// accountId -> { url, openedAt, context }
const openSessions = new Map();

const SAMPLE_INTERVAL_MS = 10000;

export function getOpenPages() {
  const out = {};
  for (const [id, s] of openSessions) {
    out[id] = { url: s.url, openedAt: s.openedAt };
  }
  return out;
}

export function isPageOpen(accountId) {
  return openSessions.has(accountId);
}

/**
 * 打开窗口。等到浏览器真正启动并导航完成才返回，
 * 这样 mihomo 缺失／代理配置错误／浏览器起不来时，用户能立刻看到真实错误，
 * 而不是收到一个假的“已打开”。返回后窗口继续保持打开，直到用户手动关闭。
 */
export async function openPageForAccount(account, url, runtime = {}) {
  if (openSessions.has(account.id)) {
    return { ok: false, alreadyOpen: true, message: "该账号已有打开的窗口" };
  }

  const selectors = readJson("config/selectors.json");
  const target = (url && String(url).trim()) || selectors.url;
  const name = displayName(account);

  // 占位，避免同一账号连点两次开出两个窗口。
  const session = { url: target, openedAt: new Date().toISOString(), context: null };
  openSessions.set(account.id, session);
  // 标记长期占用：状态巡检会跳过该账号，不去排队等这把锁。
  markHeld(account.id);

  // 用于把“启动成功/失败”回传给 API 调用方，而看守循环继续在后台跑。
  // 只有第一次调用生效（Promise 本身也只认第一次，这里显式化便于阅读）。
  let settle = () => {};
  const launched = new Promise((resolve) => {
    let done = false;
    settle = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
  });

  // 后台持锁跑：拿锁、启动、导航，然后一直守着直到窗口关闭。
  withAccountLock(account.id, async () => {
    let context;
    try {
      const liveAccount = getAccount(account.id) ?? account;
      const launch = runtime.launchForAccount ?? launchForAccount;
      const res = await launch(liveAccount, { headless: false });
      context = res.context;
      session.context = context;
      const page = res.page;

      await page.goto(target, { waitUntil: "domcontentloaded" });
      log.info(`「${name}」已打开网页 ${target}（窗口保持打开，关闭窗口即回收）`);

      // 到这里才算真的开起来了，通知调用方成功。
      settle({ ok: true, url: target, message: "窗口已打开，用完请手动关闭浏览器窗口" });

      // 用户关掉窗口 => context 触发 close。让看守循环立即醒来，
      // 不必等满一次状态采样间隔才清除 openSessions。
      let closed = false;

      // 默认不限时；设置里配了正数才启用兜底超时。
      const limitMin = Number(getSettings().openPageTimeoutMinutes) || 0;
      const deadline = limitMin > 0 ? Date.now() + limitMin * 60000 : Infinity;

      while (!closed && Date.now() < deadline) {
        const waitMs = Math.min(SAMPLE_INTERVAL_MS, deadline - Date.now());
        closed = await waitForContextCloseOrTimeout(context, waitMs);
        if (closed) break;
        // 从这个活页面采样登录状态：用户刚在窗口里重新登录，面板能马上看到。
        try {
          if (context.pages().length === 0) break;
          const live = context.pages()[0];
          if (live.url().includes("chatgpt.com")) {
            const health = await checkSession(live);
            setCachedStatus(account.id, health.state, health.email, health.detail);
          }
        } catch {
          // 窗口可能正在关闭，忽略本次采样
        }
      }

      if (!closed && limitMin > 0) {
        log.warn(`「${name}」网页窗口已开启超过 ${limitMin} 分钟（设置的兜底超时），自动关闭`);
      } else {
        log.info(`「${name}」网页窗口已关闭，账号占用已释放`);
      }
    } catch (e) {
      const msg = String(e.message || e);
      log.error(`「${name}」打开网页出错: ${msg}`);
      settle({ ok: false, message: msg });
    } finally {
      openSessions.delete(account.id);
      releaseHeld(account.id);
      if (context) await context.close().catch(() => {});
      // 万一在 settle 之前就抛错/退出，兜一下避免调用方悬着
      settle({ ok: false, message: "窗口已结束" });
    }
  });

  return launched;
}

/**
 * 从面板主动关闭某账号打开的窗口。
 */
export async function closePageForAccount(accountId) {
  const s = openSessions.get(accountId);
  if (!s) return false;
  if (s.context) await s.context.close().catch(() => {});
  openSessions.delete(accountId);
  releaseHeld(accountId);
  return true;
}

export async function closeAllOpenPages() {
  const accountIds = [...openSessions.keys()];
  await Promise.all(
    accountIds.map((accountId) => closePageForAccount(accountId))
  );
  return accountIds.length;
}

function waitForContextCloseOrTimeout(context, timeoutMs) {
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    context.once("close", onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}
