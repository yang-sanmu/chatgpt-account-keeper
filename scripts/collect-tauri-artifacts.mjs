#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const RID_SPECS = Object.freeze({
  "win-x64": [
    { directory: "nsis", extension: ".exe", name: (version) => `ChatGPT-Account-Keeper_${version}_windows_x86_64-setup.exe`, updater: true },
  ],
  "osx-arm64": [
    { directory: "dmg", extension: ".dmg", name: (version) => `ChatGPT-Account-Keeper_${version}_darwin_aarch64.dmg` },
    { directory: "macos", extension: ".app.tar.gz", name: (version) => `ChatGPT-Account-Keeper_${version}_darwin_aarch64.app.tar.gz`, updater: true },
  ],
  "osx-x64": [
    { directory: "dmg", extension: ".dmg", name: (version) => `ChatGPT-Account-Keeper_${version}_darwin_x86_64.dmg` },
    { directory: "macos", extension: ".app.tar.gz", name: (version) => `ChatGPT-Account-Keeper_${version}_darwin_x86_64.app.tar.gz`, updater: true },
  ],
  "linux-x64": [
    { directory: "appimage", extension: ".AppImage", name: (version) => `ChatGPT-Account-Keeper_${version}_linux_x86_64.AppImage`, updater: true },
    { directory: "deb", extension: ".deb", name: (version) => `ChatGPT-Account-Keeper_${version}_linux_x86_64.deb` },
    { directory: "rpm", extension: ".rpm", name: (version) => `ChatGPT-Account-Keeper_${version}_linux_x86_64.rpm` },
  ],
});

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function collectTauriArtifacts({ bundleRoot, version, rid, outputDirectory, sbom } = {}) {
  if (!SEMVER.test(version ?? "")) throw new Error(`Invalid release version: ${version ?? ""}`);
  const specs = RID_SPECS[rid];
  if (!specs) throw new Error(`Unsupported release RID: ${rid ?? ""}`);
  const root = requireDirectory(bundleRoot, "Tauri bundle root");
  const output = path.resolve(outputDirectory ?? "");
  if (!outputDirectory) throw new Error("Output directory is required");
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
    throw new Error(`Collected asset output must be a new or empty directory: ${output}`);
  }
  fs.mkdirSync(output, { recursive: true });

  const files = walkFiles(root);
  const copied = [];
  for (const spec of specs) {
    const source = findExactlyOne(files, spec.directory, spec.extension);
    const destination = path.join(output, spec.name(version));
    copyFile(source, destination);
    copied.push(destination);
    if (spec.updater) {
      const signature = `${source}.sig`;
      if (!fs.statSync(signature, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Tauri updater signature is missing: ${signature}`);
      }
      if (!fs.readFileSync(signature, "utf8").trim()) {
        throw new Error(`Tauri updater signature is empty: ${signature}`);
      }
      copyFile(signature, `${destination}.sig`);
      copied.push(`${destination}.sig`);
    }
  }

  const sbomFile = path.resolve(sbom ?? "");
  if (!sbom || !fs.statSync(sbomFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Agent SBOM does not exist: ${sbom ?? "<unset>"}`);
  }
  const sbomDestination = path.join(output, `ChatGPT-Account-Keeper_${version}_${rid}-agent.cdx.json`);
  copyFile(sbomFile, sbomDestination);
  copied.push(sbomDestination);
  return copied;
}

function findExactlyOne(files, bundleDirectory, extension) {
  const matches = files.filter((file) => {
    return path.basename(path.dirname(file)).toLowerCase() === bundleDirectory.toLowerCase()
      && file.endsWith(extension)
      && !file.endsWith(`${extension}.sig`);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${bundleDirectory}/*${extension} artifact, found ${matches.length}`);
  }
  return matches[0];
}

function requireDirectory(value, label) {
  const resolved = path.resolve(value ?? "");
  if (!value || !fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
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

function copyFile(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
}

function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      bundles: { type: "string" },
      version: { type: "string" },
      rid: { type: "string" },
      output: { type: "string" },
      sbom: { type: "string" },
    },
  });
  const copied = collectTauriArtifacts({
    bundleRoot: values.bundles,
    version: values.version,
    rid: values.rid,
    outputDirectory: values.output,
    sbom: values.sbom,
  });
  console.log(`Collected ${copied.length} Tauri release assets for ${values.rid}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
