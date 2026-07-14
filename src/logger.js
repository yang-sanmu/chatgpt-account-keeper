import fs from "node:fs";
import path from "node:path";
import { fromRoot, ensureDir } from "./paths.js";

const LOG_DIR = ensureDir(fromRoot("logs"));

// 控制台时间戳：本地格式，24 小时制，便于直接阅读。
function consoleTs() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

export function info(msg) {
  console.log(`[${consoleTs()}] ${msg}`);
}

export function warn(msg) {
  console.warn(`[${consoleTs()}] WARN  ${msg}`);
}

export function error(msg) {
  console.error(`[${consoleTs()}] ERROR ${msg}`);
}

/**
 * 把一次对话结果追加写入 logs/<accountId>.jsonl。
 * time 字段保持 ISO 格式，供前端 fmtLocal 可靠解析。
 */
export function recordConversation(accountId, entry) {
  const file = path.join(LOG_DIR, `${accountId}.jsonl`);
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(file, line, "utf8");
}

/**
 * 读取某账号最近 limit 条对话历史（倒序，最新在前）。
 */
export function readHistory(accountId, limit = 50) {
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
