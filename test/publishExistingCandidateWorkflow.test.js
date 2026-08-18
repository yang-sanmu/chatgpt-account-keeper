import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "publish-existing-candidate.yml",
);
const source = fs.readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(source);

test("existing candidate promotion is manual and requires explicit unsafe overrides", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.allow_unsigned.default, false);
  assert.equal(inputs.skip_n_minus_one_verification.default, false);
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.permissions.contents, "write");
  assert.match(source, /conclusion.*success/);
  assert.match(source, /Cross-platform release candidate/);
});

test("promotion checks aggregate hashes and publishes only after a verified draft upload", () => {
  assert.match(source, /sha256sum --check SHA256SUMS\.release\.txt/);
  assert.match(source, /gh release create[\s\S]*--draft/);
  assert.match(source, /remote_count/);
  assert.match(source, /gh release edit[\s\S]*--draft=false --latest/);
});
