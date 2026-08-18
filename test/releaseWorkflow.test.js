import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "windows-release.yml");
const source = fs.readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(source);

test("release workflow builds every supported RID and aggregates once", () => {
  assert.equal(workflow.name, "Cross-platform release candidate");
  assert.ok(workflow.jobs.package);
  assert.ok(workflow.jobs.linux);
  assert.ok(workflow.jobs.aggregate);
  assert.deepEqual(
    workflow.jobs.macos.strategy.matrix.include.map((entry) => entry.rid).sort(),
    ["osx-arm64", "osx-x64"],
  );
  assert.deepEqual(workflow.jobs.aggregate.needs, ["package", "macos", "linux"]);
});

test("only the aggregate job may create a GitHub release", () => {
  assert.equal(source.includes("vpk upload github"), false);
  assert.equal((source.match(/gh release create/g) ?? []).length, 1);
  assert.match(source, /UNSIGNED-win-x64/);
  assert.match(source, /UNSIGNED-\$\{\{ matrix\.rid \}\}/);
  assert.match(source, /UNSIGNED-linux-x64/);
});
