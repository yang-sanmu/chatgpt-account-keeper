import fs from "node:fs";
import path from "node:path";
import { fromRoot, ensureDir } from "./paths.js";
import { isBusy, isHeld } from "./locks.js";
import { renamePathSync } from "./atomicFile.js";

const SERVICE_WORKER_CACHE_PATH = ["Default", "Service Worker", "CacheStorage"];
const CACHE_PATHS = [
  ["Default", "Cache"],
  ["Default", "Code Cache"],
  ["Default", "GPUCache"],
  ["Default", "DawnGraphiteCache"],
  ["Default", "DawnWebGPUCache"],
  SERVICE_WORKER_CACHE_PATH,
  ["GrShaderCache"],
  ["ShaderCache"],
  ["GPUPersistentCache"],
  ["component_crx_cache"],
  ["extensions_crx_cache"],
];
const AUTOMATIC_CACHE_PATHS = CACHE_PATHS.filter(
  (parts) => parts !== SERVICE_WORKER_CACHE_PATH
);

const BROWSER_LOCK_NAMES = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);

export class ProfileOperationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ProfileOperationError";
    this.statusCode = statusCode;
  }
}

function statTree(root) {
  const out = { bytes: 0, files: 0 };
  if (!fs.existsSync(root)) return out;

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          continue;
        } else if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          out.bytes += fs.statSync(full).size;
          out.files++;
        }
        // 不跟随符号链接或 junction，避免扫描越过 Profile 边界。
      } catch {
        // 文件可能在 Chromium 退出过程中消失，跳过本项即可。
      }
    }
  }
  return out;
}

function statProfile(root) {
  const out = { bytes: 0, files: 0, cacheBytes: 0, cacheFiles: 0 };
  if (!fs.existsSync(root)) return out;

  const normalizePart = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const cachePrefixes = CACHE_PATHS.map((parts) => parts.map(normalizePart));
  const isCachePath = (parts) =>
    cachePrefixes.some(
      (prefix) =>
        parts.length >= prefix.length &&
        prefix.every((part, index) => normalizePart(parts[index]) === part)
    );

  const stack = [{ directory: root, parts: [], inCache: false }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current.directory, entry.name);
      const parts = [...current.parts, entry.name];
      const inCache = current.inCache || isCachePath(parts);
      try {
        if (entry.isDirectory()) {
          stack.push({ directory: full, parts, inCache });
        } else if (entry.isFile()) {
          const size = fs.statSync(full).size;
          out.bytes += size;
          out.files++;
          if (inCache) {
            out.cacheBytes += size;
            out.cacheFiles++;
          }
        }
      } catch {
        // 文件可能在 Chromium 退出过程中消失，跳过本项即可。
      }
    }
  }
  return out;
}

function isPathInside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeName(value) {
  const clean = String(value || "profile").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return clean.replace(/^[._-]+|[._-]+$/g, "") || "profile";
}

function timestampSlug() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function uniqueDestination(root, base) {
  let candidate = path.join(root, base);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(root, `${base}_${n++}`);
  return candidate;
}

export function createProfileManager({
  // workspaceRoot 是账号 profileDir 相对路径的解析基准，必须与 profilesRoot 同根。
  // 早先默认成安装根 ROOT，而单例传的 profilesRoot 在数据根下，安装布局中两者
  // 分离后每个账号的 Profile 都会被判为越界。默认值在这里帮不上忙，只会掩盖错配。
  workspaceRoot,
  profilesRoot = path.join(workspaceRoot, "profiles"),
  archiveRoot = path.join(workspaceRoot, "profiles-archive"),
  trashRoot = path.join(workspaceRoot, ".profile-trash"),
  accountBusy = (id) => isBusy(id) || isHeld(id),
} = {}) {
  if (!workspaceRoot) {
    throw new TypeError("createProfileManager 需要 workspaceRoot（账号 profileDir 的解析基准）");
  }
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedProfiles = path.resolve(profilesRoot);
  const resolvedArchive = path.resolve(archiveRoot);
  const resolvedTrash = path.resolve(trashRoot);
  // 错配会让所有账号 Profile 操作失败，且症状（"不在 profiles 直接子目录中"）
  // 完全指不到真正的原因。启动时就断言，而不是等用户点删除。
  if (!isPathInside(resolvedWorkspace, resolvedProfiles)) {
    throw new TypeError(
      `profilesRoot（${resolvedProfiles}）必须位于 workspaceRoot（${resolvedWorkspace}）之内`
    );
  }

  function pathKey(value) {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function directProfilePath(name) {
    const raw = String(name ?? "");
    if (!raw || raw === "." || raw === ".." || path.basename(raw) !== raw) {
      throw new ProfileOperationError("Profile 名称不合法");
    }
    const target = path.resolve(resolvedProfiles, raw);
    if (path.dirname(target) !== resolvedProfiles) {
      throw new ProfileOperationError("Profile 路径不在允许的目录中");
    }
    return target;
  }

  function accountProfilePath(account) {
    const target = path.resolve(resolvedWorkspace, String(account?.profileDir ?? ""));
    if (
      !isPathInside(resolvedProfiles, target) ||
      pathKey(path.dirname(target)) !== pathKey(resolvedProfiles)
    ) {
      throw new ProfileOperationError("账号 Profile 路径不在 profiles 直接子目录中");
    }
    return target;
  }

  function assertRealDirectory(target) {
    if (!fs.existsSync(target)) return false;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProfileOperationError("目标不是可管理的 Profile 目录");
    }
    return true;
  }

  function hasBrowserLock(target) {
    try {
      return fs
        .readdirSync(target, { withFileTypes: true })
        .some((entry) => BROWSER_LOCK_NAMES.has(entry.name));
    } catch {
      return false;
    }
  }

  function assertAvailable(target, accountIds = null) {
    const ids = Array.isArray(accountIds) ? accountIds : accountIds ? [accountIds] : [];
    if (ids.some((id) => accountBusy(id))) {
      throw new ProfileOperationError("该账号正在使用中，请先关闭窗口或等待任务结束", 409);
    }
    if (hasBrowserLock(target)) {
      throw new ProfileOperationError("浏览器仍在占用该 Profile，请先关闭相关窗口", 409);
    }
  }

  function assertCachePathIsLocal(profilePath, cachePath) {
    const relative = path.relative(profilePath, cachePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ProfileOperationError("缓存路径越过 Profile 边界");
    }

    let current = profilePath;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) return;
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new ProfileOperationError(
          "缓存路径包含符号链接或目录联接，为避免误删外部文件已跳过",
          409
        );
      }
    }
  }

  function accountMap(accounts) {
    const byPath = new Map();
    let protectAll = false;
    for (const account of accounts ?? []) {
      const configured = path.resolve(resolvedWorkspace, String(account?.profileDir ?? ""));
      if (pathKey(configured) === pathKey(resolvedProfiles)) {
        // 极端旧配置若直接指向 profiles 根目录，保守保护所有子目录。
        protectAll = true;
        continue;
      }
      if (!isPathInside(resolvedProfiles, configured)) continue;

      // 标准路径直接映射；嵌套旧路径也保护它所属的顶层目录，绝不误报为孤儿。
      const relative = path.relative(resolvedProfiles, configured);
      const topName = relative.split(path.sep)[0];
      if (!topName) continue;
      let topPath;
      try {
        topPath = directProfilePath(topName);
      } catch {
        continue;
      }
      const key = pathKey(topPath);
      const list = byPath.get(key) ?? [];
      list.push({
        ...account,
        nonStandardProfilePath: pathKey(configured) !== pathKey(topPath),
      });
      byPath.set(key, list);
    }
    return { byPath, protectAll };
  }

  function scan(accounts = []) {
    const { byPath: linkedByPath, protectAll } = accountMap(accounts);
    const profiles = [];
    if (fs.existsSync(resolvedProfiles)) {
      for (const entry of fs.readdirSync(resolvedProfiles, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const full = directProfilePath(entry.name);
        const linkedAccounts = protectAll ? accounts : linkedByPath.get(pathKey(full)) ?? [];
        const stats = statProfile(full);
        profiles.push({
          name: entry.name,
          linked: linkedAccounts.length > 0,
          accountIds: linkedAccounts.map((account) => account.id),
          nonStandardReference: linkedAccounts.some((account) => account.nonStandardProfilePath),
          busy: linkedAccounts.some((account) => accountBusy(account.id)) || hasBrowserLock(full),
          bytes: stats.bytes,
          files: stats.files,
          cacheBytes: stats.cacheBytes,
          cacheFiles: stats.cacheFiles,
        });
      }
    }
    profiles.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

    const archiveStats = statTree(resolvedArchive);
    const archiveCount = fs.existsSync(resolvedArchive)
      ? fs
          .readdirSync(resolvedArchive, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length
      : 0;
    const trashStats = statTree(resolvedTrash);
    const trashCount = fs.existsSync(resolvedTrash)
      ? fs
          .readdirSync(resolvedTrash, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length
      : 0;
    const orphanProfiles = profiles.filter((profile) => !profile.linked);
    const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);

    return {
      profiles,
      orphans: orphanProfiles,
      totals: {
        profiles: profiles.length,
        linked: profiles.length - orphanProfiles.length,
        orphans: orphanProfiles.length,
        bytes: sum(profiles, "bytes"),
        cacheBytes: sum(profiles, "cacheBytes"),
        orphanBytes: sum(orphanProfiles, "bytes"),
        archiveCount,
        archiveBytes: archiveStats.bytes,
        trashCount,
        trashBytes: trashStats.bytes,
      },
    };
  }

  function findOrphan(name, accounts = []) {
    const target = directProfilePath(name);
    const { byPath: linkedByPath, protectAll } = accountMap(accounts);
    if (protectAll || linkedByPath.has(pathKey(target))) {
      throw new ProfileOperationError("该 Profile 仍被账号引用，不能按孤儿目录处理", 409);
    }
    if (!assertRealDirectory(target)) {
      throw new ProfileOperationError("Profile 不存在", 404);
    }
    return target;
  }

  function cleanCacheAt(target, accountIds = null, cachePaths = CACHE_PATHS) {
    if (!assertRealDirectory(target)) return { freedBytes: 0, freedFiles: 0, removed: [] };
    assertAvailable(target, accountIds);
    const result = { freedBytes: 0, freedFiles: 0, removed: [] };

    for (const parts of cachePaths) {
      const cachePath = path.resolve(target, ...parts);
      assertCachePathIsLocal(target, cachePath);
      if (!fs.existsSync(cachePath)) continue;
      const stats = statTree(cachePath);
      const item = fs.lstatSync(cachePath);
      fs.rmSync(cachePath, {
        recursive: item.isDirectory(),
        force: false,
        maxRetries: 2,
        retryDelay: 100,
      });
      result.freedBytes += stats.bytes;
      result.freedFiles += stats.files;
      result.removed.push(parts.join("/"));
    }
    return result;
  }

  function inspectCacheAt(target, accountIds = null, cachePaths = CACHE_PATHS) {
    if (!assertRealDirectory(target)) {
      return { missing: true, cacheBytes: 0, cacheFiles: 0 };
    }
    assertAvailable(target, accountIds);
    const result = { missing: false, cacheBytes: 0, cacheFiles: 0 };

    for (const parts of cachePaths) {
      const cachePath = path.resolve(target, ...parts);
      assertCachePathIsLocal(target, cachePath);
      if (!fs.existsSync(cachePath)) continue;
      const stats = statTree(cachePath);
      result.cacheBytes += stats.bytes;
      result.cacheFiles += stats.files;
    }
    return result;
  }

  function inspectAccountCache(account) {
    const target = accountProfilePath(account);
    return inspectCacheAt(target, account.id, AUTOMATIC_CACHE_PATHS);
  }

  function cleanAccountCache(account) {
    const target = accountProfilePath(account);
    if (!assertRealDirectory(target)) {
      return { missing: true, freedBytes: 0, freedFiles: 0, removed: [] };
    }
    return {
      missing: false,
      ...cleanCacheAt(target, account.id, AUTOMATIC_CACHE_PATHS),
    };
  }

  function cleanCaches(accounts = [], { scope = "all", name = null } = {}) {
    const { byPath: linkedByPath, protectAll } = accountMap(accounts);
    const targets = [];

    if (name) {
      const target = directProfilePath(name);
      if (!assertRealDirectory(target)) throw new ProfileOperationError("Profile 不存在", 404);
      const linkedAccounts = protectAll ? accounts : linkedByPath.get(pathKey(target)) ?? [];
      targets.push({ name, target, accountIds: linkedAccounts.map((account) => account.id) });
    } else if (fs.existsSync(resolvedProfiles)) {
      for (const entry of fs.readdirSync(resolvedProfiles, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const target = directProfilePath(entry.name);
        const linkedAccounts = protectAll ? accounts : linkedByPath.get(pathKey(target)) ?? [];
        const linked = linkedAccounts.length > 0;
        if (scope === "linked" && !linked) continue;
        if (scope === "orphan" && linked) continue;
        targets.push({
          name: entry.name,
          target,
          accountIds: linkedAccounts.map((account) => account.id),
        });
      }
    }

    const result = { profilesCleaned: 0, freedBytes: 0, freedFiles: 0, skipped: [] };
    for (const item of targets) {
      try {
        const cleaned = cleanCacheAt(item.target, item.accountIds);
        result.profilesCleaned++;
        result.freedBytes += cleaned.freedBytes;
        result.freedFiles += cleaned.freedFiles;
      } catch (error) {
        if (error?.statusCode === 409) {
          result.skipped.push({ name: item.name, reason: error.message });
          continue;
        }
        throw error;
      }
    }
    return result;
  }

  function moveToArchive(target, metadata = {}) {
    assertRealDirectory(target);
    assertAvailable(target, metadata.accountId ?? null);
    ensureDir(resolvedArchive);
    const base = `${safeName(path.basename(target))}__${timestampSlug()}`;
    const destination = uniqueDestination(resolvedArchive, base);
    renamePathSync(target, destination);
    try {
      fs.writeFileSync(
        path.join(destination, ".keeper-archive.json"),
        JSON.stringify(
          {
            originalProfile: path.relative(resolvedWorkspace, target).replaceAll("\\", "/"),
            accountId: metadata.accountId ?? null,
            archivedAt: new Date().toISOString(),
            reason: metadata.reason ?? "manual",
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      // 清单写失败不影响已完成的归档。
    }
    return {
      archived: true,
      name: path.basename(destination),
      path: path.relative(resolvedWorkspace, destination).replaceAll("\\", "/"),
    };
  }

  function archiveAccount(account) {
    const target = accountProfilePath(account);
    if (!fs.existsSync(target)) return { archived: false, missing: true };
    return moveToArchive(target, { accountId: account.id, reason: "account-delete" });
  }

  function archiveOrphan(name, accounts = []) {
    const target = findOrphan(name, accounts);
    return moveToArchive(target, { reason: "orphan-cleanup" });
  }

  function purgeAt(target, accountId = null) {
    if (!fs.existsSync(target)) return { deleted: false, missing: true, bytes: 0 };
    assertRealDirectory(target);
    assertAvailable(target, accountId);
    const stats = statTree(target);
    ensureDir(resolvedTrash);
    const staged = uniqueDestination(
      resolvedTrash,
      `${safeName(path.basename(target))}__${timestampSlug()}`
    );
    renamePathSync(target, staged);
    try {
      if (!isPathInside(resolvedTrash, staged)) {
        throw new ProfileOperationError("临时删除路径不安全");
      }
      fs.rmSync(staged, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    } catch (error) {
      // 删除失败时尽量恢复原目录，避免留下不可见的半完成状态。
      if (!fs.existsSync(target) && fs.existsSync(staged)) {
        try {
          renamePathSync(staged, target);
        } catch {
          // 保留原始错误；残留仍位于受控的 .profile-trash 目录。
        }
      }
      throw error;
    }
    return { deleted: true, missing: false, bytes: stats.bytes, files: stats.files };
  }

  function purgeAccount(account) {
    return purgeAt(accountProfilePath(account), account.id);
  }

  function purgeOrphan(name, accounts = []) {
    return purgeAt(findOrphan(name, accounts));
  }

  /**
   * 账号配置与 Profile 操作的同盘事务式编排：
   * - archive 先移动，账号配置提交失败则移回原位；
   * - purge 先移动到受控暂存目录，账号配置提交成功后才真正递归删除。
   */
  function removeAccountWithProfile(account, action, commitRemoval, accounts = [account]) {
    if (!["detach", "archive", "purge"].includes(action)) {
      throw new ProfileOperationError("未知的 Profile 处理方式");
    }
    if (typeof commitRemoval !== "function") {
      throw new ProfileOperationError("缺少账号删除提交函数");
    }

    // “仅移除”完全不触碰文件系统，即便旧配置的 profileDir 不是标准路径也应可用。
    if (action === "detach") {
      const committed = commitRemoval();
      if (!committed) throw new ProfileOperationError("账号删除提交失败", 404);
      return { action, retained: true };
    }

    const target = accountProfilePath(account);
    const { byPath: linkedByPath, protectAll } = accountMap(accounts);
    const linkedAccounts = protectAll ? accounts : linkedByPath.get(pathKey(target)) ?? [];
    const otherReferences = linkedAccounts.filter((item) => item.id !== account.id);
    if (protectAll || otherReferences.length > 0) {
      throw new ProfileOperationError(
        "该 Profile 仍被其他账号引用，只能选择“仅移除账号”",
        409
      );
    }
    if (!fs.existsSync(target)) {
      const committed = commitRemoval();
      if (!committed) throw new ProfileOperationError("账号删除提交失败", 404);
      return { action, missing: true };
    }

    assertRealDirectory(target);
    assertAvailable(target, linkedAccounts.map((item) => item.id));

    if (action === "archive") {
      const archived = moveToArchive(target, {
        accountId: account.id,
        reason: "account-delete",
      });
      const destination = path.resolve(resolvedWorkspace, archived.path);
      try {
        const committed = commitRemoval();
        if (!committed) throw new ProfileOperationError("账号删除提交失败", 404);
        return { action, ...archived };
      } catch (error) {
        // 回滚时先去掉归档清单，避免它混回活动 Profile。
        try {
          fs.rmSync(path.join(destination, ".keeper-archive.json"), { force: true });
        } catch {
          // 继续尝试恢复目录。
        }
        if (!fs.existsSync(target) && fs.existsSync(destination)) {
          try {
            renamePathSync(destination, target);
          } catch {
            // 保留最初的提交错误。
          }
        }
        throw error;
      }
    }

    const stats = statTree(target);
    ensureDir(resolvedTrash);
    const staged = uniqueDestination(
      resolvedTrash,
      `${safeName(path.basename(target))}__${timestampSlug()}`
    );
    renamePathSync(target, staged);
    try {
      const committed = commitRemoval();
      if (!committed) throw new ProfileOperationError("账号删除提交失败", 404);
    } catch (error) {
      if (!fs.existsSync(target) && fs.existsSync(staged)) {
        try {
          renamePathSync(staged, target);
        } catch {
          // 保留最初的提交错误。
        }
      }
      throw error;
    }

    try {
      if (!isPathInside(resolvedTrash, staged)) {
        throw new ProfileOperationError("临时删除路径不安全");
      }
      fs.rmSync(staged, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
      return { action, deleted: true, bytes: stats.bytes, files: stats.files };
    } catch (error) {
      // 账号已成功移除，若最终清除受阻就恢复成可扫描的孤儿目录，避免隐藏残留。
      if (!fs.existsSync(target) && fs.existsSync(staged)) {
        try {
          renamePathSync(staged, target);
        } catch {
          // 若连恢复也失败，目录仍在受控的 .profile-trash 中。
        }
      }
      return {
        action,
        deleted: false,
        bytes: 0,
        warning: `账号已移除，但 Profile 最终删除失败：${String(error.message || error)}`,
      };
    }
  }

  return {
    scan,
    cleanCaches,
    inspectAccountCache,
    cleanAccountCache,
    archiveAccount,
    archiveOrphan,
    purgeAccount,
    purgeOrphan,
    removeAccountWithProfile,
  };
}

// workspaceRoot 必须是数据根，不能是安装根。账号的 profileDir 是相对路径
// （"profiles/acc_xxx"），accountProfilePath 会把它拼到 workspaceRoot 上；用安装根
// 拼出来的是 <安装目录>\profiles\acc_xxx，而 profilesRoot 在数据目录下，于是
// 每个账号都被判定为"Profile 路径不在 profiles 直接子目录中"，删除账号和清缓存
// 全部失败。CLI 模式下两个根恰好相同，所以这个错配一直没暴露。
export const profileManager = createProfileManager({
  workspaceRoot: fromRoot("."),
  profilesRoot: fromRoot("profiles"),
  archiveRoot: fromRoot("profiles-archive"),
  trashRoot: fromRoot("profile-trash"),
});
