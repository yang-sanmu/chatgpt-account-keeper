export const ICLOUD_DEFAULT_CONFIG = Object.freeze({ enabled: false, mode: "single", batchSize: 5, intervalMinutes: 15, label: "G", note: "", networkMode: "direct" });
export const HOUR = 60 * 60 * 1000;

export class IcloudError extends Error {
  constructor(kind, message, retryAt = null) { super(message); this.kind = kind; this.retryAt = retryAt; this.badRequest = kind === "validation"; }
}

export function validateIcloudConfig(value) {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !Object.hasOwn(ICLOUD_DEFAULT_CONFIG, key))) {
    throw new IcloudError("validation", "无效的 iCloud 配置");
  }
  const config = { ...ICLOUD_DEFAULT_CONFIG, ...value };
  if (!["single", "batch", "until_limit"].includes(config.mode)) throw new IcloudError("validation", "无效的申请模式");
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 5) throw new IcloudError("validation", "每轮申请数量须为 1–5 个");
  if (typeof config.enabled !== "boolean" || !Number.isInteger(config.intervalMinutes) || config.intervalMinutes < 1 || config.intervalMinutes > 1440) {
    throw new IcloudError("validation", "申请间隔须为 1–1440 分钟的整数");
  }
  if (typeof config.label !== "string" || !config.label.trim() || config.label.length > 100) throw new IcloudError("validation", "固定标签必填，最多 100 个字符");
  if (typeof config.note !== "string" || config.note.length > 1000) throw new IcloudError("validation", "固定 iCloud 备注最多 1000 个字符");
  if (!["direct", "system", "inherit"].includes(config.networkMode)) throw new IcloudError("validation", "无效的网络模式");
  return { ...config, label: config.label.trim() };
}

// The response shape was verified against the user's iCloud.com.cn list response.
// Reject the entire snapshot on schema drift; never turn an error into an empty list.
export function parseIcloudList(body) {
  if (body?.success !== true || !Array.isArray(body.result?.hmeEmails)) throw new IcloudError("format", "iCloud 列表格式不受支持，已保留上次同步数据");
  const ids = new Set(); const addresses = new Set();
  return body.result.hmeEmails.map(row => {
    if (!row || typeof row.anonymousId !== "string" || !row.anonymousId || row.anonymousId.length > 200 ||
        typeof row.hme !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.hme) || row.hme.length > 320 ||
        typeof row.label !== "string" || typeof row.note !== "string" || typeof row.isActive !== "boolean" ||
        !Number.isSafeInteger(row.createTimestamp) || row.createTimestamp < 0 || !Number.isFinite(new Date(row.createTimestamp).getTime()) ||
        ids.has(row.anonymousId) || addresses.has(row.hme.toLowerCase())) {
      throw new IcloudError("format", "iCloud 邮箱记录不完整或重复，已保留上次同步数据");
    }
    ids.add(row.anonymousId); addresses.add(row.hme.toLowerCase());
    return { id: row.anonymousId, email: row.hme, label: row.label, cloudNote: row.note,
      remoteState: row.isActive ? "active" : "inactive", createdAt: new Date(row.createTimestamp).toISOString() };
  });
}

export function mergeIcloudEmails(previous, incoming, createdEmail = null) {
  const existing = new Map(previous.map(row => [row.id, row]));
  const merged = incoming.map(row => {
    const old = existing.get(row.id);
    if (old && old.email.toLowerCase() !== row.email.toLowerCase()) throw new IcloudError("format", "iCloud 地址标识发生变化，已暂停同步");
    existing.delete(row.id);
    return { ...row, localNote: old?.localNote ?? "",
      usage: old?.usage ?? (row.email.toLowerCase() === createdEmail?.toLowerCase() ? "unused" : "unknown") };
  });
  for (const row of existing.values()) merged.push({ ...row, remoteState: "missing" });
  return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.email.localeCompare(b.email));
}

export function retryAfterTime(value, now = Date.now()) {
  if (!value) return now + HOUR;
  const seconds = Number(value);
  const at = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(at) ? Math.max(now + 60_000, at) : now + HOUR;
}

export function classifyIcloudFailure({ status, body, text = "", retryAfter }, now = Date.now()) {
  // Only inspect explicit error fields: labels/notes in successful responses are untrusted user content.
  const errorText = [text, body?.error?.errorCode, body?.error?.errorMessage, body?.error?.message,
    body?.errorCode, body?.errorMessage].filter(value => typeof value === "string").join(" ").slice(0, 4000);
  if (status === 429 || /too many|rate.?limit|throttl|稍后再试|过于频繁|频率|每小时|一小时/i.test(errorText)) {
    return new IcloudError("rate_limit", "iCloud 暂时限制创建频率，冷却后再试", retryAfterTime(retryAfter, now));
  }
  if (/maximum|limit.*reach|quota|上限|达到.*限制|太多.*地址/i.test(errorText)) {
    return new IcloudError("limit", "iCloud 提示创建数量达到限制，已暂停；请检查官方页面后手动恢复");
  }
  if ([401, 403, 421, 450].includes(status)) return new IcloudError("auth", "iCloud 会话需要确认，请打开浏览器手动登录或完成验证");
  if ((status && status >= 400) || body?.success === false) return new IcloudError("service", "iCloud 请求失败，请稍后重试或查看官方页面");
  return null;
}

export function nextAllowedCreate(state, now) {
  const attempts = state.attempts.filter(at => at > now - HOUR).sort((a, b) => a - b);
  const localCap = state.config.mode !== "until_limit" && attempts.length >= 5;
  return Math.max(now, state.cooldownUntil ?? 0, localCap ? attempts[attempts.length - 5] + HOUR + 1000 : 0);
}

export function initialIcloudData() {
  return { config: { ...ICLOUD_DEFAULT_CONFIG }, accountKey: null, emails: [], attempts: [], pendingCreate: null,
    status: "not_logged_in", nextRunAt: null, cooldownUntil: null, lastSyncAt: null, lastMessage: "请打开 iCloud 手动登录", failures: 0, history: [] };
}

export class SqliteIcloudStore {
  constructor(repository) { this.db = repository.db; }
  load() { const row = this.db.prepare("SELECT data_json FROM icloud_state WHERE id=1").get(); return row ? JSON.parse(row.data_json) : initialIcloudData(); }
  save(value) { this.db.prepare("INSERT INTO icloud_state(id,data_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json").run(JSON.stringify(value)); }
}
