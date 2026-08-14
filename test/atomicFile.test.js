import test from "node:test";
import assert from "node:assert/strict";
import { renamePathSync, replaceFileSync } from "../src/atomicFile.js";

test("atomic replacement retries transient Windows sharing failures", () => {
  let calls = 0;
  const fsImpl = {
    renameSync() {
      calls++;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
    },
  };
  replaceFileSync("source", "destination", { fsImpl, attempts: 3, retryDelayMs: 0 });
  assert.equal(calls, 3);
});

test("atomic replacement does not retry structural errors", () => {
  let calls = 0;
  const fsImpl = {
    renameSync() {
      calls++;
      throw Object.assign(new Error("destination is a directory"), { code: "EISDIR" });
    },
  };
  assert.throws(() => replaceFileSync("source", "destination", { fsImpl }), /directory/);
  assert.equal(calls, 1);
});

test("path rename uses the same bounded sharing-failure retry", () => {
  let calls = 0;
  const fsImpl = {
    renameSync() {
      calls++;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
  };

  renamePathSync("source-directory", "destination-directory", {
    fsImpl,
    attempts: 2,
    retryDelayMs: 0,
  });
  assert.equal(calls, 2);
});
