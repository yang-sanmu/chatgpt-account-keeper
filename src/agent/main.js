import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import * as proxies from "../proxyManager.js";
import {
  reloadPersistedStatusCache,
  startStatusMonitor,
  statusMonitor,
  stopStatusMonitor,
  refreshAccount,
} from "../statusMonitor.js";
import { configureStatusBackend } from "../statusCacheStore.js";
import { startProfileMaintenance } from "../profileMaintenance.js";
import { checkSelectors, runOnce, scheduler } from "../scheduler.js";
import { closeAllBrowserContexts } from "../browser.js";
import { closeAllLoginTasks } from "../loginProvider.js";
import { closeAllOpenPages } from "../openPage.js";
import { composeBackground } from "./composition.js";
import { runShutdownSequence } from "./shutdownSequence.js";
import { installShutdownHandlers } from "../shutdown.js";
import * as log from "../logger.js";
import { configureHistoryBackend } from "../logger.js";
import { createAgent } from "./createAgent.js";
import { APPLICATION_VERSION } from "../application/services.js";
import {
  dataRootFromArgs,
  endpointFromArgs,
  legacyRootFromArgs,
} from "./endpoint.js";
import {
  createSqliteRuntimeAdapters,
  openKeeperRepository,
  resolvePlatformPaths,
} from "../persistence/index.js";
import {
  buildLegacyMigrationPlan,
  runLegacyMigration,
} from "../migration/index.js";
import { createMigrationProgressReporter } from "./migrationProgress.js";
import { acquireInstanceLock } from "./instanceLock.js";

let shuttingDown = false;
let shuttingDownPromise = null;
let background = null;
let agent;
let repository;
let instanceLock = null;
let backendRestorers = [];
const migrationProgressFile = process.env.GPT_ACCOUNT_KEEPER_MIGRATION_PROGRESS_FILE || null;
const reportMigration = createMigrationProgressReporter(migrationProgressFile, { logger: log });

async function updateBackup(dataRoot) {
  repository.checkpoint();
  const backups = path.join(dataRoot, "backups");
  fs.mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const target = path.join(backups, `keeper-v${repository.getSchemaVersion()}-${stamp}.db`);
  await repository.backupTo(target);
  const files = fs.readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^keeper-v\d+-.*\.db$/.test(entry.name))
    .map((entry) => ({
      path: path.join(backups, entry.name),
      mtime: fs.statSync(path.join(backups, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(3)) fs.unlinkSync(old.path);
}

async function shutdown(exitCode = 0, { preserveScheduler = true } = {}) {
  if (shuttingDown) return shuttingDownPromise;
  shuttingDown = true;
  shuttingDownPromise = performShutdown(exitCode, { preserveScheduler });
  return shuttingDownPromise;
}

async function performShutdown(exitCode, { preserveScheduler }) {
  const result = await runShutdownSequence({
    log,
    beginDraining: () => {
      if (agent?.services) agent.services.draining = true;
    },
    stopAccepting: () => agent?.started && agent.server.stopAccepting(),
    stopTimers: () => {
      background?.clock?.stop();
      background?.queue?.stopAdmission();
      stopStatusMonitor();
    },
    cancelQueued: () => background?.queue?.cancelAllQueued("Agent 正在退出"),
    signalActive: () => background?.queue?.signalAllActive("Agent 正在退出"),
    closeInteractive: async () => {
      await closeAllLoginTasks().catch(() => {});
      await closeAllOpenPages().catch(() => {});
    },
    closeBrowserRuns: async () => {
      if (background?.browserRuns) await background.browserRuns.closeAll("shutdown");
      // 旧路径（未注入 launcher）的上下文仍需要收口。
      await closeAllBrowserContexts({ timeoutMs: 3_000 }).catch(() => {});
      const drained = await scheduler
        .drain({ timeoutMs: 5_000, preserveEnabled: preserveScheduler })
        .catch(() => null);
      if (drained && !drained.drained) log.warn("Agent 关闭时调度任务未能在限定时间内结束");
    },
    awaitConvergence: async () => {
      const queue = background?.queue;
      if (!queue) return;
      const deadline = Date.now() + 4_000;
      while (queue.activeCount() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 100);
          timer.unref?.();
        });
      }
      if (queue.activeCount() > 0) {
        throw new Error(`仍有 ${queue.activeCount()} 个活动条目未收敛`);
      }
    },
    // broker 必须在 active registry 为空时才允许退出；存在 entry 时它会拒绝，
    // 绝不能靠退出 broker 冒充单 run 的正常回收。
    shutdownBroker: async () => {
      const broker = background?.broker;
      if (!broker?.running) return;
      const response = await broker.requestShutdown();
      if (response && response.ok === false) {
        throw new Error(`broker 拒绝 shutdown：${response.code ?? "unknown"}`);
      }
      await broker.dispose();
    },
    unresolved: () => {
      const runs = background?.browserRuns?.unresolved?.() ?? [];
      return runs.map((run) => ({
        kind: "browserRun",
        browserRunId: run.browserRunId,
        accountId: run.accountId,
        state: run.state,
        runToken: run.launcherRunToken,
      }));
    },
    flushOperations: () => {
      agent?.services?.operations?.flush?.("Agent 关闭，任务已中断");
    },
    sealOperations: () => {
      const sealed = agent?.services?.operations?.seal?.();
      if (sealed?.sealViolations) {
        log.error(`关闭期间检测到 ${sealed.sealViolations} 次 seal 后写入`);
      }
    },
    stopProxies: () => proxies.stopAll(),
    closeRepository: () => {
      if (!repository) return;
      const currentRepository = repository;
      repository = null;
      try {
        currentRepository.checkpoint();
      } finally {
        currentRepository.close();
      }
    },
    releaseBackends: async () => {
      for (const restore of backendRestorers.reverse()) {
        try {
          await restore();
        } catch (error) {
          log.warn(`释放运行后端失败：${String(error?.message || error)}`);
        }
      }
      backendRestorers = [];
    },
    destroyServer: async () => {
      background?.browserRuns?.cancelAllRechecks?.();
      if (agent?.started) await agent.server.destroy();
    },
    releaseInstanceLock: async () => {
      if (!instanceLock) return;
      try {
        await instanceLock.release();
      } catch (error) {
        log.warn(`释放单实例锁失败：${String(error?.message || error)}`);
      }
      instanceLock = null;
    },
  });

  // 未收敛即 fatal：不 seal、不关库，由 Desktop 的 Agent 级 Job 收树。
  const finalExitCode = result.ok ? exitCode : 1;
  process.exitCode = finalExitCode;
  setImmediate(() => process.exit(finalExitCode));
  return result;
}

async function main() {
  const endpoint = endpointFromArgs();
  const paths = resolvePlatformPaths({ dataRoot: dataRootFromArgs() });
  const dataRoot = paths.dataRoot;
  const legacyRoot = legacyRootFromArgs();

  // 单实例锁要在迁移之前拿到：迁移会往目标数据目录写 Profile 和数据库，
  // 两个 Agent 同时迁移同一目录会互相破坏 staging。
  instanceLock = await acquireInstanceLock(paths.instanceLockFile, { endpoint });

  if (legacyRoot) {
    reportMigration({ state: "running", stage: "scan", message: "正在扫描旧配置、历史和 Profile", progress: 0 });
    const plan = buildLegacyMigrationPlan(path.resolve(legacyRoot));
    reportMigration({
      state: "running",
      stage: "scan-complete",
      message: `扫描完成：${plan.counts.accounts} 个账号，${plan.counts.profiles} 个 Profile`,
      progress: 0,
      counts: plan.counts,
      totalBytes: plan.totalProfileBytes,
    });
    await runLegacyMigration({
      plan,
      targetDataRoot: dataRoot,
      installRoot: process.cwd(),
      appVersion: APPLICATION_VERSION,
      onProgress: (progress) => reportMigration({ state: "running", ...progress }),
    });
    reportMigration({ state: "succeeded", stage: "completed", message: "旧数据迁移完成", progress: 1 });
  }

  repository = await openKeeperRepository({
    filePath: paths.databaseFile,
    backupDirectory: paths.backupsRoot,
    appVersion: APPLICATION_VERSION,
  });
  const adapters = createSqliteRuntimeAdapters(repository);
  backendRestorers = [
    store.configureStoreBackend(adapters.store),
    configureHistoryBackend(adapters.history),
    configureStatusBackend(adapters.status),
    proxies.configureProxyStoreBackend(adapters.proxy),
  ];
  reloadPersistedStatusCache();
  scheduler.configurePersistence(adapters.scheduler);

  agent = createAgent({
    endpoint,
    dataRoot,
    receiptStore: adapters.receiptStore,
    operationStore: adapters.operations,
    logger: log,
    runtime: {
      ipcAuthToken: process.env.GPT_ACCOUNT_KEEPER_IPC_TOKEN || null,
      // 仅这个回调负责「关闭失败」的兜底退出。system.shutdown 是 fire-and-forget：
      // 它把 {accepted:true} 先返回给 Desktop，真正的关闭在 setTimeout 里异步跑。
      // 若那条链抛错，没有人会再推进退出，Agent 会留在半关闭状态。
      // 注意作用域：只有这里强退，通用 ApplicationServices 的任意后台错误不得强退。
      reportBackgroundError: (error) => {
        log.error(`Agent 关闭失败：${String(error?.stack || error)}`);
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      },
      lifecycle: {
        shutdown: ({ reason } = {}) => shutdown(0, { preserveScheduler: reason !== "user-exit-all" }),
        checkpoint: () => updateBackup(dataRoot),
      },
    },
    beforeStart: ({ dataRoot: selectedDataRoot }) => {
      if (selectedDataRoot) log.info(`Agent 数据目录：${selectedDataRoot}`);
    },
    afterStart: () => {
      startProfileMaintenance();
      // 巡检定时器与调度时钟都在后台组合完成后才启动。
      statusMonitor.start();
      // 排期表**无条件**填充：它是唯一给账号排 nextAt 的地方，而 IPC 的
      // scheduler.start 只启动时钟。从 disabled 启动的用户点启动后，时钟会跑起来但
      // 表里空无一物，调度看着在运行却什么都不跑。
      restoreSchedule(adapters.scheduler);
      if (adapters.scheduler.load().enabled) {
        scheduler.start();
      }
    },
  });

  // 后台组合必须在 agent.start() **之前**完成：Windows 上 broker 不可用要让 Agent
  // 在接受任何 IPC 之前就 fail-closed，而不是退化成每个账号各自失败。
  background = await composeBackground({
    operations: agent.services.operations,
    events: agent.services.events,
    store,
    log,
    runOnce,
    checkSelectors,
    refreshAccount,
    statusMonitor,
    scheduler,
    // 语义复验唯一的节点来源。包一层而不是直接传 proxies.getNodes：后者接
    // {safe} 选项，裸引用会把它的形参变成这里的契约。safe 投影已含
    // id / enabled / missing，复验不需要凭证字段。
    getProxyNodes: () => proxies.getNodes(),
    // 原服务层后处理：写历史，以及构造与 IPC 完全一致的账号/状态事件 payload。
    recordConversation: (accountId, result) =>
      agent.services.runtime.recordConversation(accountId, result),
    accountViewRuntime: () => agent.services.runtime,
    onFatal: () => {
      // broker 独占全部 per-run Job 句柄，它退出已使所有 Job 到达 last-handle 并由
      // KILL_ON_JOB_CLOSE 回收全部活动 Chrome；继续运行只会让 Agent 状态与现实脱节。
      shutdown(1, { preserveScheduler: true }).catch((error) => {
        log.error(`broker fatal 后的关闭失败：${String(error?.stack || error)}`);
        process.exit(1);
      });
    },
  });
  // 把队列与 BrowserRun 暴露给应用服务，供 queue.getSnapshot / browserRuns.* 使用。
  agent.services.runtime.queueSnapshot = () => background.snapshot();
  agent.services.runtime.browserRuns = background.browserRuns;
  // 三个交互入口经此进入统一队列；没有它则退回直连路径（旧 CLI / 测试替身）。
  agent.services.runtime.enqueue = (request) => background.enqueue(request);
  // 登录与打开网页也必须占 Chrome 槽并登记 BrowserRun，否则它们创建的 Chrome 不在
  // 容量与明细里，Job 也无人 dispose。
  agent.services.runtime.acquireInteractiveChrome = (request) =>
    background.acquireInteractiveChrome(request);
  // 配置变更只触发复验，本身不取消任何条目（§7.1）。
  agent.services.runtime.bumpConfigEpoch = () => background.queue.bumpConfigEpoch();
  agent.services.runtime.scheduleAccount = (accountId) => {
    const settings = store.getSettings();
    const interval = Math.max(1, settings.intervalMinutes ?? 180) * 60_000;
    // 新启用的账号错峰进入，不让一批账号同时到期。
    const nextAt = Date.now() + Math.floor(Math.random() * interval);
    background.clock.schedule(accountId, nextAt);
    // 只进内存的话，账号页立刻查不到「下次运行时间」，重启后这次排期也不存在。
    scheduler.noteScheduled(accountId, { nextAt });
  };
  agent.services.runtime.unscheduleAccount = (accountId) =>
    background.clock.unschedule(accountId);
  // 计时交给唯一的 ScheduleClock：Scheduler 仍是 IPC start/stop/getState 的载体。
  scheduler.configureClock(background.clock, () => background.queue.bumpSchedulerEpoch());

  await agent.start();
  log.info(`GptAccount Keeper Agent 已启动：${endpoint}`);
}

/**
 * 逾期恢复：按持久化的原始 nextAt 从早到晚，每账号最多一个补跑任务；
 * 由并发上限、Chrome 上限与 1 秒启动间隔自然消化积压。
 */
function restoreSchedule(schedulerPersistence) {
  if (!background?.clock) return;
  const persisted = schedulerPersistence.load?.() ?? { accounts: {} };
  const now = Date.now();
  const plan = background.planOverdueRecovery(persisted.accounts, now);
  const settings = store.getSettings();
  const interval = Math.max(1, settings.intervalMinutes ?? 180) * 60_000;
  const enabled = new Set(
    store.getAccounts().filter((account) => account.enabled).map((account) => account.id)
  );
  let offset = 0;
  for (const entry of plan.overdue) {
    if (!enabled.has(entry.accountId)) continue;
    // 同一时刻恢复的任务按 FIFO 入队；不集中塞进一个 5 分钟窗口。
    const nextAt = now + offset;
    background.clock.schedule(entry.accountId, nextAt);
    // 补跑时刻要立刻落盘：否则这一批在表里仍是旧的逾期时间，下次重启再补一遍。
    scheduler.noteScheduled(entry.accountId, { nextAt });
    offset += 1;
  }
  for (const entry of plan.future) {
    if (!enabled.has(entry.accountId)) continue;
    // future 的 nextAt 是持久化里的原值，保持不变，只是重新装进时钟。
    background.clock.schedule(entry.accountId, entry.nextAt);
    // 值没变也要通知：桌面端此刻才拿到这一批账号的「下次运行时间」。
    scheduler.noteScheduled(entry.accountId, { nextAt: entry.nextAt });
  }
  for (const account of store.getAccounts()) {
    if (!account.enabled) continue;
    if (background.clock.dueAt(account.id) == null) {
      // 表里没有记录的启用账号：这是一次新排期，必须落盘。
      const nextAt = now + Math.floor(Math.random() * interval);
      background.clock.schedule(account.id, nextAt);
      scheduler.noteScheduled(account.id, { nextAt });
    }
  }
  // 时钟由 scheduler.start() 启动：它是唯一的启停入口，这里启动会变成两处控制。
}

// 复用既有的 installShutdownHandlers：它已有 watchdog 与「第二次信号立即退出」语义。
// 自建 process.once 缺少这两项，任何一步挂住就永远走不到最终 exit。
installShutdownHandlers({
  shutdown: () => shutdown(0),
  logger: log,
  timeoutMs: 20_000,
});

main().catch((error) => {
  reportMigration({
    state: "failed",
    stage: "failed",
    message: String(error?.message || error),
    error: {
      code: String(error?.code || "MIGRATION_FAILED"),
      message: String(error?.message || error),
    },
  });
  log.error(`Agent 启动失败：${String(error?.stack || error)}`);
  shutdown(1).catch((shutdownError) => {
    log.error(`Agent 启动失败后的清理也失败：${String(shutdownError?.stack || shutdownError)}`);
    process.exitCode = 1;
  });
});
