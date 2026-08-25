import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pruneNativePrebuilds, stageRelease } from "../scripts/stage-release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("runtime manifest pins every supported release RID", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "build", "runtime-versions.json"), "utf8")
  );
  for (const rid of ["win-x64", "linux-x64", "osx-arm64", "osx-x64"]) {
    for (const component of ["node", "mihomo"]) {
      const runtime = manifest[component].runtimes[rid];
      assert.match(runtime.archive, /\S/);
      assert.match(runtime.sha256, /^[0-9a-f]{64}$/);
      assert.match(runtime.format, /^(?:zip|tar\.xz|tar\.gz|gz)$/);
    }
  }
});

test("native dependency pruning keeps only the requested RID", (t) => {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-native-prebuilds-"));
  t.after(() => fs.rmSync(agentRoot, { recursive: true, force: true }));
  const prebuildRoot = path.join(agentRoot, "node_modules", "better-sqlite3", "prebuilds");
  fs.mkdirSync(prebuildRoot, { recursive: true });
  for (const name of [
    "win32-x64.node",
    "linux-x64.node",
    "darwin-arm64.node",
    "darwin-x64.node",
  ]) {
    fs.writeFileSync(path.join(prebuildRoot, name), name);
  }

  pruneNativePrebuilds(agentRoot, "osx-arm64");
  assert.deepEqual(fs.readdirSync(prebuildRoot), ["darwin-arm64.node"]);
});

test("cross-platform stage creates the exact Tauri resource layout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-stage-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  const output = path.join(root, "stage");
  fs.mkdirSync(inputs, { recursive: true });
  for (const name of ["node", "mihomo", "node-license", "mihomo-license"]) {
    fs.writeFileSync(path.join(inputs, name), name);
  }

  stageRelease({
    version: "2.3.4",
    rid: "linux-x64",
    nodeExecutable: path.join(inputs, "node"),
    nodeLicense: path.join(inputs, "node-license"),
    mihomoExecutable: path.join(inputs, "mihomo"),
    mihomoLicense: path.join(inputs, "mihomo-license"),
    outputDirectory: output,
    installDependencies: false,
    verify: true,
  });

  assert.deepEqual(fs.readdirSync(output).sort(), ["SHA256SUMS", "agent", "licenses"]);
  assert.equal(fs.readFileSync(path.join(output, "agent", "runtime", "node"), "utf8"), "node");
  assert.equal(fs.readFileSync(path.join(output, "agent", "bin", "mihomo"), "utf8"), "mihomo");
  assert.equal(fs.existsSync(path.join(output, "agent", "runtime", "node.exe")), false);
  assert.equal(fs.existsSync(path.join(output, "agent", "src", "server.js")), false);
  assert.equal(fs.existsSync(path.join(output, "agent", "src", "cli.js")), false);
  assert.equal(fs.existsSync(path.join(output, "agent", "src", "agent", "launcher.js")), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, "agent", "package.json"), "utf8")).version,
    "2.3.4"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, "agent", "package-lock.json"), "utf8")).packages[""].version,
    "2.3.4"
  );
  assert.equal(fs.existsSync(path.join(output, "SHA256SUMS")), true);
  // POSIX 用进程组，不需要 broker，也不该凭空出现一个。
  assert.equal(fs.existsSync(path.join(output, "agent", "bin", "chrome-launcher.exe")), false);
});

test("Windows staging 把 chrome-launcher broker 放在 agent/bin，与 mihomo 同层", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-broker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  const output = path.join(root, "stage");
  fs.mkdirSync(inputs, { recursive: true });
  for (const name of ["node.exe", "mihomo.exe", "node-license", "mihomo-license", "chrome-launcher.exe"]) {
    fs.writeFileSync(path.join(inputs, name), name);
  }

  stageRelease({
    version: "2.3.4",
    rid: "win-x64",
    nodeExecutable: path.join(inputs, "node.exe"),
    nodeLicense: path.join(inputs, "node-license"),
    mihomoExecutable: path.join(inputs, "mihomo.exe"),
    mihomoLicense: path.join(inputs, "mihomo-license"),
    chromeLauncherExecutable: path.join(inputs, "chrome-launcher.exe"),
    outputDirectory: output,
    installDependencies: false,
    verify: true,
  });

  // Agent 按 fromInstallRoot("bin", ...) 解析 broker，所以必须与 mihomo 同层。
  assert.equal(
    fs.readFileSync(path.join(output, "agent", "bin", "chrome-launcher.exe"), "utf8"),
    "chrome-launcher.exe"
  );
  assert.equal(fs.existsSync(path.join(output, "agent", "bin", "mihomo.exe")), true);
});

test("Windows staging 缺少 broker 时必须直接失败，不产出半个包", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-nobroker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  fs.mkdirSync(inputs, { recursive: true });
  for (const name of ["node.exe", "mihomo.exe", "node-license", "mihomo-license"]) {
    fs.writeFileSync(path.join(inputs, name), name);
  }

  // broker 缺失会让安装版的 Windows Agent 在接受 IPC 前 fail-closed，等于整个安装
  // 不可用。这必须在打包阶段就暴露，而不是留给用户。
  assert.throws(
    () => stageRelease({
      version: "2.3.4",
      rid: "win-x64",
      nodeExecutable: path.join(inputs, "node.exe"),
      nodeLicense: path.join(inputs, "node-license"),
      mihomoExecutable: path.join(inputs, "mihomo.exe"),
      mihomoLicense: path.join(inputs, "mihomo-license"),
      outputDirectory: path.join(root, "stage"),
      installDependencies: false,
      verify: false,
    }),
    /chrome-launcher/i
  );
});
