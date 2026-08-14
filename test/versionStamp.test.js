import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repository, "scripts", "stamp-agent-version.mjs");

test("release staging stamps the same version into package and lock metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-version-stamp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  fs.writeFileSync(packageFile, JSON.stringify({ name: "fixture", version: "0.0.1" }));
  fs.writeFileSync(lockFile, JSON.stringify({
    name: "fixture",
    version: "0.0.1",
    packages: { "": { name: "fixture", version: "0.0.1" } },
  }));

  const result = spawnSync(
    process.execPath,
    [script, packageFile, lockFile, "1.2.3-alpha.4"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(packageFile, "utf8")).version, "1.2.3-alpha.4");
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(lock.version, "1.2.3-alpha.4");
  assert.equal(lock.packages[""].version, "1.2.3-alpha.4");
});
