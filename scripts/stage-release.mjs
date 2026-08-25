#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { stampAgentVersion } from "./stamp-agent-version.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const supportedRids = new Set(["win-x64", "linux-x64", "osx-arm64", "osx-x64"]);
const nativePrebuildByRid = {
  "win-x64": "win32-x64.node",
  "linux-x64": "linux-x64.node",
  "osx-arm64": "darwin-arm64.node",
  "osx-x64": "darwin-x64.node",
};

export function stageRelease({
  version,
  rid,
  nodeExecutable,
  nodeLicense,
  mihomoExecutable,
  mihomoLicense,
  // Windows 专属：创建时纳管 Chrome 的 broker。它是 per-run Job 的唯一持有者，
  // 缺了它 Windows Agent 会在接受 IPC 前 fail-closed，所以必须随包发布。
  chromeLauncherExecutable,
  outputDirectory,
  installDependencies = true,
  verify = true,
} = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error(`Invalid release version: ${version ?? ""}`);
  }
  if (!supportedRids.has(rid)) throw new Error(`Unsupported release RID: ${rid}`);

  const nodeFile = requireFile(nodeExecutable, "Node executable");
  const nodeLicenseFile = requireFile(nodeLicense, "Node license");
  const mihomoFile = requireFile(mihomoExecutable, "mihomo executable");
  const mihomoLicenseFile = requireFile(mihomoLicense, "mihomo license");
  const windowsRid = rid === "win-x64";
  // POSIX 用进程组，不需要 broker；Windows 上它是硬依赖。
  const chromeLauncherFile = windowsRid
    ? requireFile(chromeLauncherExecutable, "chrome-launcher executable")
    : null;
  const outputRoot = path.resolve(outputDirectory ?? "");
  if (!outputDirectory) throw new Error("Output directory is required");
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) {
    throw new Error(`Release stage must be a new or empty directory: ${outputRoot}`);
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  // outputRoot is the exact directory mapped to Tauri's $RESOURCE root. The
  // application binary and installer are produced later by `tauri build`; copying
  // the legacy Avalonia publish directory here would silently ship two managers.
  const agentRoot = path.join(outputRoot, "agent");
  const agentSource = path.join(agentRoot, "src");
  const agentRuntime = path.join(agentRoot, "runtime");
  const agentBin = path.join(agentRoot, "bin");
  const agentConfig = path.join(agentRoot, "config");
  const agentContracts = path.join(agentRoot, "contracts");
  const licenseRoot = path.join(outputRoot, "licenses");
  for (const directory of [
    agentSource,
    agentRuntime,
    agentBin,
    agentConfig,
    agentContracts,
    licenseRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  copyTree(path.join(repositoryRoot, "src"), agentSource, {
    include(relative, entry) {
      if (entry.isDirectory()) return true;
      return relative !== "server.js" && relative !== "cli.js";
    },
  });

  copyFile(path.join(repositoryRoot, "package.json"), path.join(agentRoot, "package.json"));
  copyFile(path.join(repositoryRoot, "package-lock.json"), path.join(agentRoot, "package-lock.json"));
  stampAgentVersion(
    path.join(agentRoot, "package.json"),
    path.join(agentRoot, "package-lock.json"),
    version
  );
  copyFile(path.join(repositoryRoot, "config", "selectors.json"), path.join(agentConfig, "selectors.json"));
  for (const contract of ["ipc-v1.schema.json", "ipc-v1.methods.schema.json"]) {
    copyFile(path.join(repositoryRoot, "contracts", contract), path.join(agentContracts, contract));
  }

  const windows = rid === "win-x64";
  const stagedNode = path.join(agentRuntime, windows ? "node.exe" : "node");
  const stagedMihomo = path.join(agentBin, windows ? "mihomo.exe" : "mihomo");
  copyFile(nodeFile, stagedNode);
  copyFile(mihomoFile, stagedMihomo);
  // broker 与 mihomo 同层：Agent 按 fromInstallRoot("bin", ...) 解析它。
  if (chromeLauncherFile) {
    copyFile(chromeLauncherFile, path.join(agentBin, "chrome-launcher.exe"));
  }
  if (!windows) {
    fs.chmodSync(stagedNode, 0o755);
    fs.chmodSync(stagedMihomo, 0o755);
  }
  copyFile(nodeLicenseFile, path.join(licenseRoot, "Node.js-LICENSE.txt"));
  copyFile(mihomoLicenseFile, path.join(licenseRoot, "mihomo-GPL-3.0.txt"));
  copyFile(
    path.join(repositoryRoot, "build", "runtime-versions.json"),
    path.join(licenseRoot, "runtime-versions.json")
  );
  for (const document of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md", "SOURCE.md"]) {
    copyFile(path.join(repositoryRoot, document), path.join(licenseRoot, document));
  }

  if (installDependencies) {
    const npm = npmInvocation();
    run(npm.command, [
      ...npm.prefixArguments,
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      agentRoot,
    ], {
      ...process.env,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    });
    pruneNativePrebuilds(agentRoot, rid);
  }
  if (verify) {
    run(process.execPath, [
      path.join(scriptDirectory, "verify-package.mjs"),
      outputRoot,
      version,
      rid,
    ]);
  }
  return outputRoot;
}

export function pruneNativePrebuilds(agentRoot, rid) {
  const expected = nativePrebuildByRid[rid];
  if (!expected) throw new Error(`Unsupported release RID: ${rid}`);
  const prebuildRoot = path.join(agentRoot, "node_modules", "better-sqlite3", "prebuilds");
  const expectedFile = path.join(prebuildRoot, expected);
  if (!fs.existsSync(expectedFile)) {
    throw new Error(`better-sqlite3 does not contain the required ${rid} prebuild: ${expected}`);
  }
  for (const entry of fs.readdirSync(prebuildRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === expected) continue;
    fs.rmSync(path.join(prebuildRoot, entry.name));
  }
}

function requireFile(value, label) {
  const resolved = path.resolve(value ?? "");
  if (!value || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function copyTree(source, destination, { include = () => true } = {}) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const relative = path.relative(source, sourcePath).split(path.sep).join("/");
    if (!include(relative, entry)) continue;
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release input contains an unsupported symbolic link: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyTree(sourcePath, destinationPath, {
        include(nestedRelative, nestedEntry) {
          const combined = `${relative}/${nestedRelative}`;
          return include(combined, nestedEntry);
        },
      });
    } else if (entry.isFile()) {
      copyFile(sourcePath, destinationPath);
    }
  }
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
}

function npmInvocation() {
  if (process.platform !== "win32") {
    return { command: "npm", prefixArguments: [] };
  }
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) {
    throw new Error(`Could not locate npm-cli.js beside ${process.execPath}`);
  }
  return { command: process.execPath, prefixArguments: [npmCli] };
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      version: { type: "string" },
      rid: { type: "string" },
      node: { type: "string" },
      "node-license": { type: "string" },
      mihomo: { type: "string" },
      "mihomo-license": { type: "string" },
      "chrome-launcher": { type: "string" },
      output: { type: "string" },
    },
  });
  stageRelease({
    version: values.version,
    rid: values.rid,
    nodeExecutable: values.node,
    nodeLicense: values["node-license"],
    mihomoExecutable: values.mihomo,
    mihomoLicense: values["mihomo-license"],
    chromeLauncherExecutable: values["chrome-launcher"],
    outputDirectory: values.output,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
