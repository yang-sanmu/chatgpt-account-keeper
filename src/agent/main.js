import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import * as proxies from "../proxyManager.js";
import {
  reloadPersistedStatusCache,
  startStatusMonitor,
  stopStatusMonitor,
} from "../statusMonitor.js";
import { configureStatusBackend } from "../statusCacheStore.js";
import { startProfileMaintenance } from "../profileMaintenance.js";
import { scheduler } from "../scheduler.js";
import { closeAllBrowserContexts } from "../browser.js";
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
  if (shuttingDown) return;
  shuttingDown = true;
  let cleanupFailed = false;
  const cleanup = async (label, action) => {
    try {
      return await action();
    } catch (error) {
      cleanupFailed = true;
      log.warn(`${label}失败：${String(error?.message || error)}`);
      return null;
    }
  };
  try {
    await cleanup("停止状态巡检", () => stopStatusMonitor());
    // 退出不是“等用户手动关窗口”：先禁止排队任务再开 Chrome，并主动释放
    // 本 Agent 启动的调度、巡检、登录和可见窗口。关闭上下文会让占锁任务尽快收尾。
    await cleanup("关闭 Chrome", () => closeAllBrowserContexts({ timeoutMs: 3_000 }));
    const drained = await cleanup("停止调度", () =>
      scheduler.drain({ timeoutMs: 5_000, preserveEnabled: preserveScheduler })
    );
    if (drained && !drained.drained) log.warn("Agent 关闭时调度任务未能在限定时间内结束");
    await cleanup("停止代理内核", () => proxies.stopAll());
    if (agent?.started) await cleanup("关闭 IPC 服务", () => agent.server.close());
    if (repository) {
      const currentRepository = repository;
      repository = null;
      await cleanup("关闭数据库", () => {
        try {
          currentRepository.checkpoint();
        } finally {
          currentRepository.close();
        }
      });
    }
    for (const restore of backendRestorers.reverse()) {
      await cleanup("释放运行后端", () => restore());
    }
    backendRestorers = [];
  } finally {
    if (instanceLock) {
      try {
        await instanceLock.release();
      } catch (error) {
        log.warn(`释放单实例锁失败：${String(error?.message || error)}`);
      }
      instanceLock = null;
    }
  }
  // 所有持久化与单实例锁均已释放。即使第三方浏览器驱动残留句柄，Agent 也
  // 不应反过来阻止桌面程序退出。放到下一轮事件循环，让 agent.stop() 当前的
  // Promise 收尾先完成，但不再等待其它未知句柄自然消失。
  const finalExitCode = cleanupFailed ? 1 : exitCode;
  process.exitCode = finalExitCode;
  setImmediate(() => process.exit(finalExitCode));
}

async function main() {
  const endpoint = endpointFromArgs();
  const paths = resolvePlatformPaths({ dataRoot: dataRootFromArgs() });
  const dataRoot = paths.dataRoot;
  const legacyRoot = legacyRootFromArgs();

  // 单实例锁要在迁移之前拿到：迁移会往目标数据目录写 Profile 和数据库，
  // 两个 Agent 同时迁移同一目录会互相破坏 staging。
  instanceLock = await acquireInstanceLock(paths.instanceLockFile, { endpoint });

  if (!fs.existsSync(paths.databaseFile) && legacyRoot) {
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
      reportBackgroundError: (error) => {
        log.error(`Agent 关闭失败：${String(error?.stack || error)}`);
        process.exitCode = 1;
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
      startStatusMonitor();
      startProfileMaintenance();
      if (adapters.scheduler.load().enabled) scheduler.start();
    },
  });
  await agent.start();
  log.info(`GptAccount Keeper Agent 已启动：${endpoint}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(0).catch((error) => {
      log.error(String(error?.stack || error));
      process.exitCode = 1;
    });
  });
}

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
