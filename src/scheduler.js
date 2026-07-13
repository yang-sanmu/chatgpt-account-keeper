import { launchForAccount } from "./browser.js";
import { readJson } from "./paths.js";
import { sendPrompt } from "./chat.js";
import { getAccounts, getConversations, getSettings, displayName } from "./store.js";
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

function pickPrompt(set) {
  const prompts = set?.prompts ?? [];
  if (prompts.length === 0) return null;
  if (set.pickStrategy === "sequential") {
    const idx = new Date().getMinutes() % prompts.length;
    return prompts[idx];
  }
  return prompts[Math.floor(secureRandom() * prompts.length)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 让单个账号跑一次预设会话。返回 { ok, prompt, reply, reason }。
 */
export async function runOnce(account, opts = {}) {
  const selectors = readJson("config/selectors.json");
  const sets = getConversations();
  const set = sets[account.conversationSet ?? "default"];
  if (!set) return { ok: false, reason: `会话集不存在: ${account.conversationSet}` };
  const prompt = pickPrompt(set);
  if (!prompt) return { ok: false, reason: "会话集没有可用 prompt" };

  const name = displayName(account);
  // 套账号锁：同一 profile 不能被两个浏览器实例同时打开。
  return withAccountLock(account.id, async () => {
    const { context, page } = await launchForAccount(account, {
      headless: opts.headless ?? true,
    });
    try {
      await page.goto(selectors.url, { waitUntil: "domcontentloaded" });
      const email = await sessionEmail(page);
      if (!email) return { ok: false, prompt, reason: "未登录，请先登录该账号" };
      log.info(`「${name}」发送: ${prompt}`);
      const reply = await sendPrompt(page, selectors, prompt);
      const preview = reply.slice(0, 80).replace(/\s+/g, " ");
      log.info(`「${name}」回复(${reply.length}字): ${preview}…`);
      return { ok: true, prompt, reply };
    } catch (e) {
      return { ok: false, prompt, reason: String(e.message || e) };
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
    this._loop = null;
    this.lastRoundAt = null;
    this.nextRoundAt = null;
    this.lastResults = {}; // accountId -> { ok, reason, time }
    this.busyAccount = null;
  }

  status() {
    return {
      running: this.running,
      lastRoundAt: this.lastRoundAt,
      nextRoundAt: this.nextRoundAt,
      busyAccount: this.busyAccount,
      lastResults: this.lastResults,
    };
  }

  start() {
    if (this.running) return { running: true, message: "调度器已在运行" };
    this.running = true;
    this._stopRequested = false;
    this._loop = this._run();
    return { running: true, message: "调度器已启动" };
  }

  async stop() {
    if (!this.running) return { running: false, message: "调度器未运行" };
    this._stopRequested = true;
    log.info("已请求停止调度，本轮账号结束后停止…");
    return { running: this.running, message: "已请求停止" };
  }

  async _run() {
    const settings = getSettings();
    const intervalMin = settings.intervalMinutes ?? 180;
    const jitterMin = settings.jitterMinutes ?? 30;
    const headless = settings.headless ?? true;
    log.info(`调度器启动：每 ~${intervalMin} 分钟(±${jitterMin})一轮`);

    while (!this._stopRequested) {
      const active = getAccounts().filter((a) => a.enabled);
      this.lastRoundAt = new Date().toISOString();
      log.info(`本轮开始，启用账号 ${active.length} 个`);

      for (const account of active) {
        if (this._stopRequested) break;
        this.busyAccount = account.id;
        const res = await runOnce(account, { headless });
        recordConversation(account.id, res);
        this.lastResults[account.id] = {
          ok: res.ok,
          reason: res.reason ?? null,
          time: new Date().toISOString(),
        };
        if (!res.ok) log.warn(`「${displayName(account)}」失败: ${res.reason}`);
        this.busyAccount = null;
        await sleep(30000 + Math.floor(secureRandom() * 60000));
      }

      if (this._stopRequested) break;
      const jitter = Math.floor((secureRandom() * 2 - 1) * jitterMin * 60000);
      const waitMs = Math.max(60000, intervalMin * 60000 + jitter);
      this.nextRoundAt = new Date(Date.now() + waitMs).toISOString();
      log.info(`本轮结束，下轮约 ${Math.round(waitMs / 60000)} 分钟后`);

      // 分段睡眠，便于及时响应停止请求
      const until = Date.now() + waitMs;
      while (Date.now() < until && !this._stopRequested) {
        await sleep(3000);
      }
    }

    this.running = false;
    this._stopRequested = false;
    this.nextRoundAt = null;
    log.info("调度器已停止");
  }
}

export const scheduler = new SchedulerService();
