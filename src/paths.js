import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), "..");

export function fromRoot(...segs) {
  return path.join(ROOT, ...segs);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(relPath) {
  const abs = fromRoot(relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}
