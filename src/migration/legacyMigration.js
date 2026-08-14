import fs from "node:fs";
import path from "node:path";
import { openKeeperRepository } from "../persistence/sqliteRepository.js";
import { validateDataRoot, isPathWithin } from "../persistence/platformPaths.js";
import { stageAndPromoteProfiles } from "./profileCopy.js";
import { verifyLegacyMigrationPlan } from "./legacyPlan.js";

function runnerError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function migrationIdFor(plan) {
  return `legacy-${plan.sourceFingerprint.slice(0, 24)}`;
}

function markerFor(plan, migrationId) {
  return { migrationId, sourceFingerprint: plan.sourceFingerprint };
}

function readOwnedMarker(stagingRoot, expected, fsImpl) {
  let marker;
  try {
    marker = JSON.parse(fsImpl.readFileSync(path.join(stagingRoot, "migration-owner.json"), "utf8"));
  } catch (error) {
    throw runnerError("UNOWNED_STAGING", "数据库迁移暂存目录没有有效所有权标记", error);
  }
  if (
    marker.migrationId !== expected.migrationId ||
    marker.sourceFingerprint !== expected.sourceFingerprint
  ) {
    throw runnerError("UNOWNED_STAGING", "数据库迁移暂存目录属于另一项迁移");
  }
}

function cleanupOwnedStaging(stagingRoot, expected, migrationRoot, fsImpl) {
  if (!fsImpl.existsSync(stagingRoot)) return;
  const importingRoot = path.join(migrationRoot, ".importing");
  if (!isPathWithin(stagingRoot, importingRoot) || path.resolve(stagingRoot) === path.resolve(importingRoot)) {
    throw runnerError("UNSAFE_STAGING_PATH", "拒绝清理不受控的数据库暂存目录");
  }
  readOwnedMarker(stagingRoot, expected, fsImpl);
  fsImpl.rmSync(stagingRoot, { recursive: true, force: false });
}

/**
 * Full migration is opt-in and explicit. Source data is verified twice and is
 * never moved/deleted. Profiles are promoted before the staged DB; a retry can
 * safely recognize already verified profiles after a crash between promotions.
 */
export async function runLegacyMigration({
  plan,
  targetDataRoot,
  installRoot = null,
  volumeInfo = null,
  repositoryFactory = openKeeperRepository,
  databaseOptions = {},
  profileCopyOptions = {},
  appVersion = null,
  onProgress = null,
  fsImpl = fs,
} = {}) {
  if (!plan?.sourceFingerprint || !plan?.sourceRoot) {
    throw runnerError("INVALID_MIGRATION_PLAN", "迁移计划不完整");
  }
  const targetRoot = validateDataRoot(targetDataRoot, {
    installRoot,
    legacyRoot: plan.sourceRoot,
    volumeInfo,
    fsImpl,
  });
  onProgress?.({ stage: "verify-source", message: "正在确认旧数据在扫描后未发生变化", progress: 0 });
  verifyLegacyMigrationPlan(plan, { fsImpl });

  const migrationId = migrationIdFor(plan);
  const expectedMarker = markerFor(plan, migrationId);
  const finalDatabase = path.join(targetRoot, "keeper.db");
  const backups = path.join(targetRoot, "backups");

  if (fsImpl.existsSync(finalDatabase)) {
    const repository = await repositoryFactory({
      filePath: finalDatabase,
      backupDirectory: backups,
      appVersion,
      fsImpl,
      ...databaseOptions,
    });
    try {
      const imported = repository.getCompletedMigration(plan.sourceFingerprint);
      if (!imported) {
        throw runnerError("DATABASE_ALREADY_EXISTS", "目标 keeper.db 已存在且不属于本次迁移");
      }
    } finally {
      repository.close();
    }
    const profiles = stageAndPromoteProfiles({
      plan,
      targetDataRoot: targetRoot,
      migrationId,
      installRoot,
      volumeInfo,
      onProgress,
      fsImpl,
      ...profileCopyOptions,
    });
    return Object.freeze({ alreadyMigrated: true, migrationId, profiles });
  }

  const migrationRoot = path.join(targetRoot, "migration");
  const stagingRoot = path.join(migrationRoot, ".importing", migrationId);
  if (fsImpl.existsSync(stagingRoot)) {
    cleanupOwnedStaging(stagingRoot, expectedMarker, migrationRoot, fsImpl);
  }
  fsImpl.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(
    path.join(stagingRoot, "migration-owner.json"),
    JSON.stringify(expectedMarker),
    { encoding: "utf8", mode: 0o600 }
  );

  const stagedDatabase = path.join(stagingRoot, "keeper.db");
  let repository = null;
  try {
    onProgress?.({ stage: "build-database", message: "正在构造迁移数据库", progress: 0 });
    repository = await repositoryFactory({
      filePath: stagedDatabase,
      backupDirectory: path.join(stagingRoot, "backups"),
      appVersion,
      fsImpl,
      ...databaseOptions,
    });
    const imported = repository.importLegacyPlan(plan, { migrationId, appVersion });
    const integrity = repository.integrityCheck();
    if (!integrity.ok) throw runnerError("DATABASE_INTEGRITY_FAILED", "迁移数据库完整性检查失败");
    repository.checkpoint();
    repository.close();
    repository = null;

    const profiles = stageAndPromoteProfiles({
      plan,
      targetDataRoot: targetRoot,
      migrationId,
      installRoot,
      volumeInfo,
      onProgress,
      fsImpl,
      ...profileCopyOptions,
    });
    // 用户自定义过的 selectors.json 必须真正落到数据目录，否则迁移只是"采集"了
    // 这个覆盖然后丢掉，用户改过的选择器在新版本里静默失效。
    // 放数据目录而不是安装目录：安装目录会被更新整体替换。
    if (plan.selectorsOverride) {
      const configRoot = path.join(targetRoot, "config");
      fsImpl.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(
        path.join(configRoot, "selectors.json"),
        `${JSON.stringify(plan.selectorsOverride, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
    }

    onProgress?.({ stage: "final-verification", message: "正在执行最终源数据与数据库校验", progress: 1 });
    verifyLegacyMigrationPlan(plan, { fsImpl });
    if (fsImpl.existsSync(finalDatabase)) {
      throw runnerError("DATABASE_ALREADY_EXISTS", "提升迁移数据库时目标文件已存在");
    }
    fsImpl.renameSync(stagedDatabase, finalDatabase);
    try {
      fsImpl.chmodSync(finalDatabase, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    fsImpl.mkdirSync(migrationRoot, { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(
      path.join(migrationRoot, `${migrationId}.completed.json`),
      JSON.stringify({ ...expectedMarker, completedAt: new Date().toISOString() }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    cleanupOwnedStaging(stagingRoot, expectedMarker, migrationRoot, fsImpl);
    onProgress?.({ stage: "completed", message: "旧数据迁移完成", progress: 1 });
    return Object.freeze({
      alreadyMigrated: false,
      migrationId,
      databaseFile: finalDatabase,
      imported,
      profiles,
    });
  } catch (error) {
    if (repository) {
      try {
        repository.close();
      } catch (closeError) {
        error.closeError = closeError;
      }
    }
    try {
      cleanupOwnedStaging(stagingRoot, expectedMarker, migrationRoot, fsImpl);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}
