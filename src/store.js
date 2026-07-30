import fs from "node:fs";
import { fromRoot, ensureDir } from "./paths.js";

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
// 规范化账号：为旧数据补齐轮换相关字段，去掉已废弃的 conversationSet。
function normalizeAccount(a) {
  const { conversationSet, ...rest } = a;
  return {
    switchRule: "random",
    minWindows: 1,
    maxWindows: 3,
    // 分组与定向代理都允许为空：空 = 未分组 / 跟随系统网络
    groupId: null,
    proxyId: null,
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
  writeJsonFile(ACCOUNTS_FILE, { accounts });
}

function slugId() {
  const arr = new Uint32Array(2);
  globalThis.crypto.getRandomValues(arr);
  return "acc_" + arr[0].toString(36) + arr[1].toString(36);
}

export function addAccount({
  note = "",
  proxy = null,
  groupId = null,
  proxyId = null,
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
    proxy,
    groupId, // 所属分组，null = 未分组
    proxyId, // 定向代理节点，null = 跟随系统网络
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
  // profileDir 与 id 不允许被随意改写
  const { id: _i, profileDir: _p, ...safe } = patch;
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
// 分组只是给账号加个可筛选的标签，允许为空（账号可以不属于任何分组）。

export function getGroups() {
  const data = readJsonFile(GROUPS_FILE, { groups: [] });
  return Array.isArray(data.groups) ? data.groups : [];
}

function saveGroups(groups) {
  writeJsonFile(GROUPS_FILE, { groups });
}

// 用户输入不合法：标记为 badRequest，让 API 层答 400 而不是 500。
function badRequest(msg) {
  const e = new Error(msg);
  e.badRequest = true;
  return e;
}

export function addGroup(name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw badRequest("分组名称不能为空");
  const groups = getGroups();
  if (groups.some((g) => g.name === clean)) throw badRequest("分组名称已存在");
  const arr = new Uint32Array(2);
  globalThis.crypto.getRandomValues(arr);
  const group = { id: "grp_" + arr[0].toString(36) + arr[1].toString(36), name: clean };
  groups.push(group);
  saveGroups(groups);
  return group;
}

export function renameGroup(id, name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw badRequest("分组名称不能为空");
  const groups = getGroups();
  const g = groups.find((x) => x.id === id);
  if (!g) return null;
  if (groups.some((x) => x.name === clean && x.id !== id)) throw badRequest("分组名称已存在");
  g.name = clean;
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
