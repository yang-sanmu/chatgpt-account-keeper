import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export function currentUserEndpoint(options = {}) {
  const platform = options.platform ?? process.platform;
  const dataRoot = options.dataRoot ? canonicalDataRoot(options.dataRoot, platform) : null;
  const dataSuffix = dataRoot
    ? `-${createHash("sha256").update(dataRoot).digest("hex").slice(0, 16)}`
    : "";
  if (platform === "win32") {
    const identity = options.identity ?? `${process.env.USERDOMAIN || ""}\\${os.userInfo().username}`;
    const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\gptaccountkeeper-agent-v1-${suffix}${dataSuffix}`;
  }
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : os.userInfo().username);
  const runtimeDir =
    options.runtimeDir ??
    process.env.XDG_RUNTIME_DIR ??
    os.tmpdir();
  return path.join(runtimeDir, `gptaccountkeeper-agent-v1-${uid}${dataSuffix}.sock`);
}

export function canonicalDataRoot(dataRoot, platform = process.platform) {
  const canonical = path.resolve(String(dataRoot));
  return platform === "win32" ? canonical.toUpperCase() : canonical;
}

export function endpointFromArgs(argv = process.argv.slice(2), env = process.env) {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--endpoint") {
      const value = argv[index + 1];
      if (!value) throw new Error("--endpoint 需要路径参数");
      return value;
    }
    if (argument.startsWith("--endpoint=")) {
      const value = argument.slice("--endpoint=".length);
      if (!value) throw new Error("--endpoint 需要路径参数");
      return value;
    }
  }
  return env.GPT_ACCOUNT_KEEPER_ENDPOINT || currentUserEndpoint({
    dataRoot: dataRootFromArgs(argv, env),
  });
}

export function dataRootFromArgs(argv = process.argv.slice(2), env = process.env) {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--data-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--data-root 需要路径参数");
      return value;
    }
    if (argument.startsWith("--data-root=")) {
      const value = argument.slice("--data-root=".length);
      if (!value) throw new Error("--data-root 需要路径参数");
      return value;
    }
  }
  return env.GPT_ACCOUNT_KEEPER_DATA_ROOT || null;
}

export function legacyRootFromArgs(argv = process.argv.slice(2), env = process.env) {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--legacy-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--legacy-root 需要路径参数");
      return value;
    }
    if (argument.startsWith("--legacy-root=")) {
      const value = argument.slice("--legacy-root=".length);
      if (!value) throw new Error("--legacy-root 需要路径参数");
      return value;
    }
  }
  return env.GPT_ACCOUNT_KEEPER_LEGACY_ROOT || null;
}
