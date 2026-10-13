import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { compileGroupPathPlan } from "../src/network/groupPathPlan.js";
import { compileWfpResourcePlan } from "../src/network/wfpResourcePlan.js";

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

test("native directory observation binds to its registered v4 resource path", options, t => {
  const f = fixture(t);
  const manifest = success("runtime-manifest", f.chrome);
  // TEMP may contain ADMINI~1; the v4 registry requires the full path spelling.
  const programRoot = fs.realpathSync.native(f.root);
  const raw = { isolationModel: "group_path_v1", installationId: "00000000-0000-4000-8000-000000000001",
    programRoot, registrations: [{ userSid: "S-1-5-21-1-2-3-1001", dataDirectoryId: "00000000-0000-4000-8000-000000000002",
      groupId: "grp_test", chrome: manifest, proxies: [{ generation: 1, role: "active", listenerPort: 23001, sha256: "a".repeat(64),
        raw: { type: "http", server: "test.example", port: 443 }, approvedAddress: "192.0.2.1" }] }] };
  const group = compileGroupPathPlan(raw).groups[0];
  const directory = path.dirname(group.chromePath);
  assert.ok(directory.startsWith(programRoot + path.sep));
  fs.mkdirSync(directory, { recursive: true });
  for (const file of manifest.files) fs.copyFileSync(path.join(f.chrome, file.relativePath), path.join(directory, file.relativePath));
  const observation = success("runtime-report", directory);
  const resources = compileWfpResourcePlan(raw, { runtimeObservations: [observation] });
  assert.equal(resources.preflight.chrome[0].status, "matched_observation");
  assert.equal(resources.launchAuthorization, "not_issued");
  // Identical source bytes at an unregistered path cannot stand in for the copy.
  const source = success("runtime-report", f.chrome);
  assert.throws(() => compileWfpResourcePlan(raw, { runtimeObservations: [source] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  fs.writeFileSync(path.join(directory, "resources.pak"), "changed bytes!");
  const changed = success("runtime-report", directory);
  assert.throws(() => compileWfpResourcePlan(raw, { runtimeObservations: [changed] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
});

test("native program reports bind real proxy and Agent files and detect changed bytes", options, t => {
  const f = fixture(t); const programRoot = fs.realpathSync.native(f.root);
  const bytes = Buffer.from("synthetic program, never executed");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const controllerPath = path.join(programRoot, "node.exe"); fs.writeFileSync(controllerPath, bytes);
  const identity = { userSid: "S-1-5-21-1-2-3-1001", dataDirectoryId: "00000000-0000-4000-8000-000000000002" };
  const raw = { isolationModel: "group_path_v1", installationId: "00000000-0000-4000-8000-000000000001", programRoot,
    controllers: [{ ...identity, path: controllerPath, sha256 }],
    registrations: [{ ...identity, groupId: "grp_test", chrome: success("runtime-manifest", f.chrome),
      proxies: [{ generation: 1, role: "active", listenerPort: 23001, sha256,
        raw: { type: "http", server: "node.example", port: 443 }, approvedAddress: "192.0.2.1" }] }] };
  const proxyPath = compileGroupPathPlan(raw).groups[0].proxies[0].proxyPath;
  assert.ok(proxyPath.startsWith(programRoot + path.sep));
  fs.mkdirSync(path.dirname(proxyPath), { recursive: true }); fs.writeFileSync(proxyPath, bytes);
  const proxy = success("program-report", proxyPath); const controller = success("program-report", controllerPath);
  assert.equal(proxy.path, proxyPath); assert.equal(proxy.sizeBytes, bytes.length); assert.equal(proxy.sha256, sha256);
  assert.ok(Number.isFinite(Date.parse(proxy.observedAt))); assert.equal(proxy.productionReady, false);
  const resources = compileWfpResourcePlan(raw, { programObservations: [proxy, controller] });
  assert.equal(resources.preflight.proxyFiles[0].status, "matched_observation");
  assert.equal(resources.preflight.controllerFiles[0].status, "matched_observation");
  assert.equal(resources.launchAuthorization, "not_issued");
  const alternate = path.join(programRoot, "other.exe"); fs.writeFileSync(alternate, bytes);
  assert.throws(() => compileWfpResourcePlan(raw, { programObservations: [success("program-report", alternate)] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  fs.writeFileSync(proxyPath, Buffer.alloc(bytes.length, "x"));
  assert.throws(() => compileWfpResourcePlan(raw, { programObservations: [success("program-report", proxyPath)] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  assert.equal(run("program-report", path.join(programRoot, "missing.exe")).status, 1);
});

test("native program reports reject hard links, junction ancestors and alternate data streams", options, t => {
  const f = fixture(t); const file = path.join(f.chrome, "resources.pak");
  const hardLink = path.join(f.root, "alias.exe"); fs.linkSync(file, hardLink);
  try {
    const result = run("program-report", file); assert.equal(result.status, 1); assert.match(result.stderr, /hard-linked/u);
  } finally { fs.unlinkSync(hardLink); }
  const junction = path.join(f.root, "junction"); fs.symlinkSync(f.chrome, junction, "junction");
  try {
    const result = run("program-report", path.join(junction, "resources.pak"));
    assert.equal(result.status, 1); assert.match(result.stderr, /reparse/u);
  } finally { fs.unlinkSync(junction); }
  const stream = run("program-report", file + ":alternate");
  assert.equal(stream.status, 1); assert.match(stream.stderr, /alternate data streams/u);
});

test("native TCP observation detects a real occupied port and feeds the offline plan", options, async t => {
  const server = createServer();
  // A bound loopback socket is a positive control; no client or public endpoint is used.
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = server.address().port; const report = success("ports-report");
  assert.equal(report.kind, "tcp_port_observation"); assert.equal(report.scope, "tcp_ipv4_ipv6");
  assert.equal(report.dynamicRanges.length, 2); assert.ok(report.occupiedPorts.includes(port));
  assert.equal(report.portsReserved, false); assert.equal(report.productionReady, false);
  const raw = { isolationModel: "group_path_v1", installationId: "00000000-0000-4000-8000-000000000001", programRoot: "C:\\RuntimeTest",
    registrations: [{ userSid: "S-1-5-21-1-2-3-1001", dataDirectoryId: "00000000-0000-4000-8000-000000000002", groupId: "grp_test",
      chrome: { version: "1.0.0.0", files: [{ relativePath: "chrome.exe", sizeBytes: 1, sha256: "a".repeat(64) }] },
      proxies: [{ generation: 1, role: "active", listenerPort: port, sha256: "b".repeat(64),
        raw: { type: "http", server: "node.example", port: 443 }, approvedAddress: "192.0.2.1" }] }] };
  const resources = compileWfpResourcePlan(raw, { portObservation: report });
  assert.equal(resources.preflight.ports.entries[0].status, "conflict_observed");
  assert.ok(resources.preflight.ports.entries[0].reasons.includes("occupied"));
  assert.equal(resources.launchAuthorization, "not_issued");
});
