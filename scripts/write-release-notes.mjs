import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeReleaseNotes(value) {
  const normalized = String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (!normalized) {
    throw new Error("release_notes must contain a user-facing update summary");
  }
  return `${normalized}\n`;
}

export function writeReleaseNotes(outputFile, value = process.env.GAK_RELEASE_NOTES) {
  const target = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, normalizeReleaseNotes(value), "utf8");
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFile = process.argv[2];
  if (!outputFile) throw new Error("usage: node scripts/write-release-notes.mjs <output-file>");
  process.stdout.write(`${writeReleaseNotes(outputFile)}\n`);
}
