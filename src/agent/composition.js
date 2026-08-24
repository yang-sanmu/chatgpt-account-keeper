import { BackgroundQueue, SOURCES, WORK_KINDS } from "../application/backgroundQueue.js";
import { BrowserRunRegistry, purposeFor } from "../application/browserRuns.js";
import { SlotManager } from "../application/resourceSlots.js";
import { ChromeLauncherBroker, ChromeBrokerUnavailableError } from "../chromeLauncherBroker.js";
import { ChromeProcessLauncher } from "../chromeProcessLauncher.js";
import { configureChromeLauncher } from "../browser.js";
import { launchForAccount } from "../browser.js";
import { normalizeApplicationError } from "../application/errors.js";
import { publicAccount, publicStatus } from "../application/services.js";
import { ScheduleClock, planOverdueRecovery } from "../scheduleClock.js";
import { STAGES } from "../application/backgroundQueue.js";
import { isQuarantined, release as releaseAccountLock } from "../locks.js";

/**
 * Agent 组合根（计划 §2）。
 *
 * 这里是唯一知道「队列 + 浏览器启动器 + BrowserRun 注册表 + 调度时钟」如何互相
 * 连接的地方。队列本身只依赖 locks / operations / events，不 import scheduler、
 * statusMonitor 或 browser——否则会形成
 * services → scheduler → statusMonitor → loginProvider → browser 的环。
 */

export async function composeBackground({
  operations,
  events,
  store,
  log,
  runOnce,
  checkSelectors,
  refreshAccount,
  statusMonitor,
  scheduler,
  // 代理节点表由组合根注入。这里不能 import proxyManager：它 import store，而
  // composition 位于两者之下，直连会把依赖拧成环（见文件头）。
  getProxyNodes,
  onFatal,
  requireBroker = process.platform === "win32",
  brokerFactory = (options) => new ChromeLauncherBroker(options),
  // 测试替身用；生产恒为 browser.js 的 launchForAccount。
  launchChrome = launchForAccount,
  // 原服务层后处理所需：写历史，以及构造两个事件的公开 payload。后者是个取值函数：
  // 服务 runtime 在组合完成之后才存在。
  recordConversation = null,
  accountViewRuntime = null,
}) {
  // 缺省不给 []：那正是「所有绑定了分组代理的账号一律被判为节点不可用」的成因，
  // 而且它静默——每个账号各自失败，没有任何一处报错。必须在启动时就炸。
  if (typeof getProxyNodes !== "function") {
    throw new TypeError("getProxyNodes provider is required");
  }
  // 调度状态的读写都经 scheduler。缺任何一个就退回固定间隔或静默丢弃写入，
  // 那正是这两轮修的东西——宁可在 Agent 接受 IPC 之前就失败。
  for (const method of ["nextAtFromNow", "noteScheduled", "noteCompleted"]) {
    if (typeof scheduler?.[method] !== "function") {
      throw new TypeError(`scheduler.${method} is required`);
    }
  }

  /**
   * 节点表的唯一读取口。返回值每次都验：provider 是动态的，第一次对不代表之后对。
   */
  const readProxyNodes = () => {
    const nodes = getProxyNodes();
    if (!Array.isArray(nodes)) {
      throw new TypeError("getProxyNodes must return an array");
    }
    return nodes;
  };
  // compose 时先验一次：否则坏 provider 要等到第一条 proxied 任务才炸，而那时
  // submit 已经 declare 了 Operation，会留下半入队状态。
  readProxyNodes();

  const slots = new SlotManager();
  const queue = new BackgroundQueue({ operations, events, slots, log });

  let broker = null;
  let launcher = null;
  if (requireBroker) {
    // Windows：broker 是硬依赖。可执行文件缺失 / EACCES / spawn 失败 / 握手超时或
    // 不匹配都必须让 Agent 在接受 IPC 之前 fail-closed，不能退化成每个账号各自失败。
    broker = brokerFactory({ log, onFatal });
    await broker.start();
    launcher = new ChromeProcessLauncher({ broker, log });
    configureChromeLauncher(launcher);
  }

  const snapshot = () => {
    const queueSnapshot = queue.snapshot();
    return {
      ...queueSnapshot,
      chromeSlots: {
        ...queueSnapshot.chromeSlots,
        // Chrome 容量占用含 close_failed 的僵尸与长期页面。
        used: Math.max(queueSnapshot.chromeSlots.used, browserRuns.chromeOccupancy),
      },
      browserRuns: {
        active: browserRuns.listActive().length,
        byPurpose: browserRuns.countByPurpose(),
      },
      broker: broker
        ? { running: broker.running, generationId: broker.generationId }
        : null,
    };
  };

  const publishQueue = () => {
    events?.publish("queue.changed", snapshot());
  };

  const browserRuns = new BrowserRunRegistry({
    events,
    broker,
    log,
    // quarantine 变化会改变 Chrome 容量与 blocker，快照必须跟着推。
    onQuarantineChanged: () => publishQueue(),
  });

  // 语义复验：逐条按任务语义判定，计数器只是触发器。
  queue.configureRevalidate(({ accountId }) => {
    const account = store.getAccount(accountId);
    // 账号停用/删除不是"这一轮自动运行失败"，而是这个账号不再参与调度：写进
    // lastResult 会把账号页的「上次运行」污染成一条用户从未发起的失败。
    if (!account || account.enabled === false) {
      return { ok: false, reason: "账号已删除或已停用" };
    }
    if (isQuarantined(accountId)) {
      return { ok: false, reason: "该账号的 Chrome 未能回收，已隔离", settlesRun: true };
    }
    const proxyId = store.effectiveProxyId?.(account) ?? null;
    if (proxyId) {
      // 只认注入的这一个来源。留 store.getProxyNodes?.() 兜底等于把同一个陷阱
      // 重新装上：store 从来没有这个导出，可选调用会静默退化成空表。
      const node = readProxyNodes().find((candidate) => candidate.id === proxyId);
      if (!node || node.missing || node.enabled === false) {
        // 健康校验失败：这算一次真实的自动运行结果，要落到调度状态里。
        return { ok: false, reason: "分组绑定的代理节点不可用", settlesRun: true };
      }
    }
    return { ok: true };
  });
  queue.configureSchedulerRunning(() => scheduler?.running !== false);

  // 提升必须同步已创建的 BrowserRun 的 effectiveSource 与派生 purpose，否则同一件事
  // 在队列与 UI 上会有两个答案。
  queue.onPromoted((entry) => {
    if (!entry.browserRunId) return;
    browserRuns.updateEffectiveSource(entry.browserRunId, entry.effectiveSource);
  });

  /**
   * 后台执行体的公共骨架：取 Chrome 槽 → 启动错峰 → 登记 BrowserRun → 跑业务 →
   * 关闭并等完整 owned 树确认消失。
   */
  const withBrowserRun = async (context, body) => {
    const { entry, signal, setStage, attachBrowserRun, attachClose, accountLockHandle } = context;
    setStage(STAGES.waitingChrome, "等待 Chrome 槽");
    const chromeSlot = await slots.acquireChromeSlot({
      interactive: false,
      signal,
      label: entry.accountId,
    });
    let run = null;
    let value = null;
    let closeOutcome = null;
    try {
      await slots.awaitLaunchPermit(signal);
      setStage(STAGES.launching, "正在启动 Chrome");
      run = browserRuns.register({
        accountId: entry.accountId,
        operationId: entry.operationId,
        workKind: entry.workKind,
        effectiveSource: entry.effectiveSource,
        purpose: purposeFor(entry.workKind, entry.effectiveSource),
        accountLockHandle,
        chromeSlot,
        workSlot: entry.workSlot,
      });
      attachBrowserRun(run.browserRunId);
      // 资源所有权已交给 BrowserRun：由 closed / close_failed 分支释放。
      entry.workSlot = null;
      entry.accountLockHandle = null;

      // 唯一的 runToken：先登记到 BrowserRun，再用它启动。业务函数不再自己 launch，
      // 所以整条链上只存在这一个 token，关闭序列 dispose 的就是真实启动过的那个。
      const runToken = launcher ? launcher.newRunToken() : null;
      const account = store.getAccount(entry.accountId);
      if (!account) throw new Error("账号已删除");
      // token 必须在发出 launch **之前**就登记：broker 一旦可能建了 Job，BrowserRun
      // 就得知道该用哪个 token 去证明回收。等成功后再登记的话，启动失败时 run 的
      // token 为空，关闭序列会按 never-launched 直接释放槽与锁并放走残留。
      if (runToken) {
        browserRuns.attachLaunch(run.browserRunId, { launcherRunToken: runToken });
      }
      let launched;
      try {
        launched = await launchChrome(account, {
          headless: store.getSettings().headless,
          runToken,
          signal,
        });
      } catch (error) {
        // 只有"明确未创建"才能撤回 token 让关闭走 never-launched 快路径；结果不确定
        // 时必须留着它，由关闭序列去证明，证明不了就 quarantine。
        if (error?.ownershipCertain === true) {
          browserRuns.forgetLauncherToken(run.browserRunId);
        }
        throw error;
      }
      browserRuns.attachLaunch(run.browserRunId, {
        rootPid: launched?.rootPid ?? null,
        rootStartTime: launched?.rootStartTime ?? null,
        launcherRunToken: launched?.runToken ?? runToken,
        brokerGenerationId: broker?.generationId ?? null,
        state: "running",
      });
      // context 交给 BrowserRun：关闭序列的优雅退出阶段要用它，业务体不得自行关闭。
      browserRuns.markRunning(run.browserRunId, launched?.context ?? null);
      setStage(STAGES.running, "正在执行");
      value = await body({ run, signal, page: launched.page, account });
      // 不在这里 return：close 的结论要合进结果，而 finally 在 return 之后才跑。
    } finally {
      if (run) {
        setStage(STAGES.closing, "正在关闭 Chrome");
        // 关闭序列自带 5 秒总预算；资源只在完整树被证明消失后释放。
        const closed = await browserRuns.close(run.browserRunId, "task-complete");
        // §5.5：已创建 BrowserRun 的 Operation 终态必须带 close.ok 布尔值。
        // close.ok === false 表示 Chrome 未能回收，任何一侧都不得解释为资源已释放。
        closeOutcome = {
          ok: closed?.state === "closed",
          reason: closed?.closeReason ?? null,
          error: closed?.closeError ?? null,
          browserRunId: run.browserRunId,
        };
        attachClose?.(closeOutcome);
      } else {
        chromeSlot.release();
      }
    }
    // 业务成功但 Chrome 未能回收时，结果里必须同时带着这两件事。
    return closeOutcome ? { ...(value ?? {}), close: closeOutcome } : value;
  };

  /**
   * 交互式（登录 / 打开网页）的 Chrome 获取。
   *
   * 与后台的区别只有两点：Chrome 槽走 interactive 高优先级队列，账号锁由既有的
   * withAccountLock 持有而不是队列的 try-lock。相同的部分是关键：同一个 BrowserRun
   * 登记、同一个 runToken、同一条关闭序列——否则这两条路创建的 Chrome 不在容量
   * 里、不在明细里，也没人 dispose 它们的 Job。
   *
   * autoClose=false 时（打开网页）返回 release：run 一直持有到用户关窗才收口。
   */
  const acquireInteractiveChrome = async ({
    accountId,
    account,
    purpose,
    operationId = null,
    headless = false,
    signal = null,
    launchOptions = {},
  }) => {
    const chromeSlot = await slots.acquireChromeSlot({
      interactive: true,
      signal,
      label: accountId,
    });
    let run = null;
    try {
      await slots.awaitLaunchPermit(signal);
      run = browserRuns.register({
        accountId,
        operationId,
        effectiveSource: "manual",
        purpose,
        chromeSlot,
        headless,
      });
      const runToken = launcher ? launcher.newRunToken() : null;
      // 同后台路径：登记先于 launch，启动失败才有据可查。
      if (runToken) {
        browserRuns.attachLaunch(run.browserRunId, { launcherRunToken: runToken });
      }
      let launched;
      try {
        launched = await launchChrome(account, {
          ...launchOptions,
          headless,
          runToken,
          signal,
        });
      } catch (error) {
        if (error?.ownershipCertain === true) {
          browserRuns.forgetLauncherToken(run.browserRunId);
        }
        throw error;
      }
      browserRuns.attachLaunch(run.browserRunId, {
        rootPid: launched?.rootPid ?? null,
        rootStartTime: launched?.rootStartTime ?? null,
        launcherRunToken: launched?.runToken ?? runToken,
        brokerGenerationId: broker?.generationId ?? null,
        state: "running",
      });
      browserRuns.markRunning(run.browserRunId, launched?.context ?? null);
      return {
        context: launched.context,
        page: launched.page,
        browserRunId: run.browserRunId,
        // 收口只经 BrowserRun：直接 context.close() 会留下无人 dispose 的 Job。
        release: (reason = "user-closed") => browserRuns.close(run.browserRunId, reason),
      };
    } catch (error) {
      if (run) await browserRuns.close(run.browserRunId, "launch-failed");
      else chromeSlot.release();
      throw error;
    }
  };

  /**
   * 业务约定是返回 {ok:false, reason} 而不抛错，而队列只把抛错记为 failed。不做这层
   * 映射，失败的自动对话会在任务页显示成成功。
   */
  const failIfNotOk = (result, fallbackMessage) => {
    if (result?.ok !== false) return result;
    const error = normalizeApplicationError(
      Object.assign(new Error(result.reason || result.summary || fallbackMessage), {
        code: result.code,
      })
    );
    // 已得到的结果与 close 结论都要留在 Operation 上，否则失败原因和"Chrome 是否
    // 已回收"这两件事在 UI 上都查不到。
    error.details = { ...(error.details ?? {}), result };
    throw error;
  };

  // 三个 handler 只跑业务 + 原服务层后处理：page 由 withBrowserRun 提供，账号锁与
  // 关闭都不归它们。
  queue.registerHandler(WORK_KINDS.accountRun, async (context) => {
    const result = await withBrowserRun(context, async ({ signal, page, account }) => {
      const value = await runOnce(account, { page, signal });
      // 原 operations.create 回调里的两件事，迁到队列后必须跟着走，否则历史不落盘、
      // 账号视图也不刷新。
      recordConversation?.(account.id, value);
      const latest = store.getAccount(account.id) ?? account;
      // publicAccount 需要完整的服务 runtime（分组、节点、调度状态）。它在组合时还不
       // 存在，所以按需取；取不到就不发半个 payload——缺字段的账号视图比不发更糟。
      const viewRuntime = accountViewRuntime?.();
      if (viewRuntime) {
        events?.publish("account.changed", publicAccount(latest, viewRuntime));
      }
      return value;
    });
    return failIfNotOk(result, "自动对话执行失败");
  });

  // 状态检查同样经 withBrowserRun：它自己走账号锁 + launch 的老路会在队列已持锁时
  // 被 isBusy 判为忙碌并直接返回 cached skipped，巡检永远不启动 Chrome。
  queue.registerHandler(WORK_KINDS.statusCheck, async (context) =>
    withBrowserRun(context, async ({ signal, page, account }) => {
      const value = await refreshAccount(account, { page, signal });
      const latest = store.getAccount(account.id) ?? account;
      events?.publish("accountStatus.changed", publicStatus(latest, value));
      return value;
    })
  );

  queue.registerHandler(WORK_KINDS.selectorCheck, async (context) => {
    const result = await withBrowserRun(context, async ({ signal, page, account }) => {
      return checkSelectors(account, {
        page,
        depth: context.dedupeParams?.depth ?? "page",
        signal,
      });
    });
    // 必须晚于关闭阶段写入，否则 finally 的“正在关闭 Chrome”会覆盖最终摘要。
    context.setStage("complete", result?.summary || "选择器自检完成");
    return failIfNotOk(result, "选择器自检失败");
  });

  // 巡检把到期账号入队后立即返回；重入保护由去重承担。
  statusMonitor?.configureEnqueue?.((accountId) => {
    queue.submit({
      accountId,
      workKind: WORK_KINDS.statusCheck,
      source: SOURCES.background,
      kind: "account-status-refresh",
      message: "等待状态巡检",
    });
  });

  // 已交给队列、尚未收到终态的到期意图。§6.5：补跑完成后只计算一个新的未来执行
  // 时间，所以重排必须发生在终态，不能在 onDue 里预排——跑 40 分钟的任务会让下次
  // 时间从"开始时刻"起算，窗口提前滚动甚至吞掉一个周期。
  const pendingDue = new Set();

  const clock = new ScheduleClock({
    log,
    onDue: (accountId) => {
      // 先标记再 submit：submit 会同步 pump，健康校验失败时终态回调在 submit 内部
      // 就已经跑完，标记晚一步就永远等不到重排。
      pendingDue.add(accountId);
      try {
        queue.submit({
          accountId,
          workKind: WORK_KINDS.accountRun,
          source: SOURCES.scheduled,
          kind: "account-run",
          message: "等待自动对话",
        });
      } catch (error) {
        pendingDue.delete(accountId);
        throw error;
      }
    },
  });

  /**
   * 到期任务收口：恰好重排一次。
   *
   * 调度已停 / 账号已停用或删除时不重排——那是生命周期，不是"这一轮跑完了"。
   */
  const settleDue = (accountId, completion) => {
    if (!pendingDue.delete(accountId)) return;
    if (scheduler.running === false) return;
    const account = store.getAccount(accountId);
    if (!account || account.enabled === false) return;
    const nextAt = scheduler.nextAtFromNow(Date.now());
    clock.schedule(accountId, nextAt);
    if (completion) {
      // 真跑过（或健康校验失败）：结果、lastAt、nextAt 一次写完，不留中间态。
      scheduler.noteCompleted(accountId, { ...completion, nextAt });
      return;
    }
    // 到期意图被已有 manual 条目合并：手动结果不是自动运行结果，只排下次时间。
    scheduler.noteScheduled(accountId, { nextAt });
  };

  // 调度状态的另一半：跑完的时间与结果只有队列知道。每个终态恰好通知一次，
  // 排队期语义取消也在内——代理节点缺失这类健康校验失败必须留下痕迹，否则用户
  // 只看到「什么都没发生」。生命周期取消（stop / 停用 / 退出）不带 settlesRun。
  queue.onSettled((entry, outcome) => {
    if (entry.workKind !== WORK_KINDS.accountRun) return;
    if (!pendingDue.has(entry.accountId)) return;
    // 生命周期取消（stop / 停用 / Agent 退出）：不重排、不写结果，只丢掉这次意图。
    // 必须先于 manual 合并分支判断，否则退出时被合并的手动任务仍会错误重排。
    if (outcome.settlesRun !== true) {
      pendingDue.delete(entry.accountId);
      return;
    }
    // 去重把到期意图并进了用户触发的条目：effectiveSource 已被提升为 manual。
    if (entry.effectiveSource !== SOURCES.scheduled) {
      settleDue(entry.accountId, null);
      return;
    }
    settleDue(entry.accountId, {
      lastAt: Date.now(),
      result: { ok: outcome.ok, reason: outcome.reason },
    });
  });

  return {
    slots,
    queue,
    browserRuns,
    broker,
    launcher,
    clock,
    snapshot,
    planOverdueRecovery,
    acquireInteractiveChrome,
    /**
     * 三个交互入口的统一提交口。返回队列创建的 Operation：去重命中时返回的是**现有**
     * 那个，连点不再制造第二个任务，而是把它提升为用户触发。
     */
    enqueue({ accountId, workKind, kind, dedupeParams, message }) {
      return queue.submit({
        accountId,
        workKind,
        source: SOURCES.manual,
        kind,
        dedupeParams,
        message,
      });
    },
    async dispose() {
      clock.stop();
      queue.stopAdmission();
      browserRuns.cancelAllRechecks();
      configureChromeLauncher(null);
      await broker?.dispose();
    },
  };
}

export { ChromeBrokerUnavailableError };
