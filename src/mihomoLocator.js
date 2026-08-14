import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CORE_NAMES =
  process.platform === "win32"
    ? ["verge-mihomo.exe", "mihomo.exe", "verge-mihomo-alpha.exe"]
    : ["verge-mihomo", "mihomo", "verge-mihomo-alpha"];

const APP_DIRECTORY_NAMES = [
  "Clash Verge",
  "Clash Verge Rev",
  "Clash.Verge",
  "clash-verge",
  "clash-verge-rev",
];

const CORE_SUBDIRECTORIES = [
  "",
  "bin",
  "resources",
  path.join("resources", "bin"),
  path.join("resources", "resources"),
];

let registryCache = { checkedAt: 0, directories: [] };
const REGISTRY_CACHE_MS = 30_000;
const MAX_SCAN_DIRECTORIES = 256;
const MAX_SCAN_ENTRIES = 5_000;

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function expandEnvironmentVariables(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? env[key] : whole;
  });
}

function cleanConfiguredPath(value, projectRoot, env) {
  if (!value) return null;
  let cleaned = expandEnvironmentVariables(String(value).trim(), env);
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned) return null;
  return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(projectRoot, cleaned);
}

function isUsableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function coreCandidates(directory) {
  const result = [];
  for (const subdirectory of CORE_SUBDIRECTORIES) {
    for (const name of CORE_NAMES) {
      result.push(path.join(directory, subdirectory, name));
    }
  }
  return result;
}

function findCoreInDirectory(directory, maxDepth = 3) {
  if (!directory) return null;
  try {
    if (!fs.statSync(directory).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const candidate of coreCandidates(directory)) {
    if (isUsableFile(candidate)) return candidate;
  }

  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory === path.parse(resolvedDirectory).root) return null;

  // Clash Verge 的打包结构会随版本变化。只在已识别的应用目录内做有限深度查找，
  // 并限制目录和条目数量，避免用户误填磁盘根目录或宽泛目录时阻塞服务。
  const wanted = new Set(CORE_NAMES.map((name) => name.toLowerCase()));
  const queue = [{ directory, depth: 0 }];
  let scannedDirectories = 0;
  let scannedEntries = 0;
  while (
    queue.length &&
    scannedDirectories < MAX_SCAN_DIRECTORIES &&
    scannedEntries < MAX_SCAN_ENTRIES
  ) {
    const current = queue.shift();
    scannedDirectories++;
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++scannedEntries > MAX_SCAN_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current.directory, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase()) && isUsableFile(full)) {
        return full;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ directory: full, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

export function findMihomoInDirectory(
  directory,
  { projectRoot = process.cwd(), env = process.env } = {}
) {
  const configuredDirectory = cleanConfiguredPath(directory, projectRoot, env);
  if (!configuredDirectory) return null;
  return findCoreInDirectory(configuredDirectory);
}

export function validateMihomoExecutable(
  executable,
  { runner = spawnSync, timeoutMs = 5_000 } = {}
) {
  let result;
  try {
    result = runner(executable, ["-v"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  }

  if (result?.error) {
    return { ok: false, message: String(result.error.message || result.error) };
  }
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
  if (result?.status !== 0) {
    return {
      ok: false,
      message: output || `版本检查退出码为 ${result?.status ?? "未知"}`,
    };
  }
  if (!/\b(?:mihomo|clash meta)\b/i.test(output)) {
    return { ok: false, message: "文件没有返回可识别的 Mihomo 版本信息" };
  }
  return { ok: true, version: output.split(/\r?\n/)[0] };
}

function registryCommandPath(env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  return systemRoot ? path.join(systemRoot, "System32", "reg.exe") : "reg.exe";
}

function runRegistry(args, env) {
  try {
    return execFileSync(registryCommandPath(env), args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    return typeof error?.stdout === "string" ? error.stdout : "";
  }
}

function registryValue(output, name) {
  const pattern = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "im");
  return output.match(pattern)?.[1] ?? null;
}

function executableDirectory(value) {
  if (!value) return null;
  const cleaned = value.trim();
  const quoted = cleaned.match(/^"([^"]+\.exe)"/i);
  const unquoted = cleaned.match(/^(.+?\.exe)(?:,\d+|\s+.*)?$/i);
  const executable = quoted?.[1] ?? unquoted?.[1];
  return executable ? path.dirname(executable) : null;
}

function normalizedRegistryDirectory(value) {
  if (!value) return null;
  const cleaned = value.trim().replace(/^"(.*)"$/, "$1");
  if (!cleaned) return null;
  return /\.exe(?:,\d+)?$/i.test(cleaned)
    ? executableDirectory(cleaned)
    : path.normalize(cleaned);
}

export function discoverClashVergeInstallDirectories({
  env = process.env,
  platform = process.platform,
  now = Date.now(),
} = {}) {
  if (platform !== "win32") return [];
  if (now - registryCache.checkedAt < REGISTRY_CACHE_MS) {
    return [...registryCache.directories];
  }

  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const keys = new Set();
  for (const root of roots) {
    const output = runRegistry(["query", root, "/s", "/f", "Clash Verge", "/d"], env);
    for (const line of output.split(/\r?\n/)) {
      const key = line.trim();
      if (/^HKEY_/i.test(key)) keys.add(key);
    }
  }

  const directories = [];
  for (const key of keys) {
    const output = runRegistry(["query", key], env);
    const displayName = registryValue(output, "DisplayName");
    if (!/Clash[\s.]?Verge/i.test(displayName ?? "")) continue;

    directories.push(normalizedRegistryDirectory(registryValue(output, "InstallLocation")));
    directories.push(executableDirectory(registryValue(output, "DisplayIcon")));
    directories.push(executableDirectory(registryValue(output, "UninstallString")));
  }

  registryCache = {
    checkedAt: now,
    directories: uniquePaths(directories),
  };
  return [...registryCache.directories];
}

export function platformInstallDirectories({
  platform = process.platform,
  env = process.env,
  homeDir = env.HOME || env.USERPROFILE || "",
} = {}) {
  if (platform === "darwin") {
    return uniquePaths([
      "/Applications/Clash Verge.app/Contents/MacOS",
      "/Applications/Clash Verge Rev.app/Contents/MacOS",
      homeDir ? path.join(homeDir, "Applications", "Clash Verge.app", "Contents", "MacOS") : null,
      homeDir ? path.join(homeDir, "Applications", "Clash Verge Rev.app", "Contents", "MacOS") : null,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  }
  if (platform === "linux") {
    return uniquePaths([
      "/usr/local/bin",
      "/usr/bin",
      "/opt/mihomo",
      "/opt/clash-verge",
      "/opt/clash-verge-rev",
      homeDir ? path.join(homeDir, ".local", "bin") : null,
      homeDir ? path.join(homeDir, ".local", "share", "clash-verge") : null,
    ]);
  }

  const programRoots = uniquePaths([
    env.ProgramFiles,
    env.PROGRAMFILES,
    env.ProgramW6432,
    env.PROGRAMW6432,
    env["ProgramFiles(x86)"],
    env["PROGRAMFILES(X86)"],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : null,
    env.LOCALAPPDATA,
  ]);
  const directories = [];
  for (const root of programRoots) {
    for (const name of APP_DIRECTORY_NAMES) directories.push(path.join(root, name));
  }

  if (env.USERPROFILE) {
    for (const name of ["clash-verge", "clash-verge-rev"]) {
      directories.push(path.join(env.USERPROFILE, "scoop", "apps", name, "current"));
    }
  }
  return uniquePaths(directories);
}

function environmentInstallDirectories(env) {
  return platformInstallDirectories({ env });
}

function pathDirectories(env) {
  return uniquePaths(String(env.PATH || env.Path || "").split(path.delimiter));
}

export function findMihomoExecutable({
  configuredPath = null,
  configuredInstallDir = null,
  projectRoot = process.cwd(),
  env = process.env,
  registryInstallDirs,
} = {}) {
  const configured = cleanConfiguredPath(configuredPath, projectRoot, env);
  if (configured) {
    if (isUsableFile(configured)) return configured;
    const found = findCoreInDirectory(configured);
    if (found) return found;
  }

  const configuredDirectoryCore = findMihomoInDirectory(configuredInstallDir, {
    projectRoot,
    env,
  });
  if (configuredDirectoryCore) return configuredDirectoryCore;

  const projectBin = path.join(projectRoot, "bin");
  const projectCore = findCoreInDirectory(projectBin, 1);
  if (projectCore) return projectCore;

  for (const directory of environmentInstallDirectories(env)) {
    const found = findCoreInDirectory(directory);
    if (found) return found;
  }

  for (const directory of pathDirectories(env)) {
    for (const name of CORE_NAMES) {
      const candidate = path.join(directory, name);
      if (isUsableFile(candidate)) return candidate;
    }
  }

  const discoveredDirectories = process.platform === "win32"
    ? registryInstallDirs ?? discoverClashVergeInstallDirectories({ env })
    : registryInstallDirs ?? [];
  for (const directory of uniquePaths(discoveredDirectories)) {
    const found = findCoreInDirectory(directory);
    if (found) return found;
  }
  return null;
}
