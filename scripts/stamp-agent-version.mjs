#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function stampAgentVersion(packageFile, lockFile, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }

  const resolvedPackageFile = path.resolve(packageFile);
  const resolvedLockFile = path.resolve(lockFile);
  const packageJson = JSON.parse(fs.readFileSync(resolvedPackageFile, "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(resolvedLockFile, "utf8"));
  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json is missing its root package entry");
  }

  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  fs.writeFileSync(resolvedPackageFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  fs.writeFileSync(resolvedLockFile, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
    console.error("usage: node stamp-agent-version.mjs <package.json> <package-lock.json> <semver>");
    process.exit(2);
  }
  stampAgentVersion(process.argv[2], process.argv[3], process.argv[4]);
}
