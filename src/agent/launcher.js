#!/usr/bin/env node
import path from "node:path";
import { dataRootFromArgs } from "./endpoint.js";
import { resolvePlatformPaths } from "../persistence/platformPaths.js";

const requestedDataRoot = dataRootFromArgs();
const paths = resolvePlatformPaths({ dataRoot: requestedDataRoot });

// Set every mutable root before importing the legacy automation modules. ESM
// evaluates static imports before main(), so this tiny launcher is the boundary
// that makes an installed version directory safely read-only.
process.env.GPT_ACCOUNT_KEEPER_DATA_ROOT = paths.dataRoot;
process.env.GPT_ACCOUNT_KEEPER_CACHE_ROOT ||= paths.cacheRoot;
process.env.GPT_ACCOUNT_KEEPER_STATE_ROOT ||= paths.stateRoot;
process.env.GPT_ACCOUNT_KEEPER_RUNTIME_ROOT ||= paths.runtimeRoot;
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", () => {
    // Desktop may crash or update while the detached Agent stays alive.
  });
}

try {
  await import("./main.js");
} catch (error) {
  console.error(`Agent 启动器失败：${String(error?.stack || error)}`);
  process.exitCode = 1;
}
