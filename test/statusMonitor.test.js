import test from "node:test";
import assert from "node:assert/strict";
import { markHeld, releaseHeld } from "../src/locks.js";
import {
  refreshAccount,
  setCachedStatus,
} from "../src/statusMonitor.js";

test("refreshAccount returns cached state immediately for a manually held account", async () => {
  const accountId = "test_held_account";
  setCachedStatus(accountId, "ok", "held@example.com");
  markHeld(accountId);

  try {
    const startedAt = Date.now();
    const result = await refreshAccount({ id: accountId });

    assert.equal(result.skipped, true);
    assert.equal(result.state, "ok");
    assert.equal(result.email, "held@example.com");
    assert.ok(Date.now() - startedAt < 100);
  } finally {
    releaseHeld(accountId);
  }
});

test("refreshAccount skips a stale queued account after it has been deleted", async () => {
  const result = await refreshAccount({ id: `missing_${Date.now()}` });

  assert.equal(result.skipped, true);
  assert.equal(result.deleted, true);
  assert.equal(result.state, null);
  assert.equal(result.loggedIn, false);
});
