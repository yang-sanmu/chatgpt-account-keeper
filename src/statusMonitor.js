import { getAccount, getAccounts, getSettings } from "./store.js";
import { checkLoggedIn } from "./loginProvider.js";
import { withAccountLock, isBusy, isHeld } from "./locks.js";
import {
  SESSION_OK,
  SESSION_REAUTH,
  SESSION_OUT,
  SESSION_UNKNOWN,
} from "./health.js";
import {
  readPersistedStatuses,
  writePersistedStatuses,
} from "./statusCacheStore.js";
import { safeStatusCheckMinutes } from "./statusSettings.js";
import * as log from "./logger.js";

// 缓存每个账号的登录状态，前端读缓存 => 刷新即显示，无需现开浏览器。
// 后台按 settings.statusCheckMinutes 定时刷新缓存。
// state 为 ok / reauth / out / unknown；loggedIn 保留布尔语义（仅 ok 为 true）供旧前端逻辑用。
const cache = new Map(); // accountId -> { state, loggedIn, email, detail, checkedAt }
const DEFINITE_STATES = new Set([SESSION_OK, SESSION_REAUTH, SESSION_OUT]);

function emptyCachedStatus() {
  return {
    state: null,
    loggedIn: null,
    email: null,
    detail: null,
    checkedAt: null,
    lastCheckState: null,
    lastCheckDetail: null,
    confirmedState: null,
    confirmedAt: null,
    consecutiveUnknowns: 0,
    unknownSince: null,
    stale: false,
  };
}

function isDefiniteState(state) {
  return DEFINITE_STATES.has(state);
}

function normalizeObservationState(state) {
  if (typeof state === "boolean") return state ? SESSION_OK : SESSION_OUT;
  return isDefiniteState(state) ? state : SESSION_UNKNOWN;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function normalizePersistedStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const confirmedState = isDefiniteState(value.confirmedState)
    ? value.confirmedState
    : isDefiniteState(value.state)
      ? value.state
      : null;
  const checkedAt = validTimestamp(value.checkedAt);
  const confirmedAt = validTimestamp(value.confirmedAt) ?? checkedAt;
  const email = typeof value.email === "string" ? value.email : null;
  const detail = typeof value.detail === "string" ? value.detail : null;
  const lastCheckDetail =
    typeof value.lastCheckDetail === "string" ? value.lastCheckDetail : null;

  if (!confirmedState) {
    if (
      value.state !== SESSION_UNKNOWN &&
      value.lastCheckState !== SESSION_UNKNOWN
    ) {
      return null;
    }
    return {
      ...emptyCachedStatus(),
      state: SESSION_UNKNOWN,
      loggedIn: false,
      email,
      detail,
      checkedAt,
      lastCheckState: SESSION_UNKNOWN,
      lastCheckDetail,
      consecutiveUnknowns: Math.max(0, Number(value.consecutiveUnknowns) || 0),
      unknownSince: validTimestamp(value.unknownSince),
    };
  }

  const lastCheckState =
    value.lastCheckState === SESSION_UNKNOWN ||
    isDefiniteState(value.lastCheckState)
      ? value.lastCheckState
      : confirmedState;
  const hadUncertainCheck =
    value.state === SESSION_UNKNOWN ||
    lastCheckState === SESSION_UNKNOWN ||
    value.stale === true;
  return {
    state: confirmedState,
    loggedIn: confirmedState === SESSION_OK,
    email,
    detail,
    checkedAt,
    lastCheckState,
    lastCheckDetail,
    confirmedState,
    confirmedAt,
    consecutiveUnknowns: hadUncertainCheck
      ? Math.max(1, Number(value.consecutiveUnknowns) || 1)
      : 0,
    unknownSince: hadUncertainCheck ? validTimestamp(value.unknownSince) : null,
    // 跨进程恢复的结论一定是“上次确认”，新进程尚未重新验证。
    stale: true,
  };
}

function persistCache() {
  try {
    writePersistedStatuses(Object.fromEntries(cache));
  } catch (error) {
    log.warn(`保存状态巡检缓存失败：${String(error?.message || error)}`);
  }
}

function restoreCache() {
  try {
    for (const [accountId, value] of Object.entries(readPersistedStatuses())) {
      const normalized = normalizePersistedStatus(value);
      if (normalized) cache.set(accountId, normalized);
    }
  } catch (error) {
    log.warn(`读取状态巡检缓存失败，将从空缓存开始：${String(error?.message || error)}`);
  }
}

restoreCache();

export function getCachedStatus(accountId) {
  return cache.get(accountId) ?? emptyCachedStatus();
}

export function getAllCachedStatus() {
  // 防御性清理由旧版本、外部配置修改或异常删除留下的幽灵状态。
  const liveIds = new Set(getAccounts().map((account) => account.id));
  let pruned = false;
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) {
      cache.delete(id);
      pruned = true;
    }
  }
  if (pruned) persistCache();
  const out = {};
  for (const [id, v] of cache) out[id] = v;
  return out;
}

export function deleteCachedStatus(accountId) {
  const deleted = cache.delete(accountId);
  if (deleted) persistCache();
  return deleted;
}

/**
 * 把“最近一次原始探测”与“最近一次明确结论”合并。
 *
 * 网络/WAF 抖动不能抹掉已确认状态。只要曾有明确结论，unknown 仅标记
 * “最近检查未确认”；只有后续明确的 ok / reauth / out 才能改变有效状态。
 */
export function mergeStatusObservation(previous, observation, options = {}) {
  const prev = previous ?? emptyCachedStatus();
  const state = normalizeObservationState(observation?.state);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const now = new Date(nowMs).toISOString();
  const detail = observation?.detail ?? null;
  const email = observation?.email ?? prev.email ?? null;

  if (isDefiniteState(state)) {
    return {
      state: state ?? null,
      loggedIn: state === SESSION_OK,
      email,
      detail,
      checkedAt: now,
      lastCheckState: state ?? null,
      lastCheckDetail: detail,
      confirmedState: state ?? null,
      confirmedAt: now,
      consecutiveUnknowns: 0,
      unknownSince: null,
      stale: false,
    };
  }

  const consecutiveUnknowns =
    prev.lastCheckState === SESSION_UNKNOWN
      ? (prev.consecutiveUnknowns ?? 0) + 1
      : 1;
  const unknownSince =
    prev.lastCheckState === SESSION_UNKNOWN && prev.unknownSince
      ? prev.unknownSince
      : now;
  const confirmedState = isDefiniteState(prev.confirmedState)
    ? prev.confirmedState
    : isDefiniteState(prev.state)
      ? prev.state
      : null;
  const confirmedAt = prev.confirmedAt ?? prev.checkedAt ?? null;

  if (!confirmedState) {
    return {
      state: SESSION_UNKNOWN,
      loggedIn: false,
      email,
      detail,
      checkedAt: now,
      lastCheckState: SESSION_UNKNOWN,
      lastCheckDetail: detail,
      confirmedState: null,
      confirmedAt: null,
      consecutiveUnknowns,
      unknownSince,
      stale: false,
    };
  }

  return {
    ...prev,
    state: confirmedState,
    loggedIn: confirmedState === SESSION_OK,
    // unknown 的身份信息也不可信，不能覆盖最近一次明确确认的账号邮箱。
    email: prev.email ?? null,
    checkedAt: now,
    lastCheckState: SESSION_UNKNOWN,
    lastCheckDetail: detail,
    consecutiveUnknowns,
    unknownSince,
    confirmedState,
    confirmedAt,
    stale: true,
  };
}

/**
 * 写入状态缓存。第二参数既接受状态字符串，也接受布尔（兼容旧调用）。
 * unknown 有明确基线时保留原有效状态，并通过 stale / lastCheckState 暴露异常。
 */
export function setCachedStatus(accountId, state, email, detail = null, options = {}) {
  const next = mergeStatusObservation(
    cache.get(accountId),
    { state, email, detail },
    options
  );
  cache.set(accountId, next);
  persistCache();
  return next;
}

function heldCachedStatus(accountId) {
  const cached = getCachedStatus(accountId);
  return {
    ...cached,
    skipped: true,
    skipKind: "held",
    skipReason: "账号窗口正在使用，状态由已打开的窗口自动采样",
  };
}

function busyCachedStatus(accountId) {
  const cached = getCachedStatus(accountId);
  return {
    ...cached,
    skipped: true,
    skipKind: "busy",
    skipReason: "账号正在执行其它任务，已返回最近缓存状态",
  };
}

// 检查单个账号并更新缓存（经账号锁，避免与登录/跑任务撞车）。
export async function refreshAccount(account) {
  if (isHeld(account.id)) {
    return heldCachedStatus(account.id);
  }
  if (isBusy(account.id)) {
    return busyCachedStatus(account.id);
  }
  if (!getAccount(account.id)) {
    deleteCachedStatus(account.id);
    return {
      state: null,
      loggedIn: false,
      email: null,
      detail: "账号已删除，已跳过状态检查",
      skipped: true,
      deleted: true,
    };
  }
  const result = await withAccountLock(account.id, () => {
    // 排队期间用户可能刚打开了网页；拿到锁后必须再检查一次。
    if (isHeld(account.id)) return heldCachedStatus(account.id);
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
    return checkLoggedIn(liveAccount);
  });
  if (result.deleted) {
    deleteCachedStatus(account.id);
    return result;
  }
  if (result.skipped) return result;
  return setCachedStatus(
    account.id,
    result.state,
    result.email,
    result.detail ?? null
  );
}

let timer = null;

export function shouldRunImmediateCheck(settings, isStartup) {
  if (!isStartup) return false;
  if (settings?.statusCheckOnStartup === undefined) return true;
  return settings.statusCheckOnStartup === true;
}

// 巡检并发上限：既别把机器压垮，也别像原来那样纯串行——
// 纯串行时只要有一个账号被占用（比如用户开着“打开网页”的窗口），
// 后面所有账号的状态检查都会一直排在它后面。
const CHECK_CONCURRENCY = 3;

async function performTick() {
  // 正在被用户手动使用（打开网页）的账号直接跳过：
  // 它的锁被长期持有，排队等它毫无意义；而且那个循环本身就在采样状态。
  const accounts = getAccounts().filter((a) => !isHeld(a.id) && !isBusy(a.id));

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

export function createSingleFlight(task) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    const run = Promise.resolve().then(() => task(...args));
    const guarded = run.finally(() => {
      if (inFlight === guarded) inFlight = null;
    });
    inFlight = guarded;
    return guarded;
  };
}

const tick = createSingleFlight(performTick);

function triggerTick() {
  tick().catch((error) => {
    log.warn(`状态巡检失败：${String(error?.message || error)}`);
  });
}

function resetStatusMonitor(runStartupCheck) {
  const settings = getSettings();
  const min = safeStatusCheckMinutes(settings.statusCheckMinutes);
  const runImmediately = shouldRunImmediateCheck(settings, runStartupCheck);
  if (timer) clearInterval(timer);
  if (runImmediately) triggerTick();
  timer = setInterval(triggerTick, Math.max(1, min) * 60 * 1000);
  const startupText = runImmediately ? "，启动后立即检查" : "，首次检查等待一个间隔";
  log.info(`状态监控已启动，每 ${min} 分钟检查一次登录状态${startupText}`);
}

export function startStatusMonitor() {
  resetStatusMonitor(true);
}

// 设置里改了间隔后调用，重置定时器。
export function restartStatusMonitor() {
  // 保存设置不算“项目启动”，只从此刻重新计算下一次巡检时间。
  resetStatusMonitor(false);
}
