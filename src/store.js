import fs from "node:fs";
import { createHash } from "node:crypto";
import { fromRoot, ensureDir } from "./paths.js";
import * as log from "./logger.js";

// 可读写的配置存储。account/conversation 增删改都经过这里并落盘。
const ACCOUNTS_FILE = fromRoot("config/accounts.json");
const CONV_FILE = fromRoot("config/conversations.json");
const SETTINGS_FILE = fromRoot("config/settings.json");
const GROUPS_FILE = fromRoot("config/groups.json");

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  ensureDir(fromRoot("config"));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ---------- accounts ----------
// 规范化账号：为旧数据补齐轮换相关字段，去掉已废弃的
// conversationSet / proxyId / proxy。账号的出口只由所属分组决定。
function normalizeAccount(a) {
  const { conversationSet, proxyId, proxy, ...rest } = a;
  return {
    switchRule: "random",
    minWindows: 1,
    maxWindows: 3,
    // 分组允许为空：空 = 未分组（未分组的账号跟随系统网络）
    groupId: null,
    ...rest,
    rotation: a.rotation ?? { currentSet: null, windowsDone: 0, windowsTarget: 0 },
  };
}

export function getAccounts() {
  const data = readJsonFile(ACCOUNTS_FILE, { accounts: [] });
  return (data.accounts ?? []).map(normalizeAccount);
}

export function getAccount(id) {
  return getAccounts().find((a) => a.id === id) ?? null;
}

// 账号的显示名：优先邮箱，其次备注，最后 id。日志/界面统一用这个。
export function displayName(a) {
  return a.email || a.note || a.id;
}

export function saveAccounts(accounts) {
  const normalized = Array.isArray(accounts) ? accounts.map(normalizeAccount) : [];
  writeJsonFile(ACCOUNTS_FILE, { accounts: normalized });
}

function slugId() {
  const arr = new Uint32Array(2);
  globalThis.crypto.getRandomValues(arr);
  return "acc_" + arr[0].toString(36) + arr[1].toString(36);
}

export function addAccount({
  note = "",
  groupId = null,
  switchRule = "random",
  minWindows = 1,
  maxWindows = 3,
} = {}) {
  const accounts = getAccounts();
  const id = slugId();
  const account = {
    id,
    note,
    email: null,
    gptName: null,
    profileDir: `profiles/${id}`,
    groupId, // 所属分组，null = 未分组；代理由分组决定
    enabled: true,
    // 主题轮换规则：在所有会话集之间动态切换
    switchRule, // "random" | "sequential"
    minWindows, // 一个主题连续跑的对话（窗口）数下限
    maxWindows, // 上限
    // 运行时轮换状态（持久化）
    rotation: { currentSet: null, windowsDone: 0, windowsTarget: 0 },
  };
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

export function updateAccount(id, patch) {
  const accounts = getAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  // profileDir 与 id 不允许被随意改写；proxyId / proxy 已废弃（代理跟着分组走）
  const { id: _i, profileDir: _p, proxyId: _x, proxy: _legacyProxy, ...safe } = patch;
  accounts[idx] = { ...accounts[idx], ...safe };
  saveAccounts(accounts);
  return accounts[idx];
}

export function removeAccount(id) {
  const accounts = getAccounts();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  saveAccounts(next);
  return true;
}

// ---------- groups (账号分组) ----------
// 分组既是可筛选的标签，也是**代理归属的唯一单位**：组内账号统一走该组绑定的节点。
// 允许为空（账号可以不属于任何分组，此时跟随系统网络）。

function normalizeGroup(g) {
  // 旧数据没有这些字段：proxyId 补 null = 跟随系统网络；
  // timezone/locale 补 null = 由节点出口 IP 自动探测（探测失败则用浏览器默认）。
  return { proxyId: null, timezone: null, locale: null, ...g };
}

export function getGroups() {
  const data = readJsonFile(GROUPS_FILE, { groups: [] });
  return Array.isArray(data.groups) ? data.groups.map(normalizeGroup) : [];
}

export function getGroup(id) {
  return getGroups().find((g) => g.id === id) ?? null;
}

/**
 * 账号实际使用的代理节点 id。代理绑在分组上，账号自己不再持有 proxyId：
 * 未分组 / 分组未绑节点 => null（跟随系统默认网络）。
 */
export function effectiveProxyId(account) {
  if (!account?.groupId) return null;
  return getGroup(account.groupId)?.proxyId ?? null;
}

function saveGroups(groups) {
  writeJsonFile(GROUPS_FILE, { groups });
}

function migrationGroupId(sourceKey, proxyId) {
  const digest = createHash("sha256")
    .update(`${sourceKey}\0${proxyId}`)
    .digest("hex")
    .slice(0, 16);
  return `grp_migr_${digest}`;
}

function uniqueGroupName(groups, preferred) {
  const used = new Set(groups.map((g) => g.name));
  if (!used.has(preferred)) return preferred;
  let n = 2;
  while (used.has(`${preferred} ${n}`)) n++;
  return `${preferred} ${n}`;
}

/**
 * 生成旧账号代理到分组代理的迁移结果，不读写文件，便于完整测试。
 *
 * 保留原则：
 * - 同组成员旧出口一致时，直接把代理上提到原分组；
 * - 同组存在不同出口或存在“跟随系统”成员时，按旧 proxyId 拆出迁移分组；
 * - 未分组或引用已删除分组的账号也会进入迁移分组，不会丢失出口；
 * - 旧 proxy 字段是任意代理地址，无法映射到订阅节点。此类账号先停用，
 *   清掉账号级字段，等待用户在分组管理中明确选择节点。
 */
export function planAccountProxyMigration(rawAccounts = [], rawGroups = []) {
  const accounts = Array.isArray(rawAccounts) ? rawAccounts.map((a) => ({ ...a })) : [];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map((g) => normalizeGroup({ ...g }))
    : [];
  const originalGroups = [...groups];
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const stats = {
    boundExistingGroups: 0,
    createdGroups: 0,
    reassignedAccounts: 0,
    disabledManualProxyAccounts: 0,
  };

  // 没有“跟随系统”成员时，原分组可以承接出现最多的旧节点；
  // 其它节点随后拆组。这样既保留所有出口，也尽量少制造新分组。
  for (const g of originalGroups) {
    if (g.proxyId) continue;
    const members = accounts.filter((a) => a.groupId === g.id);
    if (!members.length || members.some((a) => !a.proxyId)) continue;

    const counts = new Map();
    for (const a of members) {
      counts.set(a.proxyId, (counts.get(a.proxyId) ?? 0) + 1);
    }
    const proxyId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (proxyId) {
      g.proxyId = proxyId;
      stats.boundExistingGroups++;
    }
  }

  const migrationGroups = new Map();
  const ensureMigrationGroup = (sourceKey, baseName, proxyId) => {
    const key = `${sourceKey}\0${proxyId}`;
    if (migrationGroups.has(key)) return migrationGroups.get(key);

    const idBase = migrationGroupId(sourceKey, proxyId);
    let id = idBase;
    let suffix = 2;
    while (groupsById.has(id) && groupsById.get(id).proxyId !== proxyId) {
      id = `${idBase}_${suffix++}`;
    }

    let group = groupsById.get(id);
    if (!group) {
      group = {
        id,
        name: uniqueGroupName(groups, `${baseName}（迁移代理）`),
        proxyId,
      };
      groups.push(group);
      groupsById.set(id, group);
      stats.createdGroups++;
    }
    migrationGroups.set(key, group);
    return group;
  };

  for (const a of accounts) {
    const legacyProxyId = a.proxyId || null;
    const sourceGroup = a.groupId ? groupsById.get(a.groupId) : null;

    if (legacyProxyId && sourceGroup?.proxyId !== legacyProxyId) {
      const sourceKey = sourceGroup
        ? sourceGroup.id
        : a.groupId
          ? `missing:${a.groupId}`
          : "ungrouped";
      const baseName = sourceGroup?.name ?? (a.groupId ? `原分组 ${a.groupId}` : "未分组账号");
      const target = ensureMigrationGroup(sourceKey, baseName, legacyProxyId);
      a.groupId = target.id;
      stats.reassignedAccounts++;
    }

    // 旧 proxy 是账号级任意地址，分组模型没有等价的 proxyId 可自动映射。
    // 停用比改走系统网络安全；用户选好分组节点后可再手动启用。
    if (a.proxy && !legacyProxyId) {
      a.enabled = false;
      stats.disabledManualProxyAccounts++;
    }

    delete a.proxyId;
    delete a.proxy;
  }

  return {
    accounts: accounts.map(normalizeAccount),
    groups,
    stats,
  };
}

/**
 * 一次性迁移：代理从「每账号」搬到「每分组」，并保持每个旧 proxyId
 * 账号迁移前后的有效出口不变。
 */
export function migrateAccountProxyToGroup() {
  const rawAccounts = readJsonFile(ACCOUNTS_FILE, { accounts: [] }).accounts ?? [];
  if (!Array.isArray(rawAccounts) || !rawAccounts.some((a) => a?.proxyId || a?.proxy)) return;

  const rawGroups = readJsonFile(GROUPS_FILE, { groups: [] }).groups ?? [];
  const { accounts, groups, stats } = planAccountProxyMigration(rawAccounts, rawGroups);

  // 先落分组再落账号。迁移分组 id 是确定性的，即使两次写入之间进程退出，
  // 下次启动也会复用同一分组而不是重复创建。
  saveGroups(groups);
  saveAccounts(accounts);

  log.info(
    `代理绑定已从账号迁移到分组：${stats.boundExistingGroups} 个原分组已绑定节点，` +
      `${stats.createdGroups} 个迁移分组已创建，${stats.reassignedAccounts} 个账号已重新分组`
  );
  if (stats.disabledManualProxyAccounts) {
    log.warn(
      `${stats.disabledManualProxyAccounts} 个账号使用旧式手工代理地址，已先停用；` +
        "请在分组管理中选择代理节点后再启用"
    );
  }
}

// 用户输入不合法：标记为 badRequest，让 API 层答 400 而不是 500。
function badRequest(msg) {
  const e = new Error(msg);
  e.badRequest = true;
  return e;
}

export function addGroup(name, proxyId = null, extra = {}) {
  const clean = String(name ?? "").trim();
  if (!clean) throw badRequest("分组名称不能为空");
  const groups = getGroups();
  if (groups.some((g) => g.name === clean)) throw badRequest("分组名称已存在");
  const arr = new Uint32Array(2);
  globalThis.crypto.getRandomValues(arr);
  const group = {
    id: "grp_" + arr[0].toString(36) + arr[1].toString(36),
    name: clean,
    proxyId: proxyId || null, // 绑定的代理节点，null = 组内账号跟随系统网络
    // 浏览器时区/语言。null = 按节点出口 IP 自动探测，避免境外 IP 配本机时区。
    timezone: extra.timezone || null,
    locale: extra.locale || null,
  };
  groups.push(group);
  saveGroups(groups);
  return group;
}

/**
 * 更新分组。name / proxyId / timezone / locale 都是可选：只传其中一个就只改那个。
 * proxyId 传 null（或空串）表示解绑，改为跟随系统网络。
 * timezone / locale 传 null 表示恢复"自动按节点探测"。
 */
export function updateGroup(id, patch = {}) {
  const groups = getGroups();
  const g = groups.find((x) => x.id === id);
  if (!g) return null;

  if (patch.name !== undefined) {
    const clean = String(patch.name ?? "").trim();
    if (!clean) throw badRequest("分组名称不能为空");
    if (groups.some((x) => x.name === clean && x.id !== id)) throw badRequest("分组名称已存在");
    g.name = clean;
  }
  if (patch.proxyId !== undefined) {
    const next = patch.proxyId || null;
    // 换了节点，之前探测出来的时区就不再对应了。显式设过的值（手动覆盖）保留，
    // 自动探测出来的要清掉，否则韩国节点会继续套用美国时区。
    if (next !== g.proxyId && !g.tzManual) {
      g.timezone = null;
      g.locale = null;
    }
    g.proxyId = next;
  }
  if (patch.timezone !== undefined) {
    g.timezone = patch.timezone || null;
    // 手动清空 = 恢复自动探测
    g.tzManual = patch.timezone ? true : undefined;
    if (!g.tzManual) delete g.tzManual;
  }
  if (patch.locale !== undefined) {
    g.locale = patch.locale || null;
  }

  saveGroups(groups);
  return g;
}

/**
 * 记录自动探测到的地区。只在用户没手动指定过时写入，
 * 且不覆盖已有值——探测是尽力而为，不该反复改写用户配置。
 */
export function saveDetectedRegion(id, { timezone, locale } = {}) {
  const groups = getGroups();
  const g = groups.find((x) => x.id === id);
  if (!g || g.tzManual) return null;
  if (timezone) g.timezone = timezone;
  if (locale && !g.locale) g.locale = locale;
  saveGroups(groups);
  return g;
}

/**
 * 删除分组。只解绑成员账号（groupId 置空），不动账号本身。
 */
export function removeGroup(id) {
  const groups = getGroups();
  const next = groups.filter((g) => g.id !== id);
  if (next.length === groups.length) return false;
  saveGroups(next);

  const accounts = getAccounts();
  let touched = false;
  for (const a of accounts) {
    if (a.groupId === id) {
      a.groupId = null;
      touched = true;
    }
  }
  if (touched) saveAccounts(accounts);
  return true;
}

// ---------- conversations ----------
export function getConversations() {
  const data = readJsonFile(CONV_FILE, { sets: {} });
  return data.sets ?? {};
}

export function saveConversationSet(name, set) {
  const sets = getConversations();
  sets[name] = set;
  writeJsonFile(CONV_FILE, { sets });
  return sets[name];
}

export function removeConversationSet(name) {
  const sets = getConversations();
  if (!sets[name]) return false;
  delete sets[name];
  writeJsonFile(CONV_FILE, { sets });
  return true;
}

// ---------- settings (调度参数等) ----------
const DEFAULT_SETTINGS = {
  intervalMinutes: 180,
  jitterMinutes: 30,
  headless: true,
  statusCheckMinutes: 15,
  // “打开网页”窗口的兜底自动关闭时间（分钟）。0 = 不限时，由用户手动关闭。
  openPageTimeoutMinutes: 0,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJsonFile(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJsonFile(SETTINGS_FILE, next);
  return next;
}
