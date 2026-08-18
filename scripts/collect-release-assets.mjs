#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export function collectReleaseAssets({
  releaseDirectory,
  complianceDirectory,
  outputDirectory,
  channel,
  extras = [],
} = {}) {
  const releaseRoot = requireDirectory(releaseDirectory, "VeloPack release directory");
  const complianceRoot = requireDirectory(complianceDirectory, "Compliance directory");
  const outputRoot = path.resolve(outputDirectory ?? "");
  if (!outputDirectory || !channel) throw new Error("Output directory and channel are required");
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) {
    throw new Error(`Collected asset output must be a new or empty directory: ${outputRoot}`);
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  const assetManifest = path.join(releaseRoot, `assets.${channel}.json`);
  if (!fs.existsSync(assetManifest)) {
    throw new Error(`VeloPack asset manifest is missing: ${assetManifest}`);
  }
  const manifest = JSON.parse(fs.readFileSync(assetManifest, "utf8"));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error(`VeloPack produced no new assets for channel ${channel}`);
  }

  const copied = new Map();
  for (const asset of manifest) {
    const relative = asset.RelativeFileName ?? asset.relativeFileName;
    if (typeof relative !== "string" || path.basename(relative) !== relative) {
      throw new Error(`Unsafe VeloPack asset name: ${relative ?? "<missing>"}`);
    }
    copyUnique(path.join(releaseRoot, relative), outputRoot, copied);
    const signature = path.join(releaseRoot, `${relative}.minisig`);
    if (fs.existsSync(signature)) copyUnique(signature, outputRoot, copied);
  }

  for (const name of [
    `releases.${channel}.json`,
    channel === "win" ? "RELEASES" : `RELEASES-${channel}`,
  ]) {
    const source = path.join(releaseRoot, name);
    if (name.startsWith("releases.") || fs.existsSync(source)) {
      copyUnique(source, outputRoot, copied);
      const signature = `${source}.minisig`;
      if (fs.existsSync(signature)) copyUnique(signature, outputRoot, copied);
    }
  }

  for (const extra of extras) copyUnique(path.resolve(extra), outputRoot, copied);
  for (const file of walkFiles(complianceRoot)) copyUnique(file, outputRoot, copied);
  return [...copied.keys()].sort();
}

function requireDirectory(value, label) {
  const resolved = path.resolve(value ?? "");
  if (!value || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function copyUnique(source, outputRoot, copied) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Release asset does not exist: ${source}`);
  }
  const name = path.basename(source);
  const previous = copied.get(name);
  if (previous && path.resolve(previous) !== path.resolve(source)) {
    throw new Error(`Two release assets have the same name: ${name}`);
  }
  if (previous) return;
  fs.copyFileSync(source, path.join(outputRoot, name));
  copied.set(name, source);
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      releases: { type: "string" },
      compliance: { type: "string" },
      output: { type: "string" },
      channel: { type: "string" },
      extra: { type: "string", multiple: true, default: [] },
    },
  });
  const files = collectReleaseAssets({
    releaseDirectory: values.releases,
    complianceDirectory: values.compliance,
    outputDirectory: values.output,
    channel: values.channel,
    extras: values.extra,
  });
  console.log(`Collected ${files.length} release assets for ${values.channel}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
