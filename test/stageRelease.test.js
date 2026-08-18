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

test("cross-platform stage uses RID-specific executable names and immutable Agent layout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-stage-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, "desktop");
  const inputs = path.join(root, "inputs");
  const output = path.join(root, "stage");
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(desktop, "GptAccountKeeper.Desktop"), "desktop");
  fs.chmodSync(path.join(desktop, "GptAccountKeeper.Desktop"), 0o755);
  fs.writeFileSync(path.join(desktop, "debug.pdb"), "debug");
  for (const name of ["node", "mihomo", "node-license", "mihomo-license"]) {
    fs.writeFileSync(path.join(inputs, name), name);
  }

  stageRelease({
    version: "2.3.4",
    rid: "linux-x64",
    desktopDirectory: desktop,
    nodeExecutable: path.join(inputs, "node"),
    nodeLicense: path.join(inputs, "node-license"),
    mihomoExecutable: path.join(inputs, "mihomo"),
    mihomoLicense: path.join(inputs, "mihomo-license"),
    outputDirectory: output,
    installDependencies: false,
    verify: true,
  });

  assert.equal(fs.readFileSync(path.join(output, "GptAccountKeeper.Desktop"), "utf8"), "desktop");
  assert.equal(fs.existsSync(path.join(output, "debug.pdb")), false);
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
});
