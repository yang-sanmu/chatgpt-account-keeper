#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const PLATFORM_OPTIONS = Object.freeze({
  windows: "windows-x86_64",
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x86_64",
  "linux-appimage": "linux-x86_64-appimage",
});

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function writeLatestJson({
  version,
  notes,
  pubDate = new Date().toISOString(),
  baseUrl,
  artifacts,
  outputFile,
} = {}) {
  if (!SEMVER.test(version ?? "")) throw new Error(`Invalid release version: ${version ?? ""}`);
  if (typeof notes !== "string" || !notes.trim()) throw new Error("Release notes must not be empty");

  const parsedBase = new URL(baseUrl ?? "");
  if (parsedBase.protocol !== "https:") throw new Error("Release asset base URL must use HTTPS");
  const normalizedDate = new Date(pubDate);
  if (Number.isNaN(normalizedDate.valueOf())) throw new Error(`Invalid publication date: ${pubDate}`);
  if (!outputFile) throw new Error("Output file is required");

  const platforms = {};
  for (const [option, platform] of Object.entries(PLATFORM_OPTIONS)) {
    const artifact = path.resolve(artifacts?.[option] ?? "");
    if (!artifacts?.[option] || !fs.statSync(artifact, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing updater artifact for ${platform}: ${artifacts?.[option] ?? "<unset>"}`);
    }
    const signatureFile = `${artifact}.sig`;
    if (!fs.statSync(signatureFile, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing updater signature for ${platform}: ${signatureFile}`);
    }
    const signature = fs.readFileSync(signatureFile, "utf8").trim();
    if (!signature) throw new Error(`Updater signature is empty for ${platform}: ${signatureFile}`);
    platforms[platform] = {
      signature,
      url: `${parsedBase.href.replace(/\/$/, "")}/${encodeURIComponent(path.basename(artifact))}`,
    };
  }

  const manifest = {
    version,
    notes: notes.trim(),
    pub_date: normalizedDate.toISOString(),
    platforms,
  };
  const destination = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      version: { type: "string" },
      "notes-file": { type: "string" },
      "pub-date": { type: "string" },
      "base-url": { type: "string" },
      windows: { type: "string" },
      "darwin-arm64": { type: "string" },
      "darwin-x64": { type: "string" },
      "linux-appimage": { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values["notes-file"] || !fs.statSync(values["notes-file"], { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Release notes file does not exist: ${values["notes-file"] ?? "<unset>"}`);
  }
  writeLatestJson({
    version: values.version,
    notes: fs.readFileSync(values["notes-file"], "utf8"),
    pubDate: values["pub-date"],
    baseUrl: values["base-url"],
    artifacts: Object.fromEntries(Object.keys(PLATFORM_OPTIONS).map((key) => [key, values[key]])),
    outputFile: values.output,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
