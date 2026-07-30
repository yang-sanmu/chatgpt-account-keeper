import test from "node:test";
import assert from "node:assert/strict";
import { planAccountProxyMigration } from "../src/store.js";

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
