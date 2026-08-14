#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const packageFile = path.resolve(process.argv[2] ?? "");
const lockFile = path.resolve(process.argv[3] ?? "");
const version = process.argv[4] ?? "";

if (
  !process.argv[2] ||
  !process.argv[3] ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
) {
  console.error("usage: node stamp-agent-version.mjs <package.json> <package-lock.json> <semver>");
  process.exit(2);
}

const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const packageLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
if (!packageLock.packages?.[""]) {
  throw new Error("package-lock.json is missing its root package entry");
}

packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
fs.writeFileSync(lockFile, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
