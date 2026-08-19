import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "windows-release.yml");
const source = fs.readFileSync(workflowPath, "utf8");
const publishScript = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "publish-windows-release.ps1"),
  "utf8",
);
const smokeSource = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "smoke-staged-agent.mjs"),
  "utf8",
);
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
  assert.equal(workflow.on.workflow_dispatch.inputs.release_notes.required, true);
});

test("every VeloPack channel embeds the supplied update summary", () => {
  const packCount = (source.match(/vpk pack/g) ?? []).length;
  const releaseNotesCount = (source.match(/--releaseNotes artifacts\/release-notes\.md/g) ?? []).length;
  assert.equal(packCount, 5);
  assert.equal(releaseNotesCount, packCount);
  assert.equal((source.match(/write-release-notes\.mjs/g) ?? []).length, 4);
  assert.match(source, /--notes-file artifacts\/github-release-notes\.md/);
  assert.match(publishScript, /\[string\] \$ReleaseNotesFile/);
  assert.match(publishScript, /"release_notes=\$releaseNotes"/);
});

test("only the aggregate job may create a GitHub release", () => {
  assert.equal(source.includes("vpk upload github"), false);
  assert.equal((source.match(/gh release create/g) ?? []).length, 1);
  assert.match(source, /UNSIGNED-win-x64/);
  assert.match(source, /UNSIGNED-\$\{\{ matrix\.rid \}\}/);
  assert.match(source, /UNSIGNED-linux-x64/);
});

test("Unix release smoke and AppImage compression remain runnable on native hosts", () => {
  assert.match(smokeSource, /path\.join\("\/tmp", `gak-smoke-/);
  assert.match(source, /--compression gzip/);
  assert.doesNotMatch(source, /--compression xz/);
});
