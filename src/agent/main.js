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
import { closeAllLoginTasks } from "../loginProvider.js";
import { closeAllOpenPages } from "../openPage.js";
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
  try {
    stopStatusMonitor();
    const drained = await scheduler.drain({ timeoutMs: 60_000, preserveEnabled: preserveScheduler });
    if (!drained.drained) log.warn("Agent 关闭时调度任务未能在限定时间内结束");
    proxies.stopAll();
    const closeResults = await Promise.allSettled([
      closeAllLoginTasks(),
      closeAllOpenPages(),
    ]);
    for (const result of closeResults) {
      if (result.status === "rejected") {
        log.warn(`关闭浏览器任务失败：${String(result.reason?.message || result.reason)}`);
      }
    }
    if (agent?.started) await agent.server.close();
    if (repository) {
      const currentRepository = repository;
      repository = null;
      try {
        currentRepository.checkpoint();
      } finally {
        currentRepository.close();
      }
    }
    for (const restore of backendRestorers.reverse()) restore();
    backendRestorers = [];
    process.exitCode = exitCode;
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
