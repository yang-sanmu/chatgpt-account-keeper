import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * sockaddr_un.sun_path 的硬上限：Darwin 104 字节，Linux 108（都含结尾 NUL）。
 * 超限时 bind/connect 报的是 EINVAL 或静默截断，不会说"路径太长"，所以宁可
 * 自己先报一个能看懂的错。
 */
const SUN_PATH_LIMIT = { darwin: 104, linux: 108, default: 104 };

export function unixSocketPathLimit(platform = process.platform) {
  return SUN_PATH_LIMIT[platform] ?? SUN_PATH_LIMIT.default;
}

/**
 * macOS 的 os.tmpdir() 是每用户长路径（/var/folders/xx/<32 字符哈希>/T，约 50
 * 字节），拼上带 uid 和数据根哈希的文件名后只剩个位数余量 —— 用户名更长或
 * 以后多一段后缀就会直接崩。所以 darwin 上优先用 /tmp：它短、稳定、按 uid
 * 区分文件名后不同用户不会撞。
 */
function defaultRuntimeDirectory(platform) {
  if (platform === "darwin") return "/tmp";
  return os.tmpdir();
}

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
    defaultRuntimeDirectory(platform);
  // path.posix, not the host path: a Unix socket path is always posix, and on a
  // Windows host path.join would emit backslashes for a darwin/linux endpoint.
  const endpoint = path.posix.join(
    runtimeDir.replace(/\\/g, "/"),
    `gptaccountkeeper-agent-v1-${uid}${dataSuffix}.sock`
  );
  assertUnixSocketPathFits(endpoint, platform);
  return endpoint;
}

export function assertUnixSocketPathFits(endpoint, platform = process.platform) {
  if (platform === "win32") return endpoint;
  const limit = unixSocketPathLimit(platform);
  // 按字节算，不按字符：非 ASCII 的用户名或目录名会占多个字节。
  const length = Buffer.byteLength(endpoint, "utf8");
  if (length >= limit) {
    throw new Error(
      `IPC socket 路径超出系统上限（${length} >= ${limit} 字节）：${endpoint}。` +
        "请把数据目录或运行目录换到更短的路径，或设置 XDG_RUNTIME_DIR。"
    );
  }
  return endpoint;
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
