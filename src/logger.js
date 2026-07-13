import fs from "node:fs";
import path from "node:path";
import { fromRoot, ensureDir } from "./paths.js";

const LOG_DIR = ensureDir(fromRoot("logs"));

function ts() {
  return new Date().toISOString();
}

export function info(msg) {
  console.log(`[${ts()}] ${msg}`);
}

export function warn(msg) {
  console.warn(`[${ts()}] WARN  ${msg}`);
}

export function error(msg) {
  console.error(`[${ts()}] ERROR ${msg}`);
}

/**
 * 把一次对话结果追加写入 logs/<accountId>.jsonl。
 */
export function recordConversation(accountId, entry) {
  const file = path.join(LOG_DIR, `${accountId}.jsonl`);
  const line = JSON.stringify({ time: ts(), ...entry }) + "\n";
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
