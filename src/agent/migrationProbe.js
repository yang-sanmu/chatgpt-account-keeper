#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildLegacyMigrationPlan, PROFILE_LOCK_NAMES } from "../migration/legacyPlan.js";
import { requiredFreeBytes } from "../migration/profileCopy.js";

function argument(name) {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name) return argv[index + 1] ?? null;
    if (argv[index].startsWith(`${name}=`)) return argv[index].slice(name.length + 1) || null;
  }
  return null;
}

function normalizeLegacyRoot(value) {
  if (!value) throw Object.assign(new Error("缺少 --legacy-root"), { code: "INVALID_SOURCE_ROOT" });
  const selected = path.resolve(value);
  if (
    path.basename(selected).toLowerCase() === "profiles" &&
    fs.existsSync(path.join(path.dirname(selected), "config", "accounts.json"))
  ) {
    return { root: path.dirname(selected), selectedProfilesDirectory: true };
  }
  return { root: selected, selectedProfilesDirectory: false };
}

function nearestExistingDirectory(value) {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw Object.assign(new Error("找不到目标数据卷"), { code: "TARGET_VOLUME_UNAVAILABLE" });
    current = parent;
  }
  return fs.statSync(current).isDirectory() ? current : path.dirname(current);
}

function availableBytes(targetDataRoot) {
  if (typeof fs.statfsSync !== "function") return null;
  const stats = fs.statfsSync(nearestExistingDirectory(targetDataRoot));
  return Number(stats.bavail) * Number(stats.bsize);
}

function profileLocks(root) {
  const locks = [];
  for (const collection of ["profiles", "profiles-archive"]) {
    const collectionRoot = path.join(root, collection);
    if (!fs.existsSync(collectionRoot)) continue;
    for (const entry of fs.readdirSync(collectionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const profileRoot = path.join(collectionRoot, entry.name);
      const names = fs.readdirSync(profileRoot);
      const found = names.filter((name) => PROFILE_LOCK_NAMES.test(name));
      if (found.length) locks.push({ collection, name: entry.name, files: found.sort() });
    }
  }
  return locks;
}

try {
  const selected = normalizeLegacyRoot(argument("--legacy-root"));
  const targetDataRoot = argument("--data-root");
  if (!targetDataRoot) {
    throw Object.assign(new Error("缺少 --data-root"), { code: "INVALID_TARGET_ROOT" });
  }
  const plan = buildLegacyMigrationPlan(selected.root);
  const requiredBytes = requiredFreeBytes(plan.totalProfileBytes);
  const freeBytes = availableBytes(targetDataRoot);
  const locks = profileLocks(selected.root);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceRoot: plan.sourceRoot,
    selectedProfilesDirectory: selected.selectedProfilesDirectory,
    sourceFingerprint: plan.sourceFingerprint,
    counts: plan.counts,
    totalProfileBytes: plan.totalProfileBytes,
    requiredBytes,
    availableBytes: freeBytes,
    enoughSpace: freeBytes == null ? null : freeBytes >= requiredBytes,
    requiresTrashDecision: plan.requiresTrashDecision,
    activeLocks: locks,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: String(error?.code || "MIGRATION_PROBE_FAILED"),
      message: String(error?.message || error),
    },
  })}\n`);
  process.exitCode = 1;
}
