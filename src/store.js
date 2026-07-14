import fs from "node:fs";
import { fromRoot, ensureDir } from "./paths.js";

// 可读写的配置存储。account/conversation 增删改都经过这里并落盘。
const ACCOUNTS_FILE = fromRoot("config/accounts.json");
const CONV_FILE = fromRoot("config/conversations.json");
const SETTINGS_FILE = fromRoot("config/settings.json");

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
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJsonFile(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJsonFile(SETTINGS_FILE, next);
  return next;
}
