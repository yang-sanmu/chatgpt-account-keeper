import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { runAgent } from "./agent.js";
import { getAccounts, getAccount, getSettings, displayName } from "./store.js";
import { selectSetForAccount, commitWindow } from "./rotation.js";
import { withAccountLock } from "./locks.js";
import { recordConversation } from "./logger.js";
import { checkSession, SESSION_OK, SESSION_REAUTH, SESSION_UNKNOWN } from "./health.js";
import { setCachedStatus } from "./statusMonitor.js";
import * as log from "./logger.js";

function secureRandom() {
  try {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return arr[0] / 2 ** 32;
  } catch {
    return 0.5;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 让单个账号跑一次 agent 多轮对话。返回 { ok, topic, threads, totalRounds, reason }。
 */
export async function runOnce(account, opts = {}) {
  const selectors = readJson("config/selectors.json");
  const name = displayName(account);
  // 套账号锁：同一 profile 不能被两个浏览器实例同时打开。
  // 主题选择与窗口计数都放在锁内，避免并发触发时轮换状态读-改-写竞态。
  return withAccountLock(account.id, async () => {
    // 用锁内最新账号数据选主题（切换时已持久化新状态）。
    const fresh = getAccount(account.id) ?? account;
    const picked = selectSetForAccount(fresh);
    if (!picked) {
      return { ok: false, reason: "没有可用的会话集主题，请先在“会话内容”里配置" };
    }
    const { setName, set } = picked;

    const { context, page } = await launchForAccount(fresh, {
      headless: opts.headless ?? true,
    });
    try {
      await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
      // 会话健康检查：只看 email 会把“令牌已失效”的账号误判为已登录，
      // 结果白跑一轮浏览器最后死在“找不到输入框”。这里直接快速失败并说清原因。
      const health = await checkSession(page);
      setCachedStatus(account.id, health.state, health.email, health.detail);
      if (health.state === SESSION_REAUTH) {
        return {
          ok: false,
          reason: `会话已失效（${health.detail ?? "需重新登录"}），请点“重新登录”`,
          needReauth: true,
        };
      }
      if (health.state === SESSION_UNKNOWN) {
        // 没能确认会话状态（网络抖动/限流）。不因此跳过本轮——真跑不动会在
        // 后面发消息时失败并记下原因；但状态缓存里保持 unknown，不谎称已登录。
        log.warn(`「${name}」${health.detail ?? "会话状态未确认"}，仍尝试继续`);
      } else if (health.state !== SESSION_OK) {
        return { ok: false, reason: "未登录，请先登录该账号" };
      }
      log.info(`「${name}」开始 agent 对话，主题「${set.topic}」(${setName})`);
      const result = await runAgent(page, selectors, set);
      log.info(`「${name}」完成 ${result.totalRounds ?? 0} 轮对话`);
      // 只有对话成功才算跑完一个有效窗口，失败不消耗计数。
      if (result.ok) {
        const latest = getAccount(account.id);
        commitWindow(account.id, latest?.rotation);
      }
      return { ...result, setName };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    } finally {
      await context.close();
    }
  });
}

/**
 * 调度器服务：单例，可被 API 启停并查询状态。
 */
class SchedulerService {
  constructor() {
    this.running = false;
    this._stopRequested = false;
    // 每账号一条独立循环：accountId -> { nextAt, lastAt, busy, promise }
    this._accountLoops = new Map();
    this.lastResults = {}; // accountId -> { ok, reason, time }
  }

  // 计算一次间隔：interval ± jitter（分钟）转毫秒，下限 1 分钟。
  _nextDelayMs() {
    const s = getSettings();
    const intervalMin = s.intervalMinutes ?? 180;
    const jitterMin = s.jitterMinutes ?? 30;
    const jitter = (secureRandom() * 2 - 1) * jitterMin * 60000;
    return Math.max(60000, intervalMin * 60000 + jitter);
  }

  status() {
    const accounts = {};
    for (const [id, st] of this._accountLoops) {
      accounts[id] = {
        nextAt: st.nextAt ? new Date(st.nextAt).toISOString() : null,
        lastAt: st.lastAt ? new Date(st.lastAt).toISOString() : null,
        busy: !!st.busy,
      };
    }
    return {
      running: this.running,
      accounts, // 每账号各自的下次/上次时间
      lastResults: this.lastResults,
    };
  }

  start() {
    if (this.running) return { running: true, message: "调度器已在运行" };
    this.running = true;
    this._stopRequested = false;
    const s = getSettings();
    log.info(
      `调度器启动（每账号独立定时）：每 ~${s.intervalMinutes ?? 180} 分钟(±${
        s.jitterMinutes ?? 30
      })，headless=${s.headless ?? true}`
    );
    // 管理循环：定期检查启用账号，为新账号拉起独立循环
    this._manager = this._runManager();
    return { running: true, message: "调度器已启动" };
  }

  async stop() {
    if (!this.running) return { running: false, message: "调度器未运行" };
    this._stopRequested = true;
    log.info("已请求停止调度，各账号本次对话结束后停止…");
    return { running: this.running, message: "已请求停止" };
  }

  // 管理循环：每 15 秒扫描一次启用账号，为尚无循环的账号启动独立定时循环。
  async _runManager() {
    while (!this._stopRequested) {
      const active = getAccounts().filter((a) => a.enabled);
      const activeIds = new Set(active.map((a) => a.id));

      for (const account of active) {
        if (!this._accountLoops.has(account.id)) {
          const state = { nextAt: 0, lastAt: null, busy: false, promise: null };
          this._accountLoops.set(account.id, state);
          state.promise = this._runAccountLoop(account.id);
        }
      }
      // 已停用/删除的账号：从循环表移除，其循环会在下次检查时自然退出
      for (const id of [...this._accountLoops.keys()]) {
        if (!activeIds.has(id)) this._accountLoops.delete(id);
      }

      const until = Date.now() + 15000;
      while (Date.now() < until && !this._stopRequested) await sleep(3000);
    }

    this.running = false;
    this._stopRequested = false;
    log.info("调度器已停止");
  }

  // 单账号独立循环：首次随机延迟错开起跑，之后各自 interval±jitter。
  async _runAccountLoop(accountId) {
    const headless = () => getSettings().headless ?? true;

    // 首次启动加 0~intervalMin 的随机初始延迟，避免所有账号同时起跑。
    const s = getSettings();
    const initDelay = Math.floor(secureRandom() * (s.intervalMinutes ?? 180) * 60000);
    const state = this._accountLoops.get(accountId);
    if (!state) return;
    state.nextAt = Date.now() + initDelay;
    log.info(
      `「${displayName(getAccount(accountId) ?? { id: accountId })}」首次约 ${Math.round(
        initDelay / 60000
      )} 分钟后开始`
    );

    while (!this._stopRequested && this._accountLoops.has(accountId)) {
      // 等到本账号的下次时间（分段睡眠以便响应停止/停用）
      while (
        Date.now() < state.nextAt &&
        !this._stopRequested &&
        this._accountLoops.has(accountId)
      ) {
        await sleep(3000);
      }
      if (this._stopRequested || !this._accountLoops.has(accountId)) break;

      // 账号可能已被停用：跑之前再确认一次
      const acc = getAccount(accountId);
      if (!acc || !acc.enabled) break;

      state.busy = true;
      const res = await runOnce(acc, { headless: headless() });
      recordConversation(accountId, res);
      this.lastResults[accountId] = {
        ok: res.ok,
        reason: res.reason ?? null,
        time: new Date().toISOString(),
      };
      if (!res.ok) log.warn(`「${displayName(acc)}」失败: ${res.reason}`);
      state.busy = false;
      state.lastAt = Date.now();

      // 各自计算下次时间
      const delay = this._nextDelayMs();
      state.nextAt = Date.now() + delay;
      log.info(`「${displayName(acc)}」下次约 ${Math.round(delay / 60000)} 分钟后`);
    }

    this._accountLoops.delete(accountId);
  }
}

export const scheduler = new SchedulerService();
