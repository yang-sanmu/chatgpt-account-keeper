import test from "node:test";
import assert from "node:assert/strict";
import {
  configureStoreBackend,
  getAccount,
  getAccounts,
  getSettings,
  planAccountProxyMigration,
  saveSettings,
  updateAccount,
} from "../src/store.js";

function groupForAccount(result, accountId) {
  const account = result.accounts.find((a) => a.id === accountId);
  return result.groups.find((g) => g.id === account?.groupId) ?? null;
}

test("proxy migration preserves bound, system, ungrouped, and missing-group exits", () => {
  const result = planAccountProxyMigration(
    [
      { id: "system", groupId: "g1", proxyId: null, enabled: true },
      { id: "us", groupId: "g1", proxyId: "px_us", enabled: true },
      { id: "kr", groupId: "g1", proxyId: "px_kr", enabled: true },
      { id: "ungrouped", groupId: null, proxyId: "px_us", enabled: true },
      { id: "missing", groupId: "deleted_group", proxyId: "px_kr", enabled: true },
      {
        id: "manual",
        groupId: "g1",
        proxy: "http://127.0.0.1:8080",
        enabled: true,
      },
    ],
    [{ id: "g1", name: "共享分组" }]
  );

  assert.equal(result.groups.find((g) => g.id === "g1").proxyId, null);
  assert.equal(groupForAccount(result, "system")?.proxyId, null);
  assert.equal(groupForAccount(result, "us")?.proxyId, "px_us");
  assert.equal(groupForAccount(result, "kr")?.proxyId, "px_kr");
  assert.equal(groupForAccount(result, "ungrouped")?.proxyId, "px_us");
  assert.equal(groupForAccount(result, "missing")?.proxyId, "px_kr");

  const manual = result.accounts.find((a) => a.id === "manual");
  assert.equal(manual.enabled, false);
  assert.equal(result.stats.disabledManualProxyAccounts, 1);
  assert.equal(result.stats.createdGroups, 4);

  for (const account of result.accounts) {
    assert.equal("proxyId" in account, false);
    assert.equal("proxy" in account, false);
  }
});

test("proxy migration keeps the majority exit on the original group and splits conflicts", () => {
  const result = planAccountProxyMigration(
    [
      { id: "a1", groupId: "g1", proxyId: "px_us" },
      { id: "a2", groupId: "g1", proxyId: "px_us" },
      { id: "a3", groupId: "g1", proxyId: "px_kr" },
    ],
    [{ id: "g1", name: "注册组" }]
  );

  assert.equal(result.groups.find((g) => g.id === "g1").proxyId, "px_us");
  assert.equal(result.accounts.find((a) => a.id === "a1").groupId, "g1");
  assert.equal(result.accounts.find((a) => a.id === "a2").groupId, "g1");
  assert.equal(groupForAccount(result, "a3")?.proxyId, "px_kr");
  assert.equal(result.stats.boundExistingGroups, 1);
  assert.equal(result.stats.createdGroups, 1);
  assert.equal(result.stats.reassignedAccounts, 1);
});

test("proxy migration reuses deterministic groups after an interrupted write", () => {
  const accounts = [
    { id: "a1", groupId: "g1", proxyId: "px_us" },
    { id: "a2", groupId: "g1", proxyId: "px_kr" },
  ];
  const first = planAccountProxyMigration(accounts, [{ id: "g1", name: "注册组" }]);

  // 模拟 groups.json 已写入、accounts.json 尚未写入时进程退出。
  const retried = planAccountProxyMigration(accounts, first.groups);

  assert.equal(retried.stats.createdGroups, 0);
  assert.equal(groupForAccount(retried, "a1")?.proxyId, "px_us");
  assert.equal(groupForAccount(retried, "a2")?.proxyId, "px_kr");
  assert.deepEqual(
    retried.groups.map((g) => g.id).sort(),
    first.groups.map((g) => g.id).sort()
  );
});

test("configured store backend is visible to existing direct store imports", () => {
  const account = { id: "sqlite-account", note: "from sqlite" };
  const calls = [];
  const restore = configureStoreBackend({
    getAccounts() {
      calls.push("getAccounts");
      return [account];
    },
    getAccount(id) {
      calls.push(["getAccount", id]);
      return id === account.id ? account : null;
    },
    updateAccount(id, patch) {
      calls.push(["updateAccount", id, patch]);
      return { ...account, ...patch };
    },
    getSettings() {
      return { intervalMinutes: 42 };
    },
    saveSettings(patch) {
      return { intervalMinutes: 42, ...patch };
    },
  });

  try {
    assert.deepEqual(getAccounts(), [account]);
    assert.equal(getAccount(account.id), account);
    assert.equal(updateAccount(account.id, { note: "updated" }).note, "updated");
    assert.equal(getSettings().intervalMinutes, 42);
    assert.equal(saveSettings({ headless: false }).headless, false);
    assert.deepEqual(calls.slice(0, 3), [
      "getAccounts",
      ["getAccount", account.id],
      ["updateAccount", account.id, { note: "updated" }],
    ]);
  } finally {
    restore();
  }
});

test("写操作之后不允许再切换 store 后端", () => {
  // 切换点之前的写落到 JSON、之后的写落到 SQLite，两边都成了“部分正确”。
  // 这是编程错误，必须在配置阶段就暴露，而不是留下分叉的数据。
  const first = { updateAccount: () => ({ id: "a" }) };
  const second = { updateAccount: () => ({ id: "b" }) };
  const restore = configureStoreBackend(first);
  try {
    updateAccount("a", { note: "写一次" });
    assert.throws(() => configureStoreBackend(second), /cannot change after a write/);
  } finally {
    restore();
  }
});

test("只读之后仍可切换 store 后端", () => {
  const backend = { getAccounts: () => [] };
  const restore = configureStoreBackend(backend);
  try {
    getAccounts();
    const inner = configureStoreBackend({ getAccounts: () => [{ id: "x" }] });
    assert.deepEqual(getAccounts(), [{ id: "x" }]);
    inner();
  } finally {
    restore();
  }
});
