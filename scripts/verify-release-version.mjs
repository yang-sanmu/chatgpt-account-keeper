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
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const project = fs.readFileSync(
    path.join(root, "desktop", "src", "GptAccountKeeper.Desktop", "GptAccountKeeper.Desktop.csproj"),
    "utf8",
  );
  const projectVersion = project.match(/<Version>([^<]+)<\/Version>/)?.[1];
  const versions = {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "package-lock root": packageLock.packages?.[""]?.version,
    "desktop csproj": projectVersion,
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) {
    console.error("usage: node scripts/verify-release-version.mjs <semver>");
    process.exit(2);
  }
  verifyReleaseVersion(process.argv[2]);
  console.log(`Committed release metadata agrees on ${process.argv[2]}.`);
}
