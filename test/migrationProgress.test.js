import test from "node:test";
import assert from "node:assert/strict";
import {
  createMigrationProgressReporter,
  writeMigrationProgress,
} from "../src/agent/migrationProgress.js";

function busyError() {
  return Object.assign(new Error("destination is busy"), { code: "EBUSY" });
}

test("migration progress appends a complete JSONL record", () => {
  const writes = [];
  const fsImpl = {
    appendFileSync(file, body) { writes.push({ file, body }); },
  };

  const result = writeMigrationProgress("C:\\state\\migration-progress.json", {
    state: "running",
    message: "copying",
  }, { fsImpl, attempts: 1, retryDelayMs: 0 });

  assert.deepEqual(result, { written: true, mode: "jsonl-append" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.endsWith("\n"), true);
  assert.equal(JSON.parse(writes[0].body).message, "copying");
});

test("migration progress retries transient Windows sharing failures", () => {
  let attempts = 0;
  const fsImpl = {
    appendFileSync() {
      attempts++;
      if (attempts < 3) throw busyError();
    },
  };
  const result = writeMigrationProgress("C:\\state\\migration-progress.json", {
    state: "running",
  }, { fsImpl, attempts: 3, retryDelayMs: 0 });
  assert.equal(result.written, true);
  assert.equal(attempts, 3);
});

test("progress reporting is throttled but milestones and terminal state are immediate", () => {
  const records = [];
  let now = 1_000;
  const report = createMigrationProgressReporter("progress.json", {
    minimumIntervalMs: 250,
    clock: () => now,
    fsImpl: { appendFileSync(_file, body) { records.push(JSON.parse(body)); } },
  });
  report({ state: "running", stage: "copy", profileName: "one", progress: 0 });
  now += 10;
  report({ state: "running", stage: "copy", profileName: "one", progress: 0.1 });
  report({ state: "running", stage: "verify", profileName: "one", progress: 1 });
  report({ state: "succeeded", stage: "completed", progress: 1 });
  assert.deepEqual(records.map((item) => item.stage), ["copy", "verify", "completed"]);
});

test("a failed progress sink warns but never terminates migration work", () => {
  const warnings = [];
  const fsImpl = {
    appendFileSync() { throw busyError(); },
  };
  const report = createMigrationProgressReporter("C:\\state\\migration-progress.json", {
    fsImpl,
    attempts: 1,
    retryDelayMs: 0,
    logger: { warn(message) { warnings.push(message); } },
  });

  assert.equal(report({ state: "failed", message: "diagnostic only" }), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /迁移继续/);
});
