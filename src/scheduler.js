import { launchForAccount } from "./browser.js";
import { readResourceJson } from "./paths.js";
import { runAgent } from "./agent.js";
import { getAccounts, getAccount, getSettings, displayName } from "./store.js";
import { selectSetForAccount, commitWindow } from "./rotation.js";
import { withAccountLock } from "./locks.js";
import { recordConversation } from "./logger.js";
import { checkSession, SESSION_OK, SESSION_REAUTH, SESSION_UNKNOWN } from "./health.js";
import { setCachedStatus } from "./statusMonitor.js";
import {
  PROBE_DEPTH_CONVERSATION,
  PROBE_DEPTH_PAGE,
  probeSelectors,
  summarizeSelectorReport,
  validateSelectorConfig,
} from "./selectorCheck.js";
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
 * 启动并使用一次浏览器，确保启动、运行和关闭三个阶段互不掩盖结果。
 *
 * 启动/运行失败统一转换为 runOnce 的失败结果；关闭失败只记录告警，
 * 不能把已经得到的成功或主错误覆盖掉。
 */
export async function runWithBrowserLifecycle(
  launch,
  operation,
  options = {}
) {
  let context;
  try {
    const launched = await launch();
    context = launched.context;
    return await operation(launched);
  } catch (error) {
    return {
      ok: false,
      reason: String(error?.message || error),
      ...(error?.code ? { code: String(error.code) } : {}),
    };
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (closeError) {
        const reportCloseError =
          options.reportCloseError ??
          ((error) =>
            log.warn(
              `${options.label ?? "浏览器"}关闭失败：${String(
                error?.message || error
              )}`
            ));
        // 告警代码本身也不能反过来覆盖主结果。
        try {
          reportCloseError(closeError);
        } catch {
          // 忽略自定义告警处理器异常
        }
      }
    }
  }
}

/**
 * 让单个账号跑一次 agent 多轮对话。返回 { ok, topic, threads, totalRounds, reason }。
 */
export async function runOnce(account, opts = {}) {
  // 与登录/打开网页共用同一个解析顺序：数据目录的用户覆盖优先，
  // 否则用安装目录里随版本分发的默认值。
  const selectors = readResourceJson("config/selectors.json");
  const name = displayName(account);

  const runWithPage = async ({ page, set, setName }) => {
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
  };

  const pickSet = (fresh) => selectSetForAccount(fresh);
  const noSet = { ok: false, reason: "没有可用的会话集主题，请先在“会话内容”里配置" };

  // 队列路径：账号锁、Chrome 与关闭都由 BrowserRun 持有，这里只跑业务。自己再套一层
  // withAccountLock 会与队列已持有的同一把锁自锁，再 launch 则绕过登记的 runToken。
  if (opts.page) {
    const fresh = getAccount(account.id) ?? account;
    const picked = pickSet(fresh);
    if (!picked) return noSet;
    return runWithPage({ page: opts.page, set: picked.set, setName: picked.setName });
  }

  // 套账号锁：同一 profile 不能被两个浏览器实例同时打开。
  // 主题选择与窗口计数都放在锁内，避免并发触发时轮换状态读-改-写竞态。
  return withAccountLock(account.id, async () => {
    // 用锁内最新账号数据选主题（切换时已持久化新状态）。
    const fresh = getAccount(account.id) ?? account;
    const picked = pickSet(fresh);
    if (!picked) return noSet;

    return runWithBrowserLifecycle(
      () =>
        launchForAccount(fresh, {
          headless: opts.headless ?? true,
          runToken: opts.runToken,
        }),
      ({ page }) => runWithPage({ page, set: picked.set, setName: picked.setName }),
      { label: `「${name}」浏览器` }
    );
  });
}

/**
 * 用某个账号跑一次选择器自检。
 *
 * 复用 runOnce 的全套前置条件（账号锁、浏览器生命周期、会话健康检查），因为
 * 选择器只有在已登录的新对话页上才能验证——未登录页面上一切都"找不到"，那样的
 * 报告会把登录问题误报成官网改版。
 *
 * depth 为 "conversation" 时会在账号里真发一条 "hello"，用来验证停止按钮和回复
 * 正文两组；默认的 "page" 深度只读探测，不留下任何对话。
 */
export async function checkSelectors(account, opts = {}) {
  const selectors = readResourceJson("config/selectors.json");
  const name = displayName(account);
  const depth = opts.depth === PROBE_DEPTH_CONVERSATION
    ? PROBE_DEPTH_CONVERSATION
    : PROBE_DEPTH_PAGE;
  const config = validateSelectorConfig(selectors);
  // 选择器组自身的问题由 probeSelectors 按“致命/可降级”分级；只有页面地址或
  // 整份配置的结构坏掉时才不能启动浏览器，需在导航前直接返回。
  const criticalConfigProblems = config.problems.filter(
    (problem) => problem.key == null || problem.key === "url" || problem.key === "newChatUrl"
  );
  if (criticalConfigProblems.length > 0) {
    const report = {
      ok: false,
      depth,
      groups: [],
      failedKeys: [],
      degradedKeys: [],
      fallbackKeys: [],
      configProblems: criticalConfigProblems,
    };
    return {
      ...report,
      summary: summarizeSelectorReport(report),
      accountId: account.id,
    };
  }
  const probeWithPage = async ({ page, fresh }) => {
        await page.goto(selectors.newChatUrl || selectors.url, {
          waitUntil: "domcontentloaded",
        });
        // 未登录时页面上什么都找不到，报告会把登录问题说成选择器失效。
        const health = await checkSession(page);
        setCachedStatus(fresh.id, health.state, health.email, health.detail);
        if (health.state === SESSION_REAUTH) {
          return {
            ok: false,
            reason: `会话已失效（${health.detail ?? "需重新登录"}），无法检查选择器`,
            needReauth: true,
          };
        }
        if (health.state !== SESSION_OK && health.state !== SESSION_UNKNOWN) {
          return { ok: false, reason: "未登录，请先登录该账号后再检查选择器" };
        }
        if (health.state === SESSION_UNKNOWN) {
          return {
            ok: false,
            reason: `会话状态无法确认（${health.detail ?? "网络或验证页面异常"}），为避免误报选择器漂移，本次未执行自检`,
          };
        }
        const report = await probeSelectors(page, selectors, { depth });
        const summary = summarizeSelectorReport(report);
        log[report.ok ? "info" : "warn"](`「${name}」选择器自检：${summary}`);
        return { ...report, summary, accountId: fresh.id };
  };

  // 队列路径：锁与 Chrome 归 BrowserRun，这里只探测。
  if (opts.page) {
    return probeWithPage({ page: opts.page, fresh: getAccount(account.id) ?? account });
  }

  return withAccountLock(account.id, async () => {
    const fresh = getAccount(account.id) ?? account;
    return runWithBrowserLifecycle(
      () => launchForAccount(fresh, {
        headless: opts.headless ?? true,
        runToken: opts.runToken,
      }),
      ({ page }) => probeWithPage({ page, fresh }),
      { label: `「${name}」选择器自检` }
    );
  });
}

/**
 * 调度器服务：单例，可被 API 启停并查询状态。
 */
export class SchedulerService {
  constructor(runtime = {}) {
    this.running = false;
    this._stopRequested = false;
    this._runOnce = runtime.runOnce ?? runOnce;
    this._getAccount = runtime.getAccount ?? getAccount;
    this._getAccounts = runtime.getAccounts ?? getAccounts;
    this._getSettings = runtime.getSettings ?? getSettings;
    this._recordConversation = runtime.recordConversation ?? recordConversation;
    this._sleep = runtime.sleep ?? sleep;
    this._secureRandom = runtime.secureRandom ?? secureRandom;
    this._log = runtime.log ?? log;
    this._persistence = runtime.persistence ?? null;
    // 配置后由 ScheduleClock 承担计时；本类不再自己跑账号循环。
    this._clock = runtime.clock ?? null;
    this._onSchedulerEpoch = null;
    // 每账号一条独立循环：accountId -> { nextAt, lastAt, busy, promise }
    this._accountLoops = new Map();
    this.lastResults = {}; // accountId -> { ok, reason, time }
    this._observers = new Set();
  }

  configurePersistence(persistence) {
    if (persistence != null && typeof persistence !== "object") {
      throw new TypeError("scheduler persistence must be an object or null");
    }
    this._persistence = persistence;
    return this;
  }

  /**
   * 交出计时职责给统一队列的 ScheduleClock。
   *
   * 配置后 start/stop 只驱动这一个时钟，不再拉起每账号循环——两套计时器同时跑会让
   * 每个启用账号在一个间隔内被触发两次，真跑两轮对话。IPC 的 start/stop/getState
   * 与 running/enabled 持久化语义完全不变，本类仍是它们的载体。
   */
  configureClock(clock, onSchedulerEpoch = null) {
    if (clock != null && typeof clock !== "object") {
      throw new TypeError("scheduler clock must be an object or null");
    }
    this._clock = clock;
    this._onSchedulerEpoch = onSchedulerEpoch;
    return this;
  }

  /**
   * 订阅调度变化。Agent 用它把每账号的 nextAt/lastAt/结果推给管理端，
   * 否则“下次运行时间”和“刚跑完的结果”只能靠客户端定时全量拉取。
   */
  subscribe(observer) {
    if (typeof observer !== "function") {
      throw new TypeError("scheduler observer must be a function");
    }
    this._observers.add(observer);
    return () => this._observers.delete(observer);
  }

  _notify(change) {
    for (const observer of this._observers) {
      try {
        observer(change);
      } catch (error) {
        // 观察者异常不能影响调度本身。
        try {
          this._log.warn(`调度事件订阅者异常：${String(error?.message || error)}`);
        } catch {
          // 日志失败也不再向外抛
        }
      }
    }
  }

  /**
   * 普通启停时 running 与持久化的 enabled 必须一起改：早先 start() 先写 enabled=true，
   * 管理循环稍后失败才写回 false，中间被杀进程会留下 enabled=true 但没在跑的
   * 假状态，重启后界面显示“运行中”而实际停止。
   */
  _setRunning(running) {
    const next = !!running;
    const changed = this.running !== next;
    this.running = next;
    try {
      this._persistence?.setEnabled?.(next);
    } catch (error) {
      this._log.warn(`保存调度开关失败：${String(error?.message || error)}`);
    }
    if (changed) this._notify({ kind: "scheduler", running: next });
    return next;
  }

  _persistentSnapshot() {
    try {
      return this._persistence?.load?.() ?? { enabled: false, accounts: {} };
    } catch (error) {
      this._log.warn(`读取持久化调度状态失败：${String(error?.message || error)}`);
      return { enabled: false, accounts: {} };
    }
  }

  _persistAccount(accountId, state) {
    const snapshot = {
      nextAt: state.nextAt ? new Date(state.nextAt).toISOString() : null,
      lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
      lastResultState: this.lastResults[accountId]?.ok === true
        ? "succeeded"
        : this.lastResults[accountId]?.ok === false
          ? "failed"
          : null,
      lastResult: this.lastResults[accountId] ?? null,
    };
    try {
      this._persistence?.saveAccount?.(accountId, snapshot);
    } catch (error) {
      this._log.warn(`保存账号 ${accountId} 调度状态失败：${String(error?.message || error)}`);
    }
    this._notify({
      kind: "account",
      accountId,
      ...snapshot,
      busy: !!state.busy,
    });
  }

  /**
   * 下一次到期时刻。ScheduleClock 排期必须走这里，而不是自己按固定 interval 算：
   * interval±jitter 的作用是让一批账号不在同一时刻集体启动 Chrome，复制一份或退化成
   * 固定间隔都会把这个性质丢掉。随机算法只有 _nextDelayMs 一处实现。
   */
  nextAtFromNow(now = Date.now()) {
    return now + this._nextDelayMs();
  }

  /**
   * ScheduleClock 排下一次时用。
   *
   * 接入统一队列后 _runAccountLoop 不再运行，而它是原先**唯一**写 nextAt / lastAt /
   * lastResult 的地方。不补这两个入口，排期表就再也不更新：账号页的「下次运行时间」
   * 永久停在旧值，而 restoreSchedule 每次重启都会拿同一张过期表判所有账号逾期，
   * 于是反复补跑。
   */
  noteScheduled(accountId, { nextAt } = {}) {
    const persisted = this._persistentSnapshot().accounts?.[accountId] ?? null;
    if (persisted?.lastResult && typeof persisted.lastResult === "object") {
      this.lastResults[accountId] ??= { ...persisted.lastResult };
    }
    // lastAt 属于上一轮，排下一次时必须原样带上，否则会被覆盖成 null。
    this._persistAccount(accountId, {
      nextAt: nextAt ?? null,
      lastAt: persisted?.lastAt ? Date.parse(persisted.lastAt) || null : null,
      busy: false,
    });
    return this;
  }

  /**
   * 队列终态回调用：写下这一轮真实跑完的时间与结果。
   *
   * nextAt 可选：给了就和结果一次写完（§6.5 的"跑完后只算一个新的未来时间"），
   * 不给则保持持久化里的原值不动。
   */
  noteCompleted(accountId, { lastAt, result, nextAt } = {}) {
    const persisted = this._persistentSnapshot().accounts?.[accountId] ?? null;
    if (result && typeof result === "object") {
      this.lastResults[accountId] = {
        ok: !!result.ok,
        reason: result.reason ?? null,
        time: new Date(lastAt ?? Date.now()).toISOString(),
      };
    }
    this._persistAccount(accountId, {
      nextAt: nextAt ?? (persisted?.nextAt ? Date.parse(persisted.nextAt) || null : null),
      lastAt: lastAt ?? Date.now(),
      busy: false,
    });
    return this;
  }

  // 计算一次间隔：interval ± jitter（分钟）转毫秒，下限 1 分钟。
  _nextDelayMs() {
    const s = this._getSettings();
    const intervalMin = s.intervalMinutes ?? 180;
    const jitterMin = s.jitterMinutes ?? 30;
    const jitter = (this._secureRandom() * 2 - 1) * jitterMin * 60000;
    return Math.max(60000, intervalMin * 60000 + jitter);
  }

  status() {
    // 即使调度器当前没有运行，也要把已经落库的“上次运行”带给桌面端。
    // 过去只有 _runAccountLoop 启动后才恢复 lastResults，导致用户停止调度或
    // 重启应用后，账号页把真实的“上次失败”错误显示成“尚未运行”。
    const persisted = this._persistentSnapshot();
    const persistedAccounts = persisted?.accounts && typeof persisted.accounts === "object"
      ? persisted.accounts
      : {};
    const accounts = {};
    const lastResults = {};
    for (const [id, state] of Object.entries(persistedAccounts)) {
      accounts[id] = {
        nextAt: state?.nextAt ?? null,
        lastAt: state?.lastAt ?? null,
        busy: false,
      };
      if (state?.lastResult && typeof state.lastResult === "object") {
        lastResults[id] = { ...state.lastResult };
      }
    }
    for (const [id, st] of this._accountLoops) {
      accounts[id] = {
        nextAt: st.nextAt ? new Date(st.nextAt).toISOString() : null,
        lastAt: st.lastAt ? new Date(st.lastAt).toISOString() : null,
        busy: !!st.busy,
      };
    }
    return {
      running: this.running,
      enabled: persisted.enabled === true,
      accounts, // 每账号各自的下次/上次时间
      lastResults: { ...lastResults, ...this.lastResults },
    };
  }

  start() {
    if (this.running) return { running: true, message: "调度器已在运行" };
    this._stopRequested = false;
    this._setRunning(true);
    const s = this._getSettings();
    this._log.info(
      `调度器启动（每账号独立定时）：每 ~${s.intervalMinutes ?? 180} 分钟(±${
        s.jitterMinutes ?? 30
      })，headless=${s.headless ?? true}`
    );
    // 接入统一队列后计时只剩 ScheduleClock 一套；绝不能同时再拉起账号循环。
    if (this._clock) {
      this._clock.start();
      // 排队条目按入队时的 schedulerEpoch 快照运行：不 bump 的话 stop 之后再 start
      // 期间入队的 scheduled 条目无法被区分与复验。
      this._onSchedulerEpoch?.();
      return { running: true, message: "调度器已启动" };
    }
    // 管理循环：定期检查启用账号，为新账号拉起独立循环
    // 后台 manager 也必须有最终拒绝处理；否则配置文件被外部改坏或未来
    // 依赖抛错时，会留下 running=true 的假状态并触发 unhandled rejection。
    const managed = this._runManager().catch((error) => {
      try {
        this._log.error(
          `调度管理循环异常退出：${String(error?.message || error)}`
        );
      } catch {
        // 日志失败不能制造第二个未处理拒绝
      }
      if (this._manager === managed) {
        this._stopRequested = true;
        this._setRunning(false);
      }
    });
    this._manager = managed;
    return { running: true, message: "调度器已启动" };
  }

  async stop() {
    if (!this.running) {
      this._setRunning(false);
      return { running: false, message: "调度器未运行" };
    }
    this._stopRequested = true;
    this._setRunning(false);
    this._log.info("已请求停止调度，各账号本次对话结束后停止…");
    // 时钟只停止后续触发；已排队的 scheduled 条目由 epoch 复验负责取消。
    this._clock?.stop?.();
    this._onSchedulerEpoch?.();
    // running 已置 false，但账号循环还在收尾；status() 用 running 反映用户意图。
    return { running: false, message: "已请求停止" };
  }

  async drain({ timeoutMs = 0, preserveEnabled = false } = {}) {
    const shouldRestoreEnabled = preserveEnabled && this._persistentSnapshot().enabled === true;
    await this.stop();
    const restoreEnabled = () => {
      if (!shouldRestoreEnabled) return;
      try {
        this._persistence?.setEnabled?.(true);
      } catch (error) {
        this._log.warn(`保存调度开关失败：${String(error?.message || error)}`);
      }
    };
    const manager = this._manager;
    const work = [
      ...(manager ? [manager] : []),
      ...[...this._accountLoops.values()]
        .map((state) => state.promise)
        .filter(Boolean),
    ];
    if (!work.length) {
      this.running = false;
      // 更新重启后要自动恢复调度：停机是为了装新版本，不是用户关掉了调度。
      restoreEnabled();
      return { running: false, drained: true };
    }

    const settled = Promise.allSettled(work);
    if (timeoutMs > 0) {
      let timeout;
      try {
        const result = await Promise.race([
          settled.then(() => true),
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        if (!result) return { running: this.running, drained: false };
      } finally {
        clearTimeout(timeout);
      }
    } else {
      await settled;
    }
    // manager 的 finally 会写回 enabled=false，必须等它彻底结束后再恢复用户原来的开关。
    restoreEnabled();
    return { running: this.running, drained: true };
  }

  // 管理循环：每 15 秒扫描一次启用账号，为尚无循环的账号启动独立定时循环。
  async _runManager() {
    while (!this._stopRequested) {
      const active = this._getAccounts().filter((a) => a.enabled);
      const activeIds = new Set(active.map((a) => a.id));

      for (const account of active) {
        if (!this._accountLoops.has(account.id)) {
          const state = { nextAt: 0, lastAt: null, busy: false, promise: null };
          this._accountLoops.set(account.id, state);
          // _runAccountLoop 自身会兜住错误；这里再加最后一道 rejection handler，
          // 避免未来改动意外让后台 Promise 变成未处理拒绝。
          state.promise = this._runAccountLoop(account.id).catch((error) => {
            try {
              this._log.error(
                `账号 ${account.id} 调度循环异常退出：${String(
                  error?.message || error
                )}`
              );
            } catch {
              // 日志失败也不能制造新的未处理拒绝
            }
            if (this._accountLoops.get(account.id) === state) {
              this._accountLoops.delete(account.id);
            }
          });
        }
      }
      // 已停用/删除的账号：从循环表移除，其循环会在下次检查时自然退出
      for (const id of [...this._accountLoops.keys()]) {
        if (!activeIds.has(id)) this._accountLoops.delete(id);
      }

      const until = Date.now() + 15000;
      while (Date.now() < until && !this._stopRequested) await this._sleep(3000);
    }

    // stop() 已经把 running/enabled 一起落下；这里只在管理循环自行退出
    // （例如全部账号被停用）时补齐状态并通知一次。
    this._setRunning(false);
    this._stopRequested = false;
    this._log.info("调度器已停止");
  }

  // 单账号独立循环：首次随机延迟错开起跑，之后各自 interval±jitter。
  async _runAccountLoop(accountId) {
    const state = this._accountLoops.get(accountId);
    if (!state) return;
    try {
      const headless = () => this._getSettings().headless ?? true;

      // 更新/重启后恢复原 nextAt；已错过的任务只补跑一次，并加最多 5 分钟
      // 的抖动，避免一批账号在 Agent 恢复时同时启动 Chrome。
      const s = this._getSettings();
      const persisted = this._persistentSnapshot().accounts?.[accountId] ?? null;
      if (persisted?.lastResult && typeof persisted.lastResult === "object") {
        this.lastResults[accountId] = { ...persisted.lastResult };
      }
      const persistedNextAt = persisted?.nextAt ? Date.parse(persisted.nextAt) : NaN;
      const initDelay = Number.isFinite(persistedNextAt)
        ? persistedNextAt > Date.now()
          ? persistedNextAt - Date.now()
          : Math.floor(this._secureRandom() * Math.min(5, s.intervalMinutes ?? 180) * 60000)
        : Math.floor(this._secureRandom() * (s.intervalMinutes ?? 180) * 60000);
      state.nextAt = Date.now() + initDelay;
      state.lastAt = persisted?.lastAt ? Date.parse(persisted.lastAt) || null : null;
      this._persistAccount(accountId, state);
      this._log.info(
        `「${displayName(this._getAccount(accountId) ?? { id: accountId })}」首次约 ${Math.round(
          initDelay / 60000
        )} 分钟后开始`
      );

      while (
        !this._stopRequested &&
        this._accountLoops.get(accountId) === state
      ) {
        // 等到本账号的下次时间（分段睡眠以便响应停止/停用）
        while (
          Date.now() < state.nextAt &&
          !this._stopRequested &&
          this._accountLoops.get(accountId) === state
        ) {
          await this._sleep(3000);
        }
        if (
          this._stopRequested ||
          this._accountLoops.get(accountId) !== state
        ) {
          break;
        }

        // 账号可能已被停用：跑之前再确认一次
        const acc = this._getAccount(accountId);
        if (!acc || !acc.enabled) break;

        state.busy = true;
        let res;
        try {
          res = await this._runOnce(acc, { headless: headless() });
          if (!res || typeof res !== "object") {
            res = { ok: false, reason: "运行未返回有效结果" };
          }
        } catch (error) {
          res = {
            ok: false,
            reason: `运行异常：${String(error?.message || error)}`,
            ...(error?.code ? { code: String(error.code) } : {}),
          };
        } finally {
          state.busy = false;
          state.lastAt = Date.now();
        }

        try {
          this._recordConversation(accountId, res);
        } catch (error) {
          this._log.warn(
            `「${displayName(acc)}」写入运行记录失败：${String(
              error?.message || error
            )}`
          );
        }
        this.lastResults[accountId] = {
          ok: !!res.ok,
          reason: res.reason ?? null,
          time: new Date().toISOString(),
        };
        if (!res.ok) this._log.warn(`「${displayName(acc)}」失败: ${res.reason}`);

        // 即使本轮抛错，也要为下一轮留下完整调度状态。
        const delay = this._nextDelayMs();
        state.nextAt = Date.now() + delay;
        this._persistAccount(accountId, state);
        this._log.info(
          `「${displayName(acc)}」下次约 ${Math.round(delay / 60000)} 分钟后`
        );
      }
    } catch (error) {
      // 后台循环绝不能把拒绝泄露成 unhandled rejection。
      try {
        this._log.error(
          `账号 ${accountId} 调度循环异常退出：${String(
            error?.message || error
          )}`
        );
      } catch {
        // 日志失败不再向外抛
      }
    } finally {
      state.busy = false;
      // 只删除自己的状态，避免误删停用后又重新启用所创建的新循环。
      if (this._accountLoops.get(accountId) === state) {
        this._accountLoops.delete(accountId);
      }
    }
  }
}

export const scheduler = new SchedulerService();
