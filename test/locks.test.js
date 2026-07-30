import test from "node:test";
import assert from "node:assert/strict";
import { isBusy, withAccountLock } from "../src/locks.js";

test("account lock reports pending work and releases its queue state after completion", async () => {
  const accountId = "lock_cleanup_test";
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const running = withAccountLock(accountId, () => gate);
  assert.equal(isBusy(accountId), true);

  release();
  await running;
  await Promise.resolve();
  assert.equal(isBusy(accountId), false);
});
