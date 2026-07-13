import { getAccounts, getSettings } from "./store.js";
import { checkLoggedIn } from "./loginProvider.js";
import { withAccountLock } from "./locks.js";
import * as log from "./logger.js";

// 缓存每个账号的登录状态，前端读缓存 => 刷新即显示，无需现开浏览器。
// 后台按 settings.statusCheckMinutes 定时刷新缓存。
const cache = new Map(); // accountId -> { loggedIn, email, checkedAt }

export function getCachedStatus(accountId) {
  return cache.get(accountId) ?? { loggedIn: null, email: null, checkedAt: null };
}

export function getAllCachedStatus() {
  const out = {};
  for (const [id, v] of cache) out[id] = v;
  return out;
}

export function setCachedStatus(accountId, loggedIn, email) {
  cache.set(accountId, {
    loggedIn,
    email: email ?? null,
    checkedAt: new Date().toISOString(),
  });
}

// 检查单个账号并更新缓存（经账号锁，避免与登录/跑任务撞车）。
export async function refreshAccount(account) {
  const result = await withAccountLock(account.id, () => checkLoggedIn(account));
  setCachedStatus(account.id, result.loggedIn, result.email);
  return result;
}

let timer = null;

async function tick() {
  const accounts = getAccounts();
  for (const acc of accounts) {
    try {
      await refreshAccount(acc);
    } catch (e) {
      log.warn(`状态检查失败 ${acc.id}: ${e.message}`);
    }
  }
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
