import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createLegacyFixture } from "./migrationPlan.test.js";

test("migration probe accepts a selected profiles directory and returns a secret-free preview", (t) => {
  const fixture = createLegacyFixture(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-probe-target-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("src/agent/migrationProbe.js"),
      "--legacy-root",
      path.join(fixture.root, "profiles"),
      "--data-root",
      target,
    ],
    { cwd: path.resolve("."), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const preview = JSON.parse(result.stdout.trim());
  assert.equal(preview.ok, true);
  assert.equal(preview.selectedProfilesDirectory, true);
  assert.equal(preview.sourceRoot, fixture.root);
  assert.equal(preview.counts.accounts, 1);
  assert.equal(preview.counts.profiles, 2);
  assert.equal(preview.activeLocks.some((item) => item.name === "a1"), true);
  assert.equal(result.stdout.includes("token=secret"), false);
  assert.equal(result.stdout.includes("password"), false);
});
