import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compileGroupPathPlan } from "../src/network/groupPathPlan.js";

const executable = fileURLToPath(new URL("../tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe", import.meta.url));
const options = { skip: process.platform !== "win32" || !fs.existsSync(executable) ? "Requires published Windows inventory tool" : false };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-runtime-integration-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const chrome = path.join(root, "chrome"); fs.mkdirSync(chrome);
  // This is only a versioned PE fixture; it is never executed as Chrome.
  fs.copyFileSync(executable, path.join(chrome, "chrome.exe"));
  fs.writeFileSync(path.join(chrome, "resources.pak"), "test resources");
  return { root, chrome };
}
function run(...args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.ifError(result.error);
  return result;
}
function success(...args) {
  const result = run(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test("runtime inventory verifies all files and feeds the v4 compiler without granting launch", options, t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.chrome, "resources.pak"));
  const manifest = success("runtime-manifest", f.chrome);
  assert.equal(manifest.files.length, 2);
  assert.match(manifest.version, /^\d+\.\d+\.\d+\.\d+$/u);
  const saved = path.join(f.root, "manifest.json"); fs.writeFileSync(saved, JSON.stringify(manifest));
  assert.equal(success("runtime-verify", f.chrome, saved).productionReady, false);
  const plan = compileGroupPathPlan({ isolationModel: "group_path_v1",
    installationId: "00000000-0000-4000-8000-000000000001", programRoot: "C:\\RuntimeTest",
    registrations: [{ userSid: "S-1-5-21-1-2-3-1001", dataDirectoryId: "00000000-0000-4000-8000-000000000002",
      groupId: "grp_test", chrome: manifest, proxies: [{ generation: 1, role: "active", listenerPort: 23001,
        sha256: "a".repeat(64), raw: { type: "http", server: "test.example", port: 443 }, approvedAddress: "192.0.2.1" }] }] });
  assert.equal(plan.launchAuthorization, "not_issued");
  assert.deepEqual(fs.readFileSync(path.join(f.chrome, "resources.pak")), before);
  const space = success("runtime-space", f.chrome);
  assert.ok(Number.isSafeInteger(space.availableBytes) && space.availableBytes >= 0);
  assert.equal(space.productionReady, false);
  fs.writeFileSync(path.join(f.chrome, "resources.pak"), "changed bytes!");
  assert.equal(run("runtime-verify", f.chrome, saved).status, 1);
  fs.writeFileSync(path.join(f.chrome, "resources.pak"), before);
  fs.writeFileSync(path.join(f.chrome, "unexpected.dll"), "extra");
  assert.equal(run("runtime-verify", f.chrome, saved).status, 1);
});

test("runtime inventory rejects an actual hard link even when the alias is outside the scanned tree", options, t => {
  const f = fixture(t);
  fs.linkSync(path.join(f.chrome, "resources.pak"), path.join(f.root, "external-alias"));
  const result = run("runtime-manifest", f.chrome);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hard-linked/u);
});

test("runtime inventory rejects actual junctions inside the tree and in its ancestor path", options, t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  const link = path.join(f.chrome, "junction"); fs.symlinkSync(outside, link, "junction");
  try {
    const result = run("runtime-manifest", f.chrome); assert.equal(result.status, 1); assert.match(result.stderr, /reparse/u);
  } finally { fs.unlinkSync(link); }
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.chrome, alias, "junction");
  try {
    fs.mkdirSync(path.join(f.chrome, "subdir"));
    const result = run("runtime-space", path.join(alias, "subdir"));
    assert.equal(result.status, 1); assert.match(result.stderr, /reparse/u);
  } finally { fs.unlinkSync(alias); }
});
