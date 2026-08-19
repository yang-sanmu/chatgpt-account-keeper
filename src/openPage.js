import {
  closeHeadlessBrowserContextsForAccount,
  launchForAccount,
} from "./browser.js";
import { readResourceJson } from "./paths.js";
import {
  isBusy,
  withAccountLock,
  markHeld,
  releaseHeld,
} from "./locks.js";
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

// accountId -> { url, openedAt, context, page, launched, cancelled, notifiedOpen }
const openSessions = new Map();

const SAMPLE_INTERVAL_MS = 10000;

// 打开/关闭观察者。窗口是用户手动关的，只有这里知道确切时刻；
// 早先上层靠每秒轮询 getOpenPages() 推断关闭，既慢又浪费。
const observers = new Set();

export function subscribeOpenPages(observer) {
  if (typeof observer !== "function") {
    throw new TypeError("open page observer must be a function");
  }
  observers.add(observer);
  return () => observers.delete(observer);
}

function notifyOpenPages(change) {
  for (const observer of observers) {
    try {
      observer(change);
    } catch {
      // 观察者异常不能影响窗口生命周期
    }
  }
}

/**
 * GCash 的授权页把 Alipay IWP Tracker 当作启动期硬依赖。部分境外节点会直接重置
 * 该静态资源域名的连接，页面随后因 initiTracker 未定义而永远停在加载文案；同一台
 * 机器直连则可正常访问。只让这个脚本 CDN 直连，GCash、Alipay 风控上报、Adyen、
 * ChatGPT 和其它页面流量仍继续使用账号所属节点。
 */
export const OPEN_PAGE_PROXY_BYPASS = [
  "gw.alipayobjects.com",
];

export function getOpenPages() {
  const out = {};
  for (const [id, s] of openSessions) {
    // “正在结束后台任务/等待账号锁”不是已打开。旧实现把这个占位也暴露给
    // Desktop，导致用户看不到窗口却被告知“已打开”。
    if (!s.context || s.cancelled) continue;
    out[id] = { url: s.url, openedAt: s.openedAt };
  }
  return out;
}

export function isPageOpen(accountId) {
  const session = openSessions.get(accountId);
  return !!session?.context && !session.cancelled;
}

async function focusOpenSession(session) {
  const result = await session.launched;
  if (!result?.ok) return result;
  try {
    await session.page?.bringToFront?.();
    return {
      ...result,
      reused: true,
      message: "已切换到现有 Chrome 窗口",
    };
  } catch {
    return {
      ok: false,
      message: "Chrome 窗口正在关闭，请稍后重试",
      code: "RESOURCE_BUSY",
    };
  }
}

/**
 * 打开窗口。等到浏览器真正启动并导航完成才返回，
 * 这样 mihomo 缺失／代理配置错误／浏览器起不来时，用户能立刻看到真实错误，
 * 而不是收到一个假的“已打开”。返回后窗口继续保持打开，直到用户手动关闭。
 */
export async function openPageForAccount(account, url, runtime = {}) {
  const existing = openSessions.get(account.id);
  if (existing) return focusOpenSession(existing);

  const selectors = readResourceJson("config/selectors.json");
  const target = (url && String(url).trim()) || selectors.url;
  const name = displayName(account);

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

  // 先占位去重，但只有拿到 Context 后才对外声明“已打开”。重复点击会等待同一
  // 次启动并在成功后 bringToFront，不再创建第二个操作然后报“已打开”。
  const session = {
    url: target,
    openedAt: new Date().toISOString(),
    context: null,
    page: null,
    launched,
    cancelled: false,
    notifiedOpen: false,
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      settle({ ok: false, message: "已取消打开 Chrome", code: "OPEN_PAGE_CANCELLED" });
    },
  };
  openSessions.set(account.id, session);
  // 标记长期占用：状态巡检不会在手动请求之后继续排入新的后台任务。
  markHeld(account.id);

  // 用户明确要求打开窗口时，让同账号正在运行的 Headless Context 先安全关闭。
  // 这等价于用户过去在任务管理器里结束那组 Chrome，但只影响目标账号，并由
  // Playwright 正常走 finally 回收；登录等有头操作不会被误关。
  const runSession = async () => {
    let context;
    try {
      const interruptHeadless =
        runtime.closeHeadlessBrowserContextsForAccount ??
        closeHeadlessBrowserContextsForAccount;
      const interrupted = Number(await interruptHeadless(account.id)) || 0;
      if (session.cancelled) return;

      // Profile 可能被登录或其它没有 Headless Context 的维护操作占用。这种情况
      // 立即返回“忙”，不能悄悄排队并在几分钟后突然弹窗。
      if (interrupted === 0 && isBusy(account.id)) {
        const busyError = new Error("该账号正在执行其它浏览器操作，请稍后重试打开网页");
        busyError.code = "RESOURCE_BUSY";
        throw busyError;
      }

      await withAccountLock(account.id, async () => {
        if (session.cancelled) return;
        const liveAccount = getAccount(account.id) ?? account;
        const launch = runtime.launchForAccount ?? launchForAccount;
        const res = await launch(liveAccount, {
          headless: false,
          proxyBypass: OPEN_PAGE_PROXY_BYPASS,
        });
        context = res.context;
        if (session.cancelled) {
          await context.close().catch(() => {});
          return;
        }
        session.context = context;
        const page = res.page;
        session.page = page;

        await page.goto(target, { waitUntil: "domcontentloaded" });
        // CDP 明确激活目标页；结合有头启动的 --start-maximized，避免 Chrome 已经
        // 导航成功但窗口仍最小化、在后台或沿用异常的屏幕外位置。
        await page.bringToFront?.();
        log.info(`「${name}」已打开网页 ${target}（窗口保持打开，关闭窗口即回收）`);

        // 到这里才算真的开起来了，通知调用方成功。
        settle({ ok: true, url: target, message: "窗口已打开，用完请手动关闭浏览器窗口" });
        session.notifiedOpen = true;
        notifyOpenPages({ accountId: account.id, open: true, url: target, openedAt: session.openedAt });

        // 用户关掉窗口 => context 触发 close。让看守循环立即醒来，
        // 不必等满一次状态采样间隔才清除 openSessions。
        let closed = false;

        // 默认不限时；设置里配了正数才启用兜底超时。
        const limitMin = Number(getSettings().openPageTimeoutMinutes) || 0;
        const deadline = limitMin > 0 ? Date.now() + limitMin * 60000 : Infinity;

        while (!closed && !session.cancelled && Date.now() < deadline) {
          const waitMs = Math.min(SAMPLE_INTERVAL_MS, deadline - Date.now());
          closed = await waitForContextCloseOrTimeout(context, waitMs);
          if (closed || session.cancelled) break;
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

        if (!closed && !session.cancelled && limitMin > 0) {
          log.warn(`「${name}」网页窗口已开启超过 ${limitMin} 分钟（设置的兜底超时），自动关闭`);
        } else {
          log.info(`「${name}」网页窗口已关闭，账号占用已释放`);
        }
      });
    } catch (e) {
      const msg = String(e.message || e);
      if (session.cancelled) log.info(`「${name}」打开网页已取消`);
      else log.error(`「${name}」打开网页出错: ${msg}`);
      settle({
        ok: false,
        message: msg,
        ...(e?.code ? { code: String(e.code) } : {}),
      });
    } finally {
      const ownsSession = openSessions.get(account.id) === session;
      if (ownsSession) openSessions.delete(account.id);
      releaseHeld(account.id);
      if (context) await context.close().catch(() => {});
      // 万一在 settle 之前就抛错/退出，兜一下避免调用方悬着
      settle({ ok: false, message: "窗口已结束" });
      if (ownsSession && session.notifiedOpen) {
        notifyOpenPages({ accountId: account.id, open: false });
      }
    }
  };
  void runSession();

  return launched;
}

/**
 * 从面板主动关闭某账号打开的窗口。
 */
export async function closePageForAccount(accountId) {
  const s = openSessions.get(accountId);
  if (!s) return false;
  s.cancel();
  if (s.context) await s.context.close().catch(() => {});
  // 后台看守循环的 finally 也会删除并通知；这里先删是为了让调用方立刻看到关闭结果，
  // 重复通知由 wasOpen 判断挡掉。
  if (openSessions.delete(accountId)) {
    releaseHeld(accountId);
    if (s.notifiedOpen) notifyOpenPages({ accountId, open: false });
  }
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
