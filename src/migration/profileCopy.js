import fs from "node:fs";
import path from "node:path";
import { hashFile } from "./legacyPlan.js";
import { isPathWithin, validateDataRoot } from "../persistence/platformPaths.js";

const ONE_GIB = 1024 ** 3;

function copyError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function reportProgress(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(Object.freeze({ ...payload }));
  } catch {
    // A diagnostic/progress sink must never make a verified migration fail.
  }
}

function validateMigrationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw copyError("INVALID_MIGRATION_ID", "migrationId 只能包含安全的 ASCII 文件名字符");
  }
  if (value === "." || value === "..") {
    throw copyError("INVALID_MIGRATION_ID", "migrationId 不安全");
  }
  return value;
}

function validateTreeName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw copyError("UNSAFE_MANIFEST_PATH", `Profile 名称不安全：${String(value)}`);
  }
  return value;
}

function manifestSegments(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value)) {
    throw copyError("UNSAFE_MANIFEST_PATH", `清单路径不安全：${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw copyError("UNSAFE_MANIFEST_PATH", `清单路径不安全：${value}`);
  }
  return segments;
}

function resolveManifestPath(root, relative) {
  const result = path.resolve(root, ...manifestSegments(relative));
  if (!isPathWithin(result, root) || result === path.resolve(root)) {
    throw copyError("UNSAFE_MANIFEST_PATH", `清单路径越界：${relative}`);
  }
  return result;
}

function nearestExistingDirectory(value, fsImpl) {
  let current = path.resolve(value);
  while (!fsImpl.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw copyError("TARGET_VOLUME_UNAVAILABLE", "找不到目标卷");
    current = parent;
  }
  const stat = fsImpl.statSync(current);
  return stat.isDirectory() ? current : path.dirname(current);
}

function defaultAvailableBytes(value, fsImpl) {
  if (typeof fsImpl.statfsSync !== "function") {
    throw copyError("DISK_SPACE_CHECK_UNAVAILABLE", "当前 Node 不支持 statfsSync，不能安全预检磁盘空间");
  }
  const stats = fsImpl.statfsSync(nearestExistingDirectory(value, fsImpl));
  return Number(stats.bavail) * Number(stats.bsize);
}

export function requiredFreeBytes(
  bytesToCopy,
  { minimumReserveBytes = ONE_GIB, reserveRatio = 0.1 } = {}
) {
  if (!Number.isFinite(bytesToCopy) || bytesToCopy < 0) throw new RangeError("bytesToCopy must be non-negative");
  if (bytesToCopy === 0) return 0;
  return bytesToCopy + Math.max(minimumReserveBytes, Math.ceil(bytesToCopy * reserveRatio));
}

function readMarker(stagingRoot, fsImpl) {
  const markerFile = path.join(stagingRoot, "migration-owner.json");
  try {
    return JSON.parse(fsImpl.readFileSync(markerFile, "utf8"));
  } catch (error) {
    throw copyError("UNOWNED_STAGING", `暂存目录没有有效的所有权标记：${stagingRoot}`, error);
  }
}

function removeOwnedStaging(stagingRoot, expected, targetRoot, fsImpl) {
  if (!fsImpl.existsSync(stagingRoot)) return;
  if (!isPathWithin(stagingRoot, path.join(targetRoot, ".importing")) || stagingRoot === path.join(targetRoot, ".importing")) {
    throw copyError("UNSAFE_STAGING_PATH", "拒绝清理不受控的暂存目录");
  }
  const marker = readMarker(stagingRoot, fsImpl);
  if (
    marker.migrationId !== expected.migrationId ||
    marker.sourceFingerprint !== expected.sourceFingerprint
  ) {
    throw copyError("UNOWNED_STAGING", "暂存目录属于另一项迁移，拒绝清理");
  }
  fsImpl.rmSync(stagingRoot, { recursive: true, force: false });
}

function destinationRootForTree(targetRoot, tree) {
  if (tree.kind === "active") return path.join(targetRoot, "profiles", validateTreeName(tree.name));
  if (tree.kind === "archive") return path.join(targetRoot, "profiles-archive", validateTreeName(tree.name));
  throw copyError("INVALID_PROFILE_KIND", `不支持的 Profile 类型：${tree.kind}`);
}

function stagingRootForTree(stagingRoot, tree) {
  const category = tree.kind === "active" ? "profiles" : tree.kind === "archive" ? "profiles-archive" : null;
  if (!category) throw copyError("INVALID_PROFILE_KIND", `不支持的 Profile 类型：${tree.kind}`);
  return path.join(stagingRoot, category, validateTreeName(tree.name));
}

function verifyTree(root, tree, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(root)) return false;
  const rootStat = fsImpl.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw copyError("DESTINATION_CONFLICT", `目标 Profile 不是普通目录：${root}`);
  }
  const expected = new Set();
  for (const file of tree.files) {
    const target = resolveManifestPath(root, file.path);
    expected.add(path.resolve(target));
    if (!fsImpl.existsSync(target)) return false;
    const stat = fsImpl.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return false;
    if (hashFile(target, { fsImpl }) !== file.sha256) return false;
  }

  const actual = [];
  const walk = (directory) => {
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(absolute);
      else if (entry.isFile() && !entry.isSymbolicLink()) actual.push(path.resolve(absolute));
      else throw copyError("DESTINATION_CONFLICT", `目标 Profile 含链接或特殊文件：${absolute}`);
    }
  };
  walk(root);
  return actual.length === expected.size && actual.every((file) => expected.has(file));
}

function assertNoSourceTargetOverlap(sourceRoot, targetRoot) {
  if (isPathWithin(targetRoot, sourceRoot) || isPathWithin(sourceRoot, targetRoot)) {
    throw copyError("SOURCE_TARGET_OVERLAP", "迁移源目录和目标数据目录不能互相包含");
  }
}

/**
 * Explicit profile copy. It stages and verifies every file, never overwrites a
 * destination, and only removes staging carrying the same migration marker.
 */
export function stageAndPromoteProfiles({
  plan,
  targetDataRoot,
  migrationId,
  installRoot = null,
  volumeInfo = null,
  getAvailableBytes = null,
  minimumReserveBytes = ONE_GIB,
  reserveRatio = 0.1,
  onProgress = null,
  fsImpl = fs,
} = {}) {
  if (!plan?.sourceRoot || !plan?.sourceFingerprint || !Array.isArray(plan?.manifest?.profileTrees)) {
    throw copyError("INVALID_MIGRATION_PLAN", "迁移计划缺少 Profile 清单");
  }
  const safeId = validateMigrationId(migrationId);
  const targetRoot = validateDataRoot(targetDataRoot, {
    installRoot,
    legacyRoot: plan.sourceRoot,
    fsImpl,
    volumeInfo,
  });
  const sourceRoot = path.resolve(plan.sourceRoot);
  assertNoSourceTargetOverlap(sourceRoot, targetRoot);

  const treesToCopy = [];
  let reusedProfiles = 0;
  for (const tree of plan.manifest.profileTrees) {
    validateTreeName(tree.name);
    const destination = destinationRootForTree(targetRoot, tree);
    if (fsImpl.existsSync(destination)) {
      if (!verifyTree(destination, tree, { fsImpl })) {
        throw copyError("DESTINATION_CONFLICT", `目标 Profile 已存在且内容不同：${tree.name}`);
      }
      reusedProfiles++;
    } else {
      treesToCopy.push(tree);
    }
  }
  const bytesToCopy = treesToCopy.reduce((sum, tree) => sum + tree.size, 0);
  const required = requiredFreeBytes(bytesToCopy, { minimumReserveBytes, reserveRatio });
  const available = getAvailableBytes
    ? Number(getAvailableBytes(nearestExistingDirectory(targetRoot, fsImpl)))
    : defaultAvailableBytes(targetRoot, fsImpl);
  if (!Number.isFinite(available) || available < required) {
    throw copyError(
      "INSUFFICIENT_DISK_SPACE",
      `目标磁盘可用空间不足：需要至少 ${required} 字节，可用 ${available} 字节`
    );
  }

  reportProgress(onProgress, {
    stage: "copy-preflight",
    message: `准备复制 ${treesToCopy.length} 个 Profile`,
    progress: treesToCopy.length ? 0 : 1,
    copiedBytes: 0,
    totalBytes: bytesToCopy,
    copiedProfiles: 0,
    totalProfiles: treesToCopy.length,
  });

  if (!treesToCopy.length) {
    return Object.freeze({
      copiedProfiles: 0,
      reusedProfiles,
      copiedBytes: 0,
      requiredBytes: required,
      availableBytes: available,
    });
  }

  const importingRoot = path.join(targetRoot, ".importing");
  const stagingRoot = path.join(importingRoot, safeId);
  const marker = { migrationId: safeId, sourceFingerprint: plan.sourceFingerprint };
  if (fsImpl.existsSync(stagingRoot)) removeOwnedStaging(stagingRoot, marker, targetRoot, fsImpl);

  try {
    fsImpl.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(path.join(stagingRoot, "migration-owner.json"), JSON.stringify(marker), {
      encoding: "utf8",
      mode: 0o600,
    });

    let copiedBytes = 0;
    let copiedProfileCount = 0;
    for (const tree of treesToCopy) {
      reportProgress(onProgress, {
        stage: "copy-profile",
        message: `正在复制 Profile：${tree.name}`,
        progress: bytesToCopy ? copiedBytes / bytesToCopy : 0,
        copiedBytes,
        totalBytes: bytesToCopy,
        copiedProfiles: copiedProfileCount,
        totalProfiles: treesToCopy.length,
        profileName: tree.name,
      });
      const sourceTreeRoot = resolveManifestPath(sourceRoot, tree.sourcePath);
      const stagedTreeRoot = stagingRootForTree(stagingRoot, tree);
      fsImpl.mkdirSync(stagedTreeRoot, { recursive: true, mode: 0o700 });
      for (const file of tree.files) {
        const source = resolveManifestPath(sourceTreeRoot, file.path);
        const sourceStat = fsImpl.lstatSync(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== file.size) {
          throw copyError("SOURCE_CHANGED", `Profile 源文件发生变化：${tree.sourcePath}/${file.path}`);
        }
        if (hashFile(source, { fsImpl }) !== file.sha256) {
          throw copyError("SOURCE_CHANGED", `Profile 源文件校验失败：${tree.sourcePath}/${file.path}`);
        }
        const destination = resolveManifestPath(stagedTreeRoot, file.path);
        fsImpl.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fsImpl.copyFileSync(source, destination, fsImpl.constants?.COPYFILE_EXCL ?? fs.constants.COPYFILE_EXCL);
        copiedBytes += file.size;
        reportProgress(onProgress, {
          stage: "copy-profile",
          message: `正在复制 Profile：${tree.name}`,
          progress: bytesToCopy ? Math.min(1, copiedBytes / bytesToCopy) : 1,
          copiedBytes,
          totalBytes: bytesToCopy,
          copiedProfiles: copiedProfileCount,
          totalProfiles: treesToCopy.length,
          profileName: tree.name,
        });
      }
      reportProgress(onProgress, {
        stage: "verify-profile",
        message: `正在校验 Profile：${tree.name}`,
        progress: bytesToCopy ? Math.min(1, copiedBytes / bytesToCopy) : 1,
        copiedBytes,
        totalBytes: bytesToCopy,
        copiedProfiles: copiedProfileCount,
        totalProfiles: treesToCopy.length,
        profileName: tree.name,
      });
      if (!verifyTree(stagedTreeRoot, tree, { fsImpl })) {
        throw copyError("COPY_VERIFICATION_FAILED", `Profile 复制校验失败：${tree.name}`);
      }
      copiedProfileCount++;
    }

    let promoted = 0;
    for (const tree of treesToCopy) {
      const stagedTree = stagingRootForTree(stagingRoot, tree);
      const destination = destinationRootForTree(targetRoot, tree);
      fsImpl.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (fsImpl.existsSync(destination)) {
        if (!verifyTree(destination, tree, { fsImpl })) {
          throw copyError("DESTINATION_CONFLICT", `提升时目标 Profile 已被其他内容占用：${tree.name}`);
        }
        fsImpl.rmSync(stagedTree, { recursive: true, force: false });
        reusedProfiles++;
      } else {
        fsImpl.renameSync(stagedTree, destination);
        promoted++;
      }
    }
    removeOwnedStaging(stagingRoot, marker, targetRoot, fsImpl);
    try {
      fsImpl.rmdirSync(importingRoot);
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
    }
    reportProgress(onProgress, {
      stage: "profiles-promoted",
      message: "Profile 已校验并提升到正式数据目录",
      progress: 1,
      copiedBytes: bytesToCopy,
      totalBytes: bytesToCopy,
      copiedProfiles: treesToCopy.length,
      totalProfiles: treesToCopy.length,
    });
    return Object.freeze({
      copiedProfiles: promoted,
      reusedProfiles,
      copiedBytes: bytesToCopy,
      requiredBytes: required,
      availableBytes: available,
    });
  } catch (error) {
    try {
      removeOwnedStaging(stagingRoot, marker, targetRoot, fsImpl);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

export { verifyTree as verifyCopiedProfileTree };
