import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), "..");

function configuredRoot(environmentName, fallback) {
  const value = process.env[environmentName];
  if (!value) return fallback;
  if (!path.isAbsolute(value)) {
    throw new Error(`${environmentName} 必须是绝对路径`);
  }
  return path.resolve(value);
}

// The legacy CLI leaves these variables unset, preserving the historical
// source-tree layout. The installed per-user Agent sets them before importing
// browser/store/proxy modules, keeping every mutable byte out of the versioned
// application directory.
export const DATA_ROOT = configuredRoot("GPT_ACCOUNT_KEEPER_DATA_ROOT", ROOT);
export const CACHE_ROOT = configuredRoot("GPT_ACCOUNT_KEEPER_CACHE_ROOT", ROOT);
export const STATE_ROOT = configuredRoot("GPT_ACCOUNT_KEEPER_STATE_ROOT", ROOT);

export function fromRoot(...segs) {
  return path.join(DATA_ROOT, ...segs);
}

export function fromInstallRoot(...segs) {
  return path.join(ROOT, ...segs);
}

export function fromCacheRoot(...segs) {
  return path.join(CACHE_ROOT, ...segs);
}

export function fromStateRoot(...segs) {
  return path.join(STATE_ROOT, ...segs);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(relPath) {
  const abs = fromRoot(relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

/**
 * 读取随程序分发的只读资源（例如 config/selectors.json）。
 *
 * 这类文件不是用户数据：它跟着版本走，升级时应该被新版本替换。早先它用 readJson
 * 从 DATA_ROOT 读，在 CLI 模式下 DATA_ROOT 恰好等于源码根目录所以看不出问题，
 * 但安装后的 Agent 把 DATA_ROOT 指向 %LOCALAPPDATA% 数据目录，于是"打开网页"和
 * "登录"都会以 ENOENT 失败（自动对话用的是 fromInstallRoot，反而是对的）。
 *
 * 解析顺序：数据目录里的同名文件优先（迁移带过来的用户自定义覆盖），
 * 否则回落到安装目录的默认值。
 */
export function readResourceJson(relPath) {
  const override = fromRoot(relPath);
  // DATA_ROOT 与 ROOT 相同时（CLI/开发模式）只需读一次。
  if (override !== fromInstallRoot(relPath) && fs.existsSync(override)) {
    return JSON.parse(fs.readFileSync(override, "utf8"));
  }
  return JSON.parse(fs.readFileSync(fromInstallRoot(relPath), "utf8"));
}
