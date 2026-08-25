#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export function verifyReleaseVersion(expectedVersion, root = repositoryRoot) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion ?? "")) {
    throw new Error(`Invalid release version: ${expectedVersion ?? ""}`);
  }
  const appRoot = path.join(root, "app");
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(appRoot, "package-lock.json"), "utf8"));
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const cargoToml = fs.readFileSync(path.join(appRoot, "src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = readCargoPackageVersion(cargoToml);
  const versions = {
    "app/package.json": packageJson.version,
    "app/package-lock.json": packageLock.version,
    "app/package-lock root": packageLock.packages?.[""]?.version,
    "app/src-tauri/tauri.conf.json": tauriConfig.version,
    "app/src-tauri/Cargo.toml": cargoVersion,
  };
  const mismatches = Object.entries(versions).filter(([, version]) => version !== expectedVersion);
  if (mismatches.length > 0) {
    throw new Error(
      `Release version ${expectedVersion} does not match committed metadata:\n` +
        mismatches.map(([label, version]) => `  ${label}: ${version ?? "<missing>"}`).join("\n"),
    );
  }
  return versions;
}

function readCargoPackageVersion(cargoToml) {
  const lines = cargoToml.split(/\r?\n/);
  const packageIndex = lines.findIndex((line) => line.trim() === "[package]");
  if (packageIndex < 0) return undefined;
  for (const line of lines.slice(packageIndex + 1)) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) return undefined;
    const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/)?.[1];
    if (version) return version;
  }
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) {
    console.error("usage: node scripts/verify-release-version.mjs <semver>");
    process.exit(2);
  }
  verifyReleaseVersion(process.argv[2]);
  console.log(`Committed release metadata agrees on ${process.argv[2]}.`);
}
