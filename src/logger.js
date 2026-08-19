import fs from "node:fs";
import path from "node:path";
import { fromStateRoot, ensureDir } from "./paths.js";

const LOG_DIR = ensureDir(fromStateRoot("logs"));
const RUNTIME_LOG_FILE = process.env.GPT_ACCOUNT_KEEPER_LOG_FILE
  ? path.resolve(process.env.GPT_ACCOUNT_KEEPER_LOG_FILE)
  : null;
let historyBackend = null;
// 历史追加观察者。Agent 用它发 history.appended 事件，
// 否则管理端只能靠反复调用 history.query 才能看到新记录。
const historyObservers = new Set();

export function configureHistoryBackend(backend) {
  if (backend != null && typeof backend !== "object") {
    throw new TypeError("history backend must be an object or null");
  }
  const previous = historyBackend;
  historyBackend = backend;
  return () => {
    historyBackend = previous;
  };
}

export function subscribeHistory(observer) {
  if (typeof observer !== "function") {
    throw new TypeError("history observer must be a function");
  }
  historyObservers.add(observer);
  return () => historyObservers.delete(observer);
}

function notifyHistory(change) {
  for (const observer of historyObservers) {
    try {
      observer(change);
    } catch {
      // 通知失败不能让写历史这件事失败
    }
  }
}

// 控制台时间戳：本地格式，24 小时制，便于直接阅读。
function consoleTs() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

export function redactLogMessage(value) {
  return String(value ?? "")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}/…`;
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/\b(token|password|passwd|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}

function emit(level, msg, consoleMethod) {
  const prefix = level ? `${level} ` : "";
  const line = `[${consoleTs()}] ${prefix}${redactLogMessage(msg)}`;
  try {
    consoleMethod(line);
  } catch {
    // A detached Agent must survive a closed parent stdout/stderr pipe.
  }
  if (!RUNTIME_LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(RUNTIME_LOG_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(RUNTIME_LOG_FILE, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Diagnostics must never become a business-operation failure.
  }
}

export function info(msg) {
  emit("", msg, console.log);
}

export function warn(msg) {
  emit("WARN ", msg, console.warn);
}

export function error(msg) {
  emit("ERROR", msg, console.error);
}

/**
 * 把一次对话结果追加写入 logs/<accountId>.jsonl。
 * time 字段保持 ISO 格式，供前端 fmtLocal 可靠解析。
 */
export function recordConversation(accountId, entry) {
  if (typeof historyBackend?.recordConversation === "function") {
    const stored = historyBackend.recordConversation(accountId, entry);
    notifyHistory({ accountId, entry: stored?.payload ?? entry });
    return stored;
  }
  const file = path.join(LOG_DIR, `${accountId}.jsonl`);
  const record = { time: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  notifyHistory({ accountId, entry: record });
}

/**
 * 读取某账号最近 limit 条对话历史（倒序，最新在前）。
 */
export function readHistory(accountId, limit = 50) {
  if (typeof historyBackend?.readHistory === "function") {
    return historyBackend.readHistory(accountId, limit);
  }
  const file = path.join(LOG_DIR, `${accountId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l));
    } catch {
      // 跳过损坏行
    }
  }
  return parsed.reverse().slice(0, limit);
}

export function listHistoryAccounts() {
  if (typeof historyBackend?.listHistoryAccounts === "function") {
    return historyBackend.listHistoryAccounts();
  }
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const accountId = entry.name.slice(0, -".jsonl".length);
      const lines = fs.readFileSync(path.join(LOG_DIR, entry.name), "utf8").split("\n").filter(Boolean);
      let lastAt = null;
      let lastOk = null;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const last = JSON.parse(lines[index]);
          lastAt = last.finishedAt ?? last.time ?? null;
          lastOk = last.ok == null ? null : !!last.ok;
          break;
        } catch {
          // Skip damaged trailing rows and retain the most recent readable result.
        }
      }
      return { accountId, entryCount: lines.length, lastAt, lastOk, deleted: false };
    })
    .sort((a, b) => String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")));
}
