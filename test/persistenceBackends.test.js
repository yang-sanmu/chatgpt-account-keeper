import test from "node:test";
import assert from "node:assert/strict";
import {
  configureStatusBackend,
  readPersistedStatuses,
  writePersistedStatuses,
} from "../src/statusCacheStore.js";
import { configureProxyStoreBackend, getNodes } from "../src/proxyManager.js";

test("status cache can be persisted by the Agent database backend", () => {
  let saved = null;
  const restore = configureStatusBackend({
    readPersistedStatuses: () => ({ a: { state: "ok" } }),
    writePersistedStatuses: (statuses) => {
      saved = statuses;
    },
  });
  try {
    assert.equal(readPersistedStatuses().a.state, "ok");
    writePersistedStatuses({ b: { state: "out" } });
    assert.equal(saved.b.state, "out");
  } finally {
    restore();
  }
});

test("proxy manager can read private proxy data from the Agent database", () => {
  const restore = configureProxyStoreBackend({
    readProxyStore: () => ({
      subscription: { url: "https://secret.invalid/token", updatedAt: null },
      nodes: [
        {
          id: "node-1",
          name: "US",
          raw: { type: "http", server: "example.invalid", port: 443, password: "secret" },
          enabled: true,
          missing: false,
        },
      ],
      mihomoPath: null,
      clashVergeDir: null,
    }),
  });
  try {
    const [node] = getNodes();
    assert.equal(node.id, "node-1");
    assert.equal("raw" in node, false);
    assert.equal("password" in node, false);
  } finally {
    restore();
  }
});
