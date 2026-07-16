import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { runAgent } from "./agent.js";
import { getAccounts, getAccount, getSettings, displayName } from "./store.js";
import { selectSetForAccount, commitWindow } from "./rotation.js";
import { withAccountLock } from "./locks.js";
import { recordConversation } from "./logger.js";
import * as log from "./logger.js";

// 登录判定的真相来源：ChatGPT /api/auth/session 返回带 email 的用户。
async function sessionEmail(page) {
  try {
    const data = await page.evaluate(async () => {
      const res = await fetch("/api/auth/session", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      return res.json();
    });
    return data?.user?.email ?? null;
  } catch {
    return null;
  }
}

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

    const { context, page } = await launchForAccount(account, {
      headless: opts.headless ?? true,
    });
    try {
      await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
      const email = await sessionEmail(page);
      if (!email) return { ok: false, reason: "未登录，请先登录该账号" };
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
