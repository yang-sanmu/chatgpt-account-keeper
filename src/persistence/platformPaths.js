import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BOOTSTRAP_VERSION = 1;
export const APP_DIRECTORY_NAME = "GptAccountKeeper";

/**
 * 这些函数都接受 platform 参数，但如果内部用宿主的 path，参数就是假的：
 * 在 Linux 上传 platform: "win32" 会把 `C:\Users\...` 当成相对路径拼到 cwd 后面。
 * 生产环境里 platform 恒等于 process.platform，所以按 platform 选 path 风味
 * 不改变任何线上行为，只是让"为另一个平台计算路径"真的成立 —— 否则 Windows
 * 布局的断言只能在 Windows 上跑。
 */
function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function requiredHome(homeDir, platform = process.platform) {
  const p = pathFor(platform);
  const value = p.resolve(String(homeDir || ""));
  if (!homeDir || value === p.parse(value).root) {
    throw new Error("无法确定当前用户的主目录");
  }
  return value;
}

/**
 * Resolve per-user application paths without creating anything on disk.
 */
export function resolvePlatformPaths({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  dataRoot = null,
} = {}) {
  const p = pathFor(platform);
  const home = requiredHome(homeDir, platform);
  let defaultDataRoot;
  let bootstrapFile;
  let cacheRoot;
  let runtimeRoot;
  let stateRoot;

  if (platform === "win32") {
    const local = p.resolve(env.LOCALAPPDATA || p.join(home, "AppData", "Local"));
    const roaming = p.resolve(env.APPDATA || p.join(home, "AppData", "Roaming"));
    defaultDataRoot = p.join(local, APP_DIRECTORY_NAME, "data");
    bootstrapFile = p.join(roaming, APP_DIRECTORY_NAME, "bootstrap.json");
    cacheRoot = p.join(local, APP_DIRECTORY_NAME, "cache");
    runtimeRoot = p.join(local, APP_DIRECTORY_NAME, "run");
    stateRoot = p.join(local, APP_DIRECTORY_NAME, "state");
  } else if (platform === "darwin") {
    const support = p.join(home, "Library", "Application Support", APP_DIRECTORY_NAME);
    defaultDataRoot = support;
    bootstrapFile = p.join(support, "bootstrap.json");
    cacheRoot = p.join(home, "Library", "Caches", APP_DIRECTORY_NAME);
    runtimeRoot = p.join(cacheRoot, "run");
    stateRoot = p.join(support, "state");
  } else {
    const xdgData = p.resolve(env.XDG_DATA_HOME || p.join(home, ".local", "share"));
    const xdgConfig = p.resolve(env.XDG_CONFIG_HOME || p.join(home, ".config"));
    const xdgCache = p.resolve(env.XDG_CACHE_HOME || p.join(home, ".cache"));
    const xdgState = p.resolve(env.XDG_STATE_HOME || p.join(home, ".local", "state"));
    defaultDataRoot = p.join(xdgData, "gpt-account-keeper");
    bootstrapFile = p.join(xdgConfig, "gpt-account-keeper", "bootstrap.json");
    cacheRoot = p.join(xdgCache, "gpt-account-keeper");
    stateRoot = p.join(xdgState, "gpt-account-keeper");
    runtimeRoot = env.XDG_RUNTIME_DIR
      ? p.join(p.resolve(env.XDG_RUNTIME_DIR), "gpt-account-keeper")
      : p.join(cacheRoot, "run");
  }

  const resolvedDataRoot = dataRoot ? p.resolve(dataRoot) : defaultDataRoot;
  return Object.freeze({
    dataRoot: resolvedDataRoot,
    databaseFile: p.join(resolvedDataRoot, "keeper.db"),
    profilesRoot: p.join(resolvedDataRoot, "profiles"),
    profilesArchiveRoot: p.join(resolvedDataRoot, "profiles-archive"),
    profileTrashRoot: p.join(resolvedDataRoot, "profile-trash"),
    backupsRoot: p.join(resolvedDataRoot, "backups"),
    migrationRoot: p.join(resolvedDataRoot, "migration"),
    // 单实例锁跟着数据目录走：同一份数据库和 Profile 只允许一个 Agent 写。
    instanceLockFile: p.join(resolvedDataRoot, "agent.lock"),
    bootstrapFile,
    cacheRoot,
    runtimeRoot,
    stateRoot,
  });
}

function canonicalForComparison(value, platform) {
  const resolved = pathFor(platform).resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathWithin(candidate, parent, { platform = process.platform } = {}) {
  const p = pathFor(platform);
  const child = canonicalForComparison(candidate, platform);
  const root = canonicalForComparison(parent, platform);
  const relative = p.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative));
}

function existingRealPath(value, fsImpl, platform = process.platform) {
  const p = pathFor(platform);
  const absolute = p.resolve(value);
  let existing = absolute;
  const missingSegments = [];
  while (!fsImpl.existsSync(existing)) {
    const parent = p.dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(p.basename(existing));
    existing = parent;
  }
  const real = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(existing)
    : fsImpl.realpathSync(existing);
  return p.join(real, ...missingSegments);
}

/**
 * Reject unsafe/custom data roots before any directory is created.
 * volumeInfo is deliberately injected: platform installers can use GetDriveType/statfs
 * without making this pure validation module spawn platform-specific commands.
 */
export function validateDataRoot(
  candidate,
  {
    platform = process.platform,
    installRoot = null,
    legacyRoot = null,
    fsImpl = fs,
    volumeInfo = null,
  } = {}
) {
  if (typeof candidate !== "string" || !candidate.trim() || candidate.includes("\0")) {
    throw new Error("数据目录不能为空");
  }
  const p = pathFor(platform);
  const trimmed = candidate.trim();
  // UNC 必须先判：posix 的 isAbsolute 认为 `\\server\share` 是相对路径，
  // 顺序反了会把网络共享报成"必须是绝对路径"，掩盖真正的原因。
  if (platform === "win32" && /^(?:\\\\|\/\/)/.test(trimmed)) {
    throw new Error("数据目录不能位于 UNC/网络共享");
  }
  if (!p.isAbsolute(trimmed)) throw new Error("数据目录必须是绝对路径");

  const resolved = existingRealPath(trimmed, fsImpl, platform);
  if (resolved === p.parse(resolved).root) throw new Error("数据目录不能是文件系统根目录");

  for (const [label, forbidden] of [
    ["安装目录", installRoot],
    ["旧源码目录", legacyRoot],
  ]) {
    if (!forbidden) continue;
    const actualForbidden = existingRealPath(forbidden, fsImpl, platform);
    if (
      isPathWithin(resolved, actualForbidden, { platform }) ||
      isPathWithin(actualForbidden, resolved, { platform })
    ) {
      throw new Error(`数据目录不能与${label}相同、包含或被其包含`);
    }
  }

  if (volumeInfo) {
    if (volumeInfo.isNetwork === true || volumeInfo.isLocalFixed === false) {
      throw new Error("数据目录必须位于本地固定磁盘");
    }
  }
  return resolved;
}

export function parseBootstrapPointer(
  text,
  { platform = process.platform, installRoot = null, legacyRoot = null, fsImpl = fs, volumeInfo = null } = {}
) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`bootstrap.json 不是有效 JSON：${error.message}`, { cause: error });
  }
  if (!parsed || Array.isArray(parsed) || parsed.version !== BOOTSTRAP_VERSION) {
    throw new Error("bootstrap.json 版本不受支持");
  }
  const dataRoot = validateDataRoot(parsed.dataRoot, {
    platform,
    installRoot,
    legacyRoot,
    fsImpl,
    volumeInfo,
  });
  return Object.freeze({ version: BOOTSTRAP_VERSION, dataRoot });
}

export function readBootstrapPointer(
  bootstrapFile,
  { fsImpl = fs, ...validationOptions } = {}
) {
  if (!fsImpl.existsSync(bootstrapFile)) return null;
  return parseBootstrapPointer(fsImpl.readFileSync(bootstrapFile, "utf8"), {
    ...validationOptions,
    fsImpl,
  });
}

/** Explicit write; importing this module never creates or changes files. */
export function writeBootstrapPointer(
  bootstrapFile,
  dataRoot,
  { fsImpl = fs, ...validationOptions } = {}
) {
  const validated = validateDataRoot(dataRoot, { ...validationOptions, fsImpl });
  const directory = path.dirname(path.resolve(bootstrapFile));
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(bootstrapFile)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fsImpl.writeFileSync(
      temporary,
      JSON.stringify({ version: BOOTSTRAP_VERSION, dataRoot: validated }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    fsImpl.renameSync(temporary, bootstrapFile);
  } finally {
    try {
      fsImpl.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return Object.freeze({ version: BOOTSTRAP_VERSION, dataRoot: validated });
}
