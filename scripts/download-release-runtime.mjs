#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(repositoryRoot, "build", "runtime-versions.json");

export function resolveRuntimeDownloads(manifest, rid) {
  const node = manifest.node?.runtimes?.[rid];
  const mihomo = manifest.mihomo?.runtimes?.[rid];
  if (!node || !mihomo) throw new Error(`runtime-versions.json does not support ${rid}`);
  return {
    node: {
      ...node,
      url: `https://nodejs.org/dist/v${manifest.node.version}/${node.archive}`,
    },
    mihomo: {
      ...mihomo,
      url: `https://github.com/MetaCubeX/mihomo/releases/download/v${manifest.mihomo.version}/${mihomo.archive}`,
      licenseUrl: `https://raw.githubusercontent.com/MetaCubeX/mihomo/v${manifest.mihomo.version}/LICENSE`,
    },
  };
}

export function verifySha256(buffer, expected, label) {
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`);
  }
}

export async function downloadReleaseRuntime({ rid, outputDirectory, fetchImpl = fetch } = {}) {
  const outputRoot = path.resolve(outputDirectory ?? "");
  if (!rid || !outputDirectory) {
    throw new Error("RID and output directory are required");
  }
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) {
    throw new Error(`Runtime output must be a new or empty directory: ${outputRoot}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const downloads = resolveRuntimeDownloads(manifest, rid);
  const windows = rid === "win-x64";
  const executableName = windows ? "node.exe" : "node";
  const mihomoName = windows ? "mihomo.exe" : "mihomo";
  const downloadRoot = path.join(outputRoot, "downloads");
  const extractRoot = path.join(outputRoot, "extract");
  const nodeOutput = path.join(outputRoot, "node");
  const mihomoOutput = path.join(outputRoot, "mihomo");
  for (const directory of [downloadRoot, extractRoot, nodeOutput, mihomoOutput]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const nodeArchive = await fetchBuffer(downloads.node.url, fetchImpl);
  verifySha256(nodeArchive, downloads.node.sha256, downloads.node.archive);
  const nodeArchivePath = path.join(downloadRoot, downloads.node.archive);
  fs.writeFileSync(nodeArchivePath, nodeArchive);
  const nodeExtract = path.join(extractRoot, "node");
  fs.mkdirSync(nodeExtract, { recursive: true });
  extractWithTar(nodeArchivePath, nodeExtract);
  const extractedNode = findFile(nodeExtract, executableName);
  const nodeDistributionRoot = windows
    ? path.dirname(extractedNode)
    : path.dirname(path.dirname(extractedNode));
  const extractedNodeLicense = path.join(nodeDistributionRoot, "LICENSE");
  if (!fs.existsSync(extractedNodeLicense)) {
    throw new Error(`Node.js distribution is missing its LICENSE: ${extractedNodeLicense}`);
  }
  copyExecutable(extractedNode, path.join(nodeOutput, executableName), !windows);
  fs.copyFileSync(extractedNodeLicense, path.join(nodeOutput, "LICENSE"));

  const mihomoArchive = await fetchBuffer(downloads.mihomo.url, fetchImpl);
  verifySha256(mihomoArchive, downloads.mihomo.sha256, downloads.mihomo.archive);
  const mihomoArchivePath = path.join(downloadRoot, downloads.mihomo.archive);
  fs.writeFileSync(mihomoArchivePath, mihomoArchive);
  if (downloads.mihomo.format === "gz") {
    copyBufferAsExecutable(gunzipSync(mihomoArchive), path.join(mihomoOutput, mihomoName), !windows);
  } else {
    const mihomoExtract = path.join(extractRoot, "mihomo");
    fs.mkdirSync(mihomoExtract, { recursive: true });
    extractWithTar(mihomoArchivePath, mihomoExtract);
    const extractedMihomo = windows
      ? findOnlyFile(mihomoExtract, (entry) => entry.name.toLowerCase().endsWith(".exe"), "mihomo executable")
      : findFile(mihomoExtract, mihomoName);
    copyExecutable(extractedMihomo, path.join(mihomoOutput, mihomoName), !windows);
  }
  fs.writeFileSync(
    path.join(mihomoOutput, "LICENSE"),
    await fetchBuffer(downloads.mihomo.licenseUrl, fetchImpl),
  );

  return {
    nodeExecutable: path.join(nodeOutput, executableName),
    nodeLicense: path.join(nodeOutput, "LICENSE"),
    mihomoExecutable: path.join(mihomoOutput, mihomoName),
    mihomoLicense: path.join(mihomoOutput, "LICENSE"),
  };
}

async function fetchBuffer(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function extractWithTar(archive, destination) {
  const result = spawnSync("tar", ["-xf", archive, "-C", destination], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar failed with exit code ${result.status}`);
}

function findFile(root, name) {
  return findOnlyFile(root, (entry) => entry.name === name, name);
}

function findOnlyFile(root, predicate, label) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(entry)) matches.push(absolute);
    }
  };
  visit(root);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${root}, found ${matches.length}`);
  }
  return matches[0];
}

function copyExecutable(source, destination, unix) {
  fs.copyFileSync(source, destination);
  if (unix) fs.chmodSync(destination, 0o755);
}

function copyBufferAsExecutable(buffer, destination, unix) {
  fs.writeFileSync(destination, buffer);
  if (unix) fs.chmodSync(destination, 0o755);
}

function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      rid: { type: "string" },
      output: { type: "string" },
    },
  });
  return downloadReleaseRuntime({ rid: values.rid, outputDirectory: values.output });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
