import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { isPromoEligibility } from "../promoEligibility.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONFIG_FILES = Object.freeze([
  "config/accounts.json",
  "config/conversations.json",
  "config/settings.json",
]);
const OPTIONAL_CONFIG_FILES = Object.freeze([
  "config/groups.json",
  "config/proxies.json",
  "config/status-cache.json",
  "config/selectors.json",
]);
const PROFILE_LOCK_NAMES = /^(?:Singleton.*|DevToolsActivePort)$/i;
const LEGACY_GENERATED_CONVERSATION_ID = /^topic_[a-z0-9]{8}$/i;

function migrationError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function hashFile(file, { fsImpl = fs } = {}) {
  const hash = createHash("sha256");
  const descriptor = fsImpl.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fsImpl.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fsImpl.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function safeRelative(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw migrationError("PATH_OUTSIDE_SOURCE", `路径不在旧源码目录内：${target}`);
  }
  return toPosix(relative);
}

function strictUtf8(buffer, label) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (error) {
    throw migrationError("INVALID_UTF8", `${label} 不是严格 UTF-8 文本`, error);
  }
}

function readStrictJson(file, label, { fsImpl = fs } = {}) {
  const stat = fsImpl.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw migrationError("UNSAFE_CONFIG_FILE", `${label} 必须是普通文件，不能是链接`);
  }
  const buffer = fsImpl.readFileSync(file);
  let parsed;
  try {
    parsed = JSON.parse(strictUtf8(buffer, label));
  } catch (error) {
    if (error?.code === "INVALID_UTF8") throw error;
    throw migrationError("INVALID_CONFIG_JSON", `${label} 不是有效 JSON：${error.message}`, error);
  }
  return {
    parsed,
    manifest: {
      path: toPosix(label),
      kind: "config",
      size: stat.size,
      sha256: sha256Buffer(buffer),
    },
  };
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("INVALID_CONFIG_SHAPE", `${label} 必须是 JSON 对象`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw migrationError("INVALID_CONFIG_SHAPE", `${label} 必须是数组`);
  }
  return value;
}

function ensureUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    if (typeof value !== "string" || !value) {
      throw migrationError("INVALID_CONFIG_SHAPE", `${label}存在空的 ${key}`);
    }
    if (seen.has(value)) throw migrationError("DUPLICATE_ID", `${label}存在重复 ${key}：${value}`);
    seen.add(value);
  }
}

function pickExtra(value, known) {
  const result = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!known.has(key)) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}

function finiteNumber(value, fallback, minimum = 0) {
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function normalizeConversationSets(rawSets) {
  const entries = Object.entries(rawSets).map(([id, value]) => [
    id,
    requireObject(value, `会话集 ${id}`),
  ]);
  const generatedBases = new Set(
    entries
      .filter(([id]) => LEGACY_GENERATED_CONVERSATION_ID.test(id))
      .map(([, set]) => typeof set.topic === "string" && set.topic.trim()
        ? set.topic.trim()
        : "未命名会话")
  );
  const usedIds = new Set(
    entries
      .map(([id]) => id)
      .filter((id) => !LEGACY_GENERATED_CONVERSATION_ID.test(id))
  );
  const idMap = new Map();
  const conversationSets = entries.map(([legacyId, set], sortOrder) => {
    let id = legacyId;
    if (LEGACY_GENERATED_CONVERSATION_ID.test(legacyId)) {
      const base = typeof set.topic === "string" && set.topic.trim()
        ? set.topic.trim()
        : "未命名会话";
      id = base;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${base} (${suffix++})`;
        // 另一条会话的上下文本身可能正好叫“foo (2)”。优先为它保留
        // 原始内容标识，当前重复项继续递增，避免导入与数据库升级结果不同。
        while (generatedBases.has(id) && id !== base) id = `${base} (${suffix++})`;
      }
      usedIds.add(id);
    }
    idMap.set(legacyId, id);
    const minRounds = finiteNumber(set.minRounds, 2);
    return {
      id,
      sortOrder,
      topic: typeof set.topic === "string" ? set.topic : "",
      minRounds,
      maxRounds: finiteNumber(set.maxRounds, Math.max(8, minRounds), minRounds),
      legacyExtra: pickExtra(set, new Set(["topic", "minRounds", "maxRounds"])),
    };
  });
  return { conversationSets, idMap };
}

function deterministicMigrationGroupId(sourceKey, proxyId) {
  return `grp_migr_${createHash("sha256")
    .update(`${sourceKey}\0${proxyId}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function migrateLegacyAccountProxies(rawAccounts, rawGroups) {
  const accounts = rawAccounts.map((account) => ({ ...account }));
  const groups = rawGroups.map((group) => ({
    proxyId: null,
    timezone: null,
    locale: null,
    ...group,
  }));
  const originalGroups = [...groups];
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const usedNames = new Set(groups.map((group) => group.name));

  for (const group of originalGroups) {
    if (group.proxyId) continue;
    const members = accounts.filter((account) => account.groupId === group.id);
    if (!members.length || members.some((account) => !account.proxyId)) continue;
    const counts = new Map();
    for (const account of members) counts.set(account.proxyId, (counts.get(account.proxyId) ?? 0) + 1);
    group.proxyId = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }

  const migrationGroups = new Map();
  const uniqueName = (base) => {
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let suffix = 2;
    while (usedNames.has(`${base} ${suffix}`)) suffix++;
    const result = `${base} ${suffix}`;
    usedNames.add(result);
    return result;
  };
  const ensureMigrationGroup = (sourceKey, sourceName, proxyId) => {
    const cacheKey = `${sourceKey}\0${proxyId}`;
    if (migrationGroups.has(cacheKey)) return migrationGroups.get(cacheKey);
    const idBase = deterministicMigrationGroupId(sourceKey, proxyId);
    let id = idBase;
    let suffix = 2;
    while (groupsById.has(id) && groupsById.get(id).proxyId !== proxyId) id = `${idBase}_${suffix++}`;
    let group = groupsById.get(id);
    if (!group) {
      group = {
        id,
        name: uniqueName(`${sourceName || "未分组账号"}（迁移代理）`),
        proxyId,
        timezone: null,
        locale: null,
      };
      groups.push(group);
      groupsById.set(group.id, group);
    }
    migrationGroups.set(cacheKey, group);
    return group;
  };

  for (const account of accounts) {
    const legacyProxyId = account.proxyId || null;
    const sourceGroup = account.groupId ? groupsById.get(account.groupId) : null;
    if (legacyProxyId && sourceGroup?.proxyId !== legacyProxyId) {
      const sourceKey = sourceGroup
        ? sourceGroup.id
        : account.groupId
          ? `missing:${account.groupId}`
          : "ungrouped";
      account.groupId = ensureMigrationGroup(
        sourceKey,
        sourceGroup?.name || (account.groupId ? `原分组 ${account.groupId}` : "未分组账号"),
        legacyProxyId
      ).id;
    }
    if (account.proxy && !legacyProxyId) account.enabled = false;
  }
  return { accounts, groups };
}

function collectTree(root, sourceRoot, kind, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(root)) return [];
  const rootStat = fsImpl.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw migrationError("UNSAFE_PROFILE_ROOT", `${safeRelative(sourceRoot, root)} 必须是普通目录`);
  }
  const trees = [];
  const entries = fsImpl.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const treeRoot = path.join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw migrationError("UNSAFE_PROFILE_ENTRY", `${safeRelative(sourceRoot, treeRoot)} 必须是普通目录`);
    }
    const files = [];
    const skipped = [];
    const walk = (directory) => {
      const children = fsImpl
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const absolute = path.join(directory, child.name);
        const relativeToTree = toPosix(path.relative(treeRoot, absolute));
        if (PROFILE_LOCK_NAMES.test(child.name)) {
          skipped.push(relativeToTree);
          continue;
        }
        if (child.isSymbolicLink()) {
          throw migrationError("PROFILE_SYMLINK", `Profile 中存在不允许复制的链接：${safeRelative(sourceRoot, absolute)}`);
        }
        if (child.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!child.isFile()) {
          throw migrationError("UNSAFE_PROFILE_ENTRY", `Profile 中存在特殊文件：${safeRelative(sourceRoot, absolute)}`);
        }
        const stat = fsImpl.statSync(absolute);
        files.push({
          path: relativeToTree,
          size: stat.size,
          sha256: hashFile(absolute, { fsImpl }),
        });
      }
    };
    walk(treeRoot);
    trees.push({
      kind,
      name: entry.name,
      sourcePath: safeRelative(sourceRoot, treeRoot),
      files,
      skipped,
      size: files.reduce((sum, file) => sum + file.size, 0),
    });
  }
  return trees;
}

function readHistories(logsRoot, sourceRoot, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(logsRoot)) return { histories: [], rejects: [], manifest: [] };
  const rootStat = fsImpl.lstatSync(logsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw migrationError("UNSAFE_HISTORY_ROOT", "logs 必须是普通目录");
  }
  const histories = [];
  const rejects = [];
  const manifest = [];
  const entries = fsImpl
    .readdirSync(logsRoot, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".jsonl"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const file = path.join(logsRoot, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw migrationError("UNSAFE_HISTORY_FILE", `${entry.name} 必须是普通文件`);
    }
    const buffer = fsImpl.readFileSync(file);
    const relative = safeRelative(sourceRoot, file);
    const text = strictUtf8(buffer, relative);
    manifest.push({ path: relative, kind: "history", size: buffer.length, sha256: sha256Buffer(buffer) });
    const accountId = path.basename(entry.name, ".jsonl");
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const payload = JSON.parse(line);
        requireObject(payload, `${relative}:${index + 1}`);
        histories.push({
          accountId,
          finishedAt: typeof payload.time === "string" ? payload.time : null,
          ok: typeof payload.ok === "boolean" ? payload.ok : null,
          prompt: typeof payload.prompt === "string" ? payload.prompt : null,
          reply: typeof payload.reply === "string" ? payload.reply : null,
          error:
            typeof payload.error === "string"
              ? payload.error
              : typeof payload.reason === "string"
                ? payload.reason
                : null,
          payload,
          legacyFile: relative,
          legacyLine: index + 1,
        });
      } catch (error) {
        rejects.push({
          kind: "history-jsonl",
          sourcePath: relative,
          lineNumber: index + 1,
          rawText: line,
          error: String(error?.message || error),
        });
      }
    });
  }
  return { histories, rejects, manifest };
}

function fingerprintManifest(manifest) {
  const stable = {
    entries: manifest.entries
      .map(({ path: filePath, kind, size, sha256 }) => ({ path: filePath, kind, size, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    profileTrees: manifest.profileTrees
      .map((tree) => ({
        kind: tree.kind,
        name: tree.name,
        files: tree.files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
      }))
      .sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`)),
    trashResidues: [...manifest.trashResidues].sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function accountProfileName(account, profilesRoot) {
  const configured = account.profileDir || `profiles/${account.id}`;
  if (typeof configured !== "string" || path.isAbsolute(configured) || configured.includes("\0")) {
    throw migrationError("UNSAFE_PROFILE_PATH", `账号 ${account.id} 的 profileDir 不安全`);
  }
  const normalizedConfigured = configured.replaceAll("\\", path.sep).replaceAll("/", path.sep);
  const absolute = path.resolve(path.dirname(profilesRoot), normalizedConfigured);
  if (path.dirname(absolute) !== path.resolve(profilesRoot)) {
    throw migrationError("UNSAFE_PROFILE_PATH", `账号 ${account.id} 的 Profile 必须是 profiles 的直接子目录`);
  }
  return path.basename(absolute);
}

function normalizeData(config, profileTrees, rawHistories) {
  const rawAccounts = requireArray(config.accounts.accounts, "accounts.accounts");
  const rawGroups = config.groups ? requireArray(config.groups.groups ?? [], "groups.groups") : [];
  ensureUnique(rawAccounts, "id", "账号");
  ensureUnique(rawGroups, "id", "分组");
  const migrated = migrateLegacyAccountProxies(rawAccounts, rawGroups);
  ensureUnique(migrated.groups, "id", "迁移后的分组");
  const sets = requireObject(config.conversations.sets ?? {}, "conversations.sets");
  const { conversationSets, idMap: conversationIdMap } = normalizeConversationSets(sets);

  const activeProfiles = new Set(
    profileTrees.filter((tree) => tree.kind === "active").map((tree) => tree.name)
  );
  const profileNames = new Set();
  const profilesRoot = path.join(config.sourceRoot, "profiles");
  const accountKnown = new Set([
    "id", "note", "profileDir", "groupId", "enabled", "email", "gptName",
    "switchRule", "minWindows", "maxWindows", "rotation", "proxyId", "proxy",
  ]);
  const accounts = migrated.accounts.map((account, sortOrder) => {
    const profileName = accountProfileName(account, profilesRoot);
    if (!activeProfiles.has(profileName)) {
      throw migrationError("MISSING_PROFILE", `账号 ${account.id} 的 Profile 不存在：${profileName}`);
    }
    if (profileNames.has(profileName)) {
      throw migrationError("SHARED_PROFILE", `多个账号引用了同一 Profile：${profileName}`);
    }
    profileNames.add(profileName);
    const minWindows = finiteNumber(account.minWindows, 1, 1);
    const extra = pickExtra(account, accountKnown) ?? {};
    if (account.proxyId) extra.legacyProxyId = account.proxyId;
    if (account.proxy) extra.legacyManualProxy = account.proxy;
    return {
      id: account.id,
      sortOrder,
      note: typeof account.note === "string" ? account.note : "",
      profileName,
      groupId: account.groupId || null,
      enabled: account.enabled !== false,
      email: typeof account.email === "string" ? account.email : null,
      gptName: typeof account.gptName === "string" ? account.gptName : null,
      switchRule: account.switchRule === "sequential" ? "sequential" : "random",
      minWindows,
      maxWindows: finiteNumber(account.maxWindows, Math.max(3, minWindows), minWindows),
      rotation: {
        currentSet: conversationIdMap.get(account.rotation?.currentSet) ?? null,
        windowsDone: finiteNumber(account.rotation?.windowsDone, 0),
        windowsTarget: finiteNumber(account.rotation?.windowsTarget, 0),
      },
      legacyExtra: Object.keys(extra).length ? extra : null,
    };
  });

  const proxyStore = config.proxies ? requireObject(config.proxies, "proxies") : {};
  const rawNodes = Array.isArray(proxyStore.nodes) ? proxyStore.nodes : [];
  ensureUnique(rawNodes, "id", "代理节点");
  const proxyKnown = new Set(["id", "name", "raw", "enabled", "missing"]);
  const proxyNodes = rawNodes.map((node, sortOrder) => ({
    id: node.id,
    sortOrder,
    name: typeof node.name === "string" ? node.name : node.id,
    raw: requireObject(node.raw ?? {}, `代理节点 ${node.id}.raw`),
    enabled: node.enabled !== false,
    missing: !!node.missing,
    legacyExtra: pickExtra(node, proxyKnown),
  }));
  const proxyIds = new Set(proxyNodes.map((node) => node.id));
  for (const group of migrated.groups) {
    if (group.proxyId && !proxyIds.has(group.proxyId)) {
      proxyNodes.push({
        id: group.proxyId,
        sortOrder: proxyNodes.length,
        name: `已缺失节点 ${group.proxyId}`,
        raw: {},
        enabled: false,
        missing: true,
        legacyExtra: { migrationPlaceholder: true },
      });
      proxyIds.add(group.proxyId);
    }
  }

  const groupKnown = new Set(["id", "name", "proxyId", "timezone", "locale", "tzManual"]);
  const groups = migrated.groups.map((group, sortOrder) => ({
    id: group.id,
    sortOrder,
    name: typeof group.name === "string" && group.name ? group.name : group.id,
    proxyId: group.proxyId || null,
    timezone: group.timezone || null,
    locale: group.locale || null,
    timezoneManual: !!group.tzManual,
    legacyExtra: pickExtra(group, groupKnown),
  }));
  const groupIds = new Set(groups.map((group) => group.id));
  for (const account of accounts) if (account.groupId && !groupIds.has(account.groupId)) account.groupId = null;

  const rawSettings = requireObject(config.settings, "settings");
  const settingsKnown = new Set([
    "intervalMinutes", "jitterMinutes", "headless", "statusCheckMinutes",
    "statusCheckOnStartup", "openPageTimeoutMinutes", "profileAutoCleanEnabled",
  ]);
  const settings = {
    intervalMinutes: finiteNumber(rawSettings.intervalMinutes, 180, 1),
    jitterMinutes: finiteNumber(rawSettings.jitterMinutes, 30),
    headless: typeof rawSettings.headless === "boolean" ? rawSettings.headless : true,
    statusCheckMinutes: finiteNumber(rawSettings.statusCheckMinutes, 15, 1),
    statusCheckOnStartup:
      typeof rawSettings.statusCheckOnStartup === "boolean" ? rawSettings.statusCheckOnStartup : true,
    openPageTimeoutMinutes: finiteNumber(rawSettings.openPageTimeoutMinutes, 0),
    profileAutoCleanEnabled:
      typeof rawSettings.profileAutoCleanEnabled === "boolean" ? rawSettings.profileAutoCleanEnabled : true,
    legacyExtra: pickExtra(rawSettings, settingsKnown),
  };

  const subscription = proxyStore.subscription && typeof proxyStore.subscription === "object"
    ? proxyStore.subscription
    : {};
  const proxySettings = {
    subscriptionUrl: typeof subscription.url === "string" ? subscription.url : null,
    subscriptionUpdatedAt: typeof subscription.updatedAt === "string" ? subscription.updatedAt : null,
    mihomoPath: typeof proxyStore.mihomoPath === "string" ? proxyStore.mihomoPath : null,
    clashVergeDir: typeof proxyStore.clashVergeDir === "string" ? proxyStore.clashVergeDir : null,
    legacyExtra: pickExtra(proxyStore, new Set(["subscription", "mihomoPath", "clashVergeDir", "nodes"])),
  };

  const rawStatuses = config.statusCache?.accounts && typeof config.statusCache.accounts === "object"
    ? config.statusCache.accounts
    : {};
  const accountIds = new Set(accounts.map((account) => account.id));
  const statusKnown = new Set([
    "state", "loggedIn", "email", "detail", "checkedAt", "lastCheckState",
    "lastCheckDetail", "confirmedState", "confirmedAt", "consecutiveUnknowns",
    "unknownSince", "stale", "promoEligibility", "promoCheckedAt", "promoStale",
    "promoCheckDetail",
  ]);
  const statuses = Object.entries(rawStatuses)
    .filter(([accountId, status]) => accountIds.has(accountId) && status && typeof status === "object")
    .map(([accountId, status]) => ({
      accountId,
      state: status.state ?? null,
      email: status.email ?? null,
      detail: status.detail ?? null,
      checkedAt: status.checkedAt ?? null,
      lastCheckState: status.lastCheckState ?? null,
      lastCheckDetail: status.lastCheckDetail ?? null,
      confirmedState: status.confirmedState ?? null,
      confirmedAt: status.confirmedAt ?? null,
      consecutiveUnknowns: finiteNumber(status.consecutiveUnknowns, 0),
      unknownSince: status.unknownSince ?? null,
      stale: true,
      promoEligibility: isPromoEligibility(status.promoEligibility)
        ? status.promoEligibility
        : null,
      promoCheckedAt: status.promoCheckedAt ?? null,
      promoStale: status.promoStale === true,
      promoCheckDetail: status.promoCheckDetail ?? null,
      legacyExtra: pickExtra(status, statusKnown),
    }));

  const histories = rawHistories.map((entry) => {
    const legacySetName = entry.payload?.setName;
    if (typeof legacySetName !== "string") return entry;
    const mappedSetName = conversationIdMap.get(legacySetName)
      ?? (LEGACY_GENERATED_CONVERSATION_ID.test(legacySetName)
        ? (typeof entry.payload?.topic === "string" && entry.payload.topic.trim()
          ? entry.payload.topic.trim()
          : "未命名会话")
        : null);
    if (mappedSetName === null) return entry;
    return {
      ...entry,
      payload: { ...entry.payload, setName: mappedSetName },
    };
  });

  return {
    accounts,
    groups,
    conversationSets,
    proxyNodes,
    proxySettings,
    settings,
    statuses,
    histories,
  };
}

/**
 * Read-only, explicit migration planning. It never writes to the source or target.
 */
export function buildLegacyMigrationPlan(
  sourceRoot,
  { fsImpl = fs, clock = () => new Date() } = {}
) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw migrationError("INVALID_SOURCE_ROOT", "旧源码目录必须是绝对路径");
  }
  const resolvedSource = path.resolve(sourceRoot);
  if (resolvedSource === path.parse(resolvedSource).root) {
    throw migrationError("INVALID_SOURCE_ROOT", "旧源码目录不能是文件系统根目录");
  }
  const sourceStat = fsImpl.lstatSync(resolvedSource);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw migrationError("INVALID_SOURCE_ROOT", "旧源码目录必须是普通目录");
  }

  const loaded = {};
  const manifestEntries = [];
  for (const relative of CONFIG_FILES) {
    const file = path.join(resolvedSource, ...relative.split("/"));
    if (!fsImpl.existsSync(file)) throw migrationError("MISSING_CONFIG", `缺少 ${relative}`);
    const result = readStrictJson(file, relative, { fsImpl });
    manifestEntries.push(result.manifest);
    loaded[path.basename(relative, ".json").replace("status-cache", "statusCache")] = result.parsed;
  }
  for (const relative of OPTIONAL_CONFIG_FILES) {
    const file = path.join(resolvedSource, ...relative.split("/"));
    if (!fsImpl.existsSync(file)) continue;
    const result = readStrictJson(file, relative, { fsImpl });
    manifestEntries.push(result.manifest);
    loaded[path.basename(relative, ".json").replace("status-cache", "statusCache")] = result.parsed;
  }
  loaded.sourceRoot = resolvedSource;

  requireObject(loaded.accounts, "accounts.json");
  requireObject(loaded.conversations, "conversations.json");
  requireObject(loaded.settings, "settings.json");
  if (loaded.groups) requireObject(loaded.groups, "groups.json");
  if (loaded.proxies) requireObject(loaded.proxies, "proxies.json");
  if (loaded.statusCache) requireObject(loaded.statusCache, "status-cache.json");

  const activeProfiles = collectTree(path.join(resolvedSource, "profiles"), resolvedSource, "active", { fsImpl });
  const archivedProfiles = collectTree(
    path.join(resolvedSource, "profiles-archive"),
    resolvedSource,
    "archive",
    { fsImpl }
  );
  const profileTrees = [...activeProfiles, ...archivedProfiles];
  const history = readHistories(path.join(resolvedSource, "logs"), resolvedSource, { fsImpl });
  manifestEntries.push(...history.manifest);

  const trashRoot = path.join(resolvedSource, ".profile-trash");
  let trashResidues = [];
  if (fsImpl.existsSync(trashRoot)) {
    const stat = fsImpl.lstatSync(trashRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw migrationError("UNSAFE_TRASH_ROOT", ".profile-trash 必须是普通目录");
    }
    trashResidues = fsImpl.readdirSync(trashRoot).sort();
  }

  const manifest = {
    version: 1,
    entries: manifestEntries.sort((a, b) => a.path.localeCompare(b.path)),
    profileTrees,
    trashResidues,
    legacyOverrides: loaded.selectors ? { selectors: loaded.selectors } : {},
  };
  const normalized = normalizeData(loaded, profileTrees, history.histories);
  const sourceFingerprint = fingerprintManifest(manifest);
  return Object.freeze({
    version: 1,
    sourceRoot: resolvedSource,
    sourceFingerprint,
    createdAt: new Date(clock()).toISOString(),
    manifest,
    totalProfileBytes: profileTrees.reduce((sum, tree) => sum + tree.size, 0),
    requiresTrashDecision: trashResidues.length > 0,
    selectorsOverride: loaded.selectors ?? null,
    data: Object.freeze({
      ...normalized,
      rejects: history.rejects,
    }),
    counts: Object.freeze({
      accounts: normalized.accounts.length,
      profiles: activeProfiles.length,
      archivedProfiles: archivedProfiles.length,
      groups: normalized.groups.length,
      conversationSets: normalized.conversationSets.length,
      proxyNodes: normalized.proxyNodes.length,
      statuses: normalized.statuses.length,
      histories: normalized.histories.length,
      rejects: history.rejects.length,
    }),
  });
}

export function verifyLegacyMigrationPlan(plan, { fsImpl = fs } = {}) {
  if (!plan?.sourceRoot || !plan?.sourceFingerprint) {
    throw migrationError("INVALID_MIGRATION_PLAN", "迁移计划不完整");
  }
  const current = buildLegacyMigrationPlan(plan.sourceRoot, { fsImpl, clock: () => plan.createdAt });
  if (current.sourceFingerprint !== plan.sourceFingerprint) {
    throw migrationError("SOURCE_CHANGED", "生成迁移计划后，旧数据发生了变化；请重新扫描");
  }
  return true;
}

export { PROFILE_LOCK_NAMES };
