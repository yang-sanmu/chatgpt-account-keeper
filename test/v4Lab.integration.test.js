import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compileGroupPathPlan } from "../src/network/groupPathPlan.js";
import { compileWfpResourcePlan } from "../src/network/wfpResourcePlan.js";

const executable = fileURLToPath(new URL("../tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe", import.meta.url));
const options = { skip: process.platform !== "win32" || !fs.existsSync(executable) ? "Requires published Windows lab tool" : false };
function run(...args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error); return result;
}
function success(...args) {
  const result = run(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-v4-lab-"));
  t.after(() => { assert.equal(path.dirname(temporary), os.tmpdir()); fs.rmSync(temporary, { recursive: true, force: true }); });
  const root = fs.realpathSync.native(temporary); fs.writeFileSync(path.join(root, "NETWORK_ISOLATION_LAB_ONLY"), "offline fixture");
  const source = path.join(root, "source"); fs.mkdirSync(source);
  // Valid version metadata for the inventory reader; never execute the copy.
  fs.copyFileSync(executable, path.join(source, "chrome.exe"));
  fs.writeFileSync(path.join(source, "helper.exe"), "synthetic helper");
  fs.writeFileSync(path.join(source, "resources.pak"), "synthetic resources");
  const manifest = success("runtime-manifest", source);
  const ports = success("ports-report");
  const available = [];
  for (let port = 20000; port < 49152 && available.length < 5; port++) {
    if (!ports.occupiedPorts.includes(port) && ![...ports.dynamicRanges, ...ports.excludedRanges].some(r => port >= r.start && port <= r.end)) available.push(port);
  }
  assert.equal(available.length, 5, "Need five unreserved lab ports for read-only preflight");
  const bytes = Buffer.from("synthetic proxy/controller; never executed");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = { userSid: "S-1-5-21-1-2-3-1001", dataDirectoryId: "00000000-0000-4000-8000-000000000002" };
  const raw = { isolationModel: "group_path_v1", installationId: "00000000-0000-4000-8000-000000000001", programRoot: root,
    controllers: [{ ...identity, path: path.join(root, "agent", "node.exe"), sha256 }],
    registrations: ["a", "b"].map((groupId, i) => ({ ...identity, groupId, chrome: manifest,
      browserRuns: [{ accountId: `acc_${i}`, runToken: `run-00000000-0000-4000-8000-00000000000${i}`, debugPort: available[3 + i] }],
      proxies: [{ generation: 1, role: "active", listenerPort: available[i], sha256,
        raw: { type: "http", server: "node.example", port: 443 }, approvedAddress: "192.0.2.1" },
        ...(i ? [] : [{ generation: 2, role: "candidate", listenerPort: available[2], sha256,
          raw: { type: "hysteria2", server: "node.example", port: 443, password: "synthetic" }, approvedAddress: "2001:db8::1" }])] })) };
  const plan = compileGroupPathPlan(raw);
  for (const group of plan.groups) {
    const target = path.dirname(group.chromePath); fs.mkdirSync(target, { recursive: true });
    for (const file of manifest.files) fs.copyFileSync(path.join(source, file.relativePath), path.join(target, file.relativePath));
    for (const proxy of group.proxies) { fs.mkdirSync(path.dirname(proxy.proxyPath), { recursive: true }); fs.writeFileSync(proxy.proxyPath, bytes); }
  }
  for (const controller of plan.controllers) { fs.mkdirSync(path.dirname(controller.path), { recursive: true }); fs.writeFileSync(controller.path, bytes); }
  const resources = compileWfpResourcePlan(raw);
  const input = path.join(root, "resources.json"); fs.writeFileSync(input, JSON.stringify(resources));
  return { root, plan, resources, input, receipt: path.join(root, "receipt.json") };
}

test("v4 receipt binds real inventory and offline lifecycle covers transactions, freeze and stale cleanup", options, t => {
  const f = fixture(t);
  const report = success("v4-prepare", f.input, f.root, f.receipt);
  assert.equal(report.wfpModified, false); assert.equal(report.launchAuthorization, "not_issued");
  const receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
  assert.equal(receipt.kind, "v4_lab_receipt"); assert.equal(receipt.runId, report.runId);
  assert.equal(receipt.filters.length, f.resources.filters.length);
  const original = fs.readFileSync(f.receipt);
  assert.equal(run("v4-prepare", f.input, f.root, f.receipt).status, 1);
  assert.deepEqual(fs.readFileSync(f.receipt), original, "receipt is never overwritten");
  const offline = success("v4-test", f.receipt);
  assert.equal(offline.event, "offline-lifecycle-tests-passed"); assert.equal(offline.wfpModified, false);
  assert.equal(offline.productionReady, false);
  // Only the fake store runs: cleanup must not need surviving executable files.
  for (const group of f.plan.groups) for (const program of [...group.chrome.executablePaths, ...group.proxies.map(p => p.proxyPath)]) fs.unlinkSync(program);
  for (const controller of f.plan.controllers) fs.unlinkSync(controller.path);
  assert.equal(success("v4-test", f.receipt).event, "offline-lifecycle-tests-passed");
});

test("v4 preparation rejects missing lab marker, changed helper or incomplete freeze inventory", options, t => {
  const f = fixture(t); const marker = path.join(f.root, "NETWORK_ISOLATION_LAB_ONLY");
  fs.unlinkSync(marker);
  let result = run("v4-prepare", f.input, f.root, f.receipt);
  assert.equal(result.status, 1); assert.match(result.stderr, /marker/u); assert.equal(fs.existsSync(f.receipt), false);
  fs.writeFileSync(marker, "offline fixture");
  const invalid = structuredClone(f.resources); invalid.groups[0].freezeKeys.pop(); fs.writeFileSync(f.input, JSON.stringify(invalid));
  result = run("v4-prepare", f.input, f.root, f.receipt);
  assert.equal(result.status, 1); assert.match(result.stderr, /freeze/u);
  fs.writeFileSync(f.input, JSON.stringify(f.resources));
  fs.appendFileSync(path.join(path.dirname(f.plan.groups[0].chromePath), "helper.exe"), "changed");
  result = run("v4-prepare", f.input, f.root, f.receipt);
  assert.equal(result.status, 1); assert.match(result.stderr, /hash mismatch/u); assert.equal(fs.existsSync(f.receipt), false);
});

test("v4 mutating commands reject missing acknowledgements before reading files or opening BFE", options, () => {
  for (const args of [["v4-run", "missing.json"], ["v4-cleanup", "missing.json", "--isolated-lab", "--processes-stopped"]]) {
    const result = run(...args); assert.equal(result.status, 1); assert.match(result.stderr, /--isolated-lab.*--resources-retired/u);
    assert.doesNotMatch(result.stderr, /WFP error/u);
  }
});
