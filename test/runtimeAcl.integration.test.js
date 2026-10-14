import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const executable = fileURLToPath(new URL("../tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe", import.meta.url));
const options = { skip: process.platform !== "win32" || !fs.existsSync(executable) ? "Requires published Windows ACL tool" : false };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-acl-integration-"));
  const directory = path.join(root, "parent", "runtime"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "synthetic.exe"), "unsigned fixture; never executed");
  fs.mkdirSync(path.join(directory, "empty"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory: fs.realpathSync.native(directory) };
}
function run(directory) {
  const result = spawnSync(executable, ["acl-report", directory], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.ifError(result.error); return result;
}
function report(directory) {
  const result = run(directory); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test("ACL report inventories unsigned files, empty directories and ancestors without changing them", options, t => {
  const f = fixture(t); const before = report(f.directory); const after = report(f.directory);
  assert.equal(before.kind, "runtime_acl_observation"); assert.equal(before.directory.toLowerCase(), f.directory.toLowerCase());
  assert.ok(Number.isFinite(Date.parse(before.observedAt)));
  assert.deepEqual(before.entries, after.entries); // includes owner and raw DACL
  assert.deepEqual(before.entries.filter(e => e.scope === "file").map(e => path.basename(e.path)), ["synthetic.exe"]);
  assert.equal(before.entries.filter(e => e.scope === "directory").length, 2);
  const ancestors = [];
  for (let current = path.dirname(f.directory); ; current = path.dirname(current)) {
    ancestors.push(current.toLowerCase()); if (current === path.dirname(current)) break;
  }
  assert.deepEqual(before.entries.filter(e => e.scope === "ancestor").map(e => e.path.toLowerCase()).sort(), ancestors.sort());
  assert.equal(before.effectiveAccessChecked, false); assert.equal(before.aclModified, false);
  assert.equal(before.productionReady, false); assert.equal(before.launchAuthorization, "not_issued");
  assert.equal(fs.readFileSync(path.join(f.directory, "synthetic.exe"), "utf8"), "unsigned fixture; never executed");
});

test("ACL report identifies a real file write grant and ancestor child-deletion grant", options, t => {
  const f = fixture(t);
  // Modify only this disposable fixture; do not change host directories or deny access.
  const setup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $fixtureRoot = [IO.Path]::GetFullPath($env:KEEPER_ACL_TEST_ROOT)
    $tempRoot = [IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ([IO.Path]::GetDirectoryName($fixtureRoot) -ne $tempRoot -or [IO.Path]::GetFileName($fixtureRoot) -notlike 'keeper-acl-integration-*') {
      throw 'Invalid ACL fixture root'
    }
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $file = Join-Path $fixtureRoot 'parent/runtime/synthetic.exe'
    $fileAcl = [IO.File]::GetAccessControl($file)
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::WriteData, [Security.AccessControl.AccessControlType]::Allow))
    [IO.File]::SetAccessControl($file, $fileAcl)
    $parent = Join-Path $fixtureRoot 'parent'
    $parentAcl = [IO.Directory]::GetAccessControl($parent)
    $parentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles, [Security.AccessControl.AccessControlType]::Allow))
    [IO.Directory]::SetAccessControl($parent, $parentAcl)
  `], { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, KEEPER_ACL_TEST_ROOT: f.root } });
  assert.ifError(setup.error); assert.equal(setup.status, 0, setup.stderr);
  const observed = report(f.directory);
  for (const target of [path.join(f.directory, "synthetic.exe"), path.dirname(f.directory)]) {
    const entry = observed.entries.find(e => e.path.toLowerCase() === target.toLowerCase());
    assert.ok(entry.findings.some(finding => finding.code === "write_grant_requires_review" && finding.sid === "S-1-5-32-545"));
  }
  assert.equal(observed.status, "review_required");
  assert.deepEqual(report(f.directory).entries, observed.entries);
});

test("ACL report rejects linked trees and missing paths without partial reports", options, t => {
  const f = fixture(t);
  const hardLink = path.join(f.root, "alias.exe"); fs.linkSync(path.join(f.directory, "synthetic.exe"), hardLink);
  try {
    const result = run(f.directory); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /hard-linked/u);
  } finally { fs.unlinkSync(hardLink); }
  const junction = path.join(f.root, "junction"); fs.symlinkSync(f.directory, junction, "junction");
  try {
    const result = run(junction); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /reparse/u);
  } finally { fs.unlinkSync(junction); }
  const missing = run(path.join(f.root, "missing")); assert.equal(missing.status, 1); assert.equal(missing.stdout, "");
});
