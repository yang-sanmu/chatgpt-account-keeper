import { getAccounts, getSettings } from "./store.js";
import { checkLoggedIn } from "./loginProvider.js";
import { withAccountLock, isHeld } from "./locks.js";
import { SESSION_OK, SESSION_OUT } from "./health.js";
import * as log from "./logger.js";

// 缓存每个账号的登录状态，前端读缓存 => 刷新即显示，无需现开浏览器。
// 后台按 settings.statusCheckMinutes 定时刷新缓存。
// state 为三态 ok / reauth / out；loggedIn 保留布尔语义（仅 ok 为 true）供旧前端逻辑用。
const cache = new Map(); // accountId -> { state, loggedIn, email, detail, checkedAt }

export function getCachedStatus(accountId) {
  return (
    cache.get(accountId) ?? {
      state: null,
      loggedIn: null,
      email: null,
      detail: null,
      checkedAt: null,
    }
  );
}

export function getAllCachedStatus() {
  const out = {};
  for (const [id, v] of cache) out[id] = v;
  return out;
}

/**
 * 写入状态缓存。第二参数既接受状态字符串，也接受布尔（兼容旧调用）。
 * loggedIn 只在明确 ok 时为 true —— unknown 不算已登录，避免面板谎报。
 */
export function setCachedStatus(accountId, state, email, detail = null) {
  const st = typeof state === "boolean" ? (state ? SESSION_OK : SESSION_OUT) : state;
  cache.set(accountId, {
    state: st,
    loggedIn: st === SESSION_OK,
    email: email ?? null,
    detail,
    checkedAt: new Date().toISOString(),
  });
}

// 检查单个账号并更新缓存（经账号锁，避免与登录/跑任务撞车）。
export async function refreshAccount(account) {
  if (isHeld(account.id)) {
    const cached = getCachedStatus(account.id);
    return {
      ...cached,
      skipped: true,
      detail: cached.detail ?? "账号窗口正在使用，状态由已打开的窗口自动采样",
    };
  }
  const result = await withAccountLock(account.id, () => checkLoggedIn(account));
  setCachedStatus(account.id, result.state, result.email, result.detail ?? null);
  return result;
}

let timer = null;

// 巡检并发上限：既别把机器压垮，也别像原来那样纯串行——
// 纯串行时只要有一个账号被占用（比如用户开着“打开网页”的窗口），
// 后面所有账号的状态检查都会一直排在它后面。
const CHECK_CONCURRENCY = 3;

async function tick() {
  // 正在被用户手动使用（打开网页）的账号直接跳过：
  // 它的锁被长期持有，排队等它毫无意义；而且那个循环本身就在采样状态。
  const accounts = getAccounts().filter((a) => !isHeld(a.id));

  const queue = [...accounts];
  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const acc = queue.shift();
      if (!acc) break;
      try {
        await refreshAccount(acc);
      } catch (e) {
        log.warn(`状态检查失败 ${acc.id}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
}

export function startStatusMonitor() {
  const settings = getSettings();
  const min = settings.statusCheckMinutes ?? 15;
  if (timer) clearInterval(timer);
  // 启动后先跑一轮，之后按间隔轮询
  tick();
  timer = setInterval(tick, Math.max(1, min) * 60 * 1000);
  log.info(`状态监控已启动，每 ${min} 分钟检查一次登录状态`);
}

// 设置里改了间隔后调用，重置定时器。
export function restartStatusMonitor() {
  startStatusMonitor();
}
