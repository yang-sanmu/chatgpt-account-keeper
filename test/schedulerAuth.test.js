import test from "node:test";
import assert from "node:assert/strict";
import { runOnce } from "../src/scheduler.js";
import { configureStoreBackend } from "../src/store.js";
import { configureStatusBackend } from "../src/statusCacheStore.js";
import { getCachedStatus, deleteCachedStatus } from "../src/statusMonitor.js";

test("a login prompt during a conversation updates account status even with polling disabled", async () => {
  const account = { id: "mid-conversation-auth", rotation: { currentSet: "topic", windowsDone: 0, windowsTarget: 2 } };
  const restoreStore = configureStoreBackend({
    getAccount: () => account,
    getSettings: () => ({ statusCheckEnabled: false }),
    getConversations: () => ({ topic: { topic: "test", minRounds: 1, maxRounds: 1 } }),
    updateAccount: () => assert.fail("failed conversation must not advance rotation"),
  });
  const restoreStatus = configureStatusBackend({ writePersistedStatuses() {} });
  try {
    const result = await runOnce(account, { page: {
      goto: async () => {},
      evaluate: async () => ({ email: "test@example.com", meStatus: 200, meValidUser: true }),
      waitForSelector: async () => ({}),
      waitForTimeout: async () => {},
      $: async () => null,
      $$: async () => [{ isVisible: async () => true }],
    } });
    assert.equal(result.ok, false);
    assert.equal(result.needReauth, true);
    assert.equal(getCachedStatus(account.id).state, "reauth");
    assert.equal(getCachedStatus(account.id).email, "test@example.com");
  } finally {
    deleteCachedStatus(account.id);
    restoreStatus();
    restoreStore();
  }
});
