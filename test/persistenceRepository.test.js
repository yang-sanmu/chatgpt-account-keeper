import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { KeeperRepository, openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { MIGRATIONS, MIGRATION_LEDGER_SQL, SCHEMA_VERSION } from "../src/persistence/schema.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { OperationRegistry } from "../src/application/operations.js";
import { parseCustomProxies, appendCustomProxies } from "../src/customProxy.js";
import { mergeProxyNodes, assignStablePorts } from "../src/proxyUtils.js";

const require = createRequire(import.meta.url);
let Database = null;
try {
  const loaded = require("better-sqlite3");
  Database = loaded.default ?? loaded;
} catch {
  // The source module deliberately supports driver injection. Packaging adds
  // this RID/ABI-specific native dependency; pure migration tests still run.
}

test("existing v8–v14 databases upgrade without replacing historical migrations or user data", { skip: !Database }, async t => {
  assert.equal(MIGRATIONS.find(migration => migration.version === 9)?.checksum,
    "eb3b6db509cffa2c661acff13d1e6caa0507471ffc13f033cd7f0760ee283758");
  assert.equal(MIGRATIONS.find(migration => migration.version === 10)?.checksum,
    "f01f3380bbc6ca6d9090843cd8ee04c3ba7ff5e1d8d9fc45865fad6341c55b16");
  assert.equal(MIGRATIONS.find(migration => migration.version === 14)?.checksum,
    "11c0db614348e1490e8614bd5ecfc91473d5096934ae0d49183791d9878b1a0c");
  for (const version of [8, 9, 10, 11, 12, 13, 14]) {
    await t.test(`version ${version}`, async subtest => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-existing-schema-"));
      const filePath = path.join(root, "keeper.db");
      let repository;
      subtest.after(() => {
        repository?.close();
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true });
      });
      const database = new Database(filePath);
      database.exec(MIGRATION_LEDGER_SQL);
      const record = database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)");
      for (const migration of MIGRATIONS.filter(migration => migration.version <= version)) {
        database.exec(migration.sql);
        record.run(migration.version, migration.name, migration.checksum, "2026-10-17T00:00:00Z", "previous");
      }
      database.pragma(`user_version = ${version}`);
      new KeeperRepository(database).createAccount({ id: "existing-account", profileName: "existing-account", note: "keep me" });
      if (version >= 9) database.prepare("INSERT INTO tool_records VALUES (?, ?, ?, ?)").run("fixture", "existing", '{"keep":true}', "2026-10-17");
      if (version >= 10) database.prepare("INSERT INTO flow_pools VALUES (?, ?, ?, ?, ?)").run("existing-pool", "keep", "sealed-fixture", "2026-10-17", "2026-10-17");
      if (version === 13) {
        database.prepare("UPDATE proxy_settings SET subscription_url=?, subscription_updated_at=?, network_config_json=?")
          .run("https://example.test/sub?token=legacy", "2026-10-17T00:00:00Z", '{"mode":"relay","relayProxyId":"px_legacy"}');
        database.prepare("INSERT INTO proxy_nodes(id, sort_order, name, raw_json, enabled) VALUES (?, ?, ?, ?, ?)")
          .run("px_legacy", 12, "原节点", '{"name":"原节点","type":"http","server":"example.test","port":8888}', 0);
        database.prepare("INSERT INTO groups(id, sort_order, name, proxy_id) VALUES (?, ?, ?, ?)")
          .run("group-legacy", 0, "原分组", "px_legacy");
        database.prepare("INSERT INTO temporary_windows(id, proxy_id, config_json) VALUES (?, ?, ?)").run("temp-legacy", "px_legacy", "{}");
      }
      if (version === 14) database.prepare("INSERT INTO proxy_subscriptions(id, name) VALUES (?, ?)").run("existing-subscription", "keep");
      const ledger = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      database.close();

      repository = await openKeeperRepository({ filePath });
      assert.equal(repository.getSchemaVersion(), SCHEMA_VERSION);
      assert.deepEqual(repository.db.prepare("SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version").all(version), ledger);
      assert.equal(repository.getAccount("existing-account").note, "keep me");
      if (version >= 9) assert.equal(repository.db.prepare("SELECT payload FROM tool_records WHERE id='existing'").get().payload, '{"keep":true}');
      if (version >= 10) assert.equal(repository.db.prepare("SELECT sealed FROM flow_pools WHERE id='existing-pool'").get().sealed, "sealed-fixture");
      if (version === 14) assert.equal(repository.getProxyState({ includeSecrets: true }).subscriptions[0].linkRevision, 0);
      if (version === 13) {
        const state = repository.getProxyState({ includeSecrets: true });
        assert.equal(state.subscriptions[0].url, "https://example.test/sub?token=legacy");
        assert.equal(state.nodes[0].id, "px_legacy");
        assert.equal(state.nodes[0].sourceId, state.subscriptions[0].id);
        assert.equal(state.nodes[0].portSlot, 0);
        assert.equal(state.nodes[0].enabled, false);
        assert.equal(state.network.relayProxyId, "px_legacy");
        assert.equal(repository.db.prepare("SELECT proxy_id FROM groups WHERE id='group-legacy'").get().proxy_id, "px_legacy");
        assert.equal(repository.db.prepare("SELECT proxy_id FROM temporary_windows WHERE id='temp-legacy'").get().proxy_id, "px_legacy");
      } else assert.deepEqual(repository.db.prepare("SELECT * FROM temporary_windows").all(), []);
      assert.deepEqual(repository.db.prepare("SELECT * FROM icloud_state").all(), []);
      assert.deepEqual(repository.db.prepare("SELECT * FROM account_plans").all(), []);
      const backupPath = path.join(root, "backups", fs.readdirSync(path.join(root, "backups"))[0]);
      const backup = new Database(backupPath, { readonly: true });
      assert.equal(backup.pragma("user_version", { simple: true }), version);
      backup.close();
    });
  }
});

test("v14 with link_revision already present keeps its revision and ledger on upgrade", { skip: !Database }, t => {
  const database = new Database(":memory:");
  t.after(() => database.close());
  database.exec(MIGRATION_LEDGER_SQL);
  const record = database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)");
  for (const migration of MIGRATIONS.filter(migration => migration.version <= 14)) {
    const sql = migration.version === 14
      ? migration.sql.replace("  url TEXT UNIQUE,\n", "  url TEXT UNIQUE,\n  link_revision INTEGER NOT NULL DEFAULT 0,\n")
      : migration.sql;
    database.exec(sql);
    record.run(migration.version, migration.name, createHash("sha256").update(sql).digest("hex"), "2026-11-09T00:00:00Z", "previous");
  }
  database.pragma("user_version = 14");
  database.prepare("INSERT INTO proxy_subscriptions(id, name, link_revision) VALUES (?, ?, ?)").run("existing", "keep", 7);
  const original = database.prepare("SELECT * FROM schema_migrations WHERE version = 14").get();
  assert.equal(original.checksum, "4656227ad00ca9ab85dede6012b8eb2f7cc0840bb5bd59f44d353f2cfd05918c");
  const repository = new KeeperRepository(database);
  repository.applyMigrations();
  repository.applyMigrations();
  assert.equal(repository.getSchemaVersion(), SCHEMA_VERSION);
  assert.equal(repository.getProxyState({ includeSecrets: true }).subscriptions[0].linkRevision, 7);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version = 14").get(), original);
  database.prepare("UPDATE schema_migrations SET checksum = 'unknown' WHERE version = 14").run();
  assert.throws(() => repository.applyMigrations(), { code: "MIGRATION_CHECKSUM_MISMATCH" });
});

test("custom proxy order and credentials survive subscription refresh through SQLite", { skip: !Database }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-custom-proxy-"));
  const repository = await openKeeperRepository({ filePath: path.join(root, "keeper.db"), Database });
  try {
    const { proxy } = createSqliteRuntimeAdapters(repository);
    const custom = parseCustomProxies("localhost:1080@user:p@ss:word", "socks5");
    proxy.writeProxyStore({ nodes: custom });
    const initial = proxy.readProxyStore();
    const refreshed = mergeProxyNodes([
      { name: "first", type: "http", server: "localhost", port: 3000 },
      { name: "second", type: "http", server: "localhost", port: 3001 },
    ], initial.nodes, new Set());
    proxy.writeProxyStore({ ...initial, nodes: refreshed });
    const saved = proxy.readProxyStore();
    assert.deepEqual(saved.nodes.map((node) => node.id), refreshed.map((node) => node.id));
    assert.deepEqual(assignStablePorts(saved.nodes, { basePort: 21000 }), assignStablePorts(refreshed, { basePort: 21000 }));
    assert.equal(saved.nodes[2].raw.password, "p@ss:word");
    assert.equal(saved.nodes[2].raw.type, "socks5");
    const repeated = appendCustomProxies(saved.nodes, custom);
    proxy.writeProxyStore({ ...saved, nodes: repeated });
    assert.deepEqual(proxy.readProxyStore().nodes.map((node) => node.id), saved.nodes.map((node) => node.id));
  } finally {
    repository.close();
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "SQLite repository exposes synchronous Agent CRUD and durable receipts",
  { skip: !Database && "better-sqlite3 is not installed in this checkout" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-sqlite-"));
    const now = new Date("2026-08-13T00:00:00.000Z");
    const repository = await openKeeperRepository({
      filePath: path.join(root, "keeper.db"),
      backupDirectory: path.join(root, "backups"),
      Database,
      clock: () => now,
      appVersion: "test",
    });
    t.after(() => {
      repository.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    assert.equal(repository.getSettings().statusCheckEnabled, false);
    assert.equal(repository.getSettings().promoCheckEnabled, false);
    assert.equal(repository.getSettings().scheduledPromoCheckEnabled, true);
    repository.updateSettings({
      statusCheckEnabled: true,
      promoCheckEnabled: true,
      scheduledPromoCheckEnabled: false,
    });
    assert.equal(repository.getSettings().statusCheckEnabled, true);
    assert.equal(repository.getSettings().promoCheckEnabled, true);
    assert.equal(repository.getSettings().scheduledPromoCheckEnabled, false);
    assert.equal(repository.getSchemaVersion(), SCHEMA_VERSION);
    assert.equal(repository.integrityCheck().ok, true);
    repository.replaceProxyNodes([
      { id: "px1", name: "node", raw: { type: "http", server: "secret.example", port: 1 } },
    ]);
    repository.saveGroup({ id: "g1", name: "group", proxyId: "px1" });
    const adapters = createSqliteRuntimeAdapters(repository);
    const manualGroup = adapters.store.addGroup("manual-region", "px1", {
      timezone: "Asia/Kolkata",
      locale: "en-IN",
    });
    repository.createAccount({ id: "a1", profileName: "a1", groupId: "g1" });
    repository.saveConversationSet("default", { topic: "test", minRounds: 1, maxRounds: 2 });
    repository.updateSettings({ intervalMinutes: 60, schedulerEnabled: true });
    repository.upsertStatus("a1", {
      state: "ok",
      email: "a@example.test",
      stale: false,
      promoEligibility: "half_price",
      promoCheckedAt: "2026-08-13T00:00:00.000Z",
      promoStale: false,
      promoCheckDetail: null,
    });
    repository.updateSchedulerAccount("a1", { nextAt: "2026-08-14T00:00:00.000Z" });
    repository.appendHistory("a1", { ok: true, prompt: "p", reply: "r" });

    assert.equal(repository.getAccount("a1").profileDir, "profiles/a1");
    assert.equal(repository.getGroup("g1").proxyId, "px1");
    assert.equal(repository.getGroup(manualGroup.id).tzManual, true);
    assert.equal(repository.getConversationSetsObject().default.topic, "test");
    assert.equal(repository.getSettings().intervalMinutes, 60);
    assert.equal(repository.getStatus("a1").stale, false);
    assert.equal(repository.getStatus("a1").promoEligibility, "half_price");
    assert.equal(repository.getStatus("a1").promoCheckedAt, "2026-08-13T00:00:00.000Z");
    assert.equal(repository.queryHistory({ accountId: "a1" })[0].prompt, "p");
    assert.equal(repository.listHistoryAccounts()[0].lastOk, true);
    repository.appendHistory("a1", {
      finishedAt: "2026-08-12T00:00:00.000Z",
      ok: false,
      error: "failed",
    });
    assert.equal(repository.listHistoryAccounts()[0].lastOk, false);
    assert.equal(repository.listHistoryAccounts()[0].lastAt, "2026-08-12T00:00:00.000Z");
    assert.equal(repository.getSchedulerState().enabled, true);

    const safeProxy = repository.getProxyState();
    assert.equal(safeProxy.subscription.url, undefined);
    assert.equal(safeProxy.nodes[0].raw, undefined);
    assert.equal(repository.getProxyState({ includeSecrets: true }).nodes[0].raw.server, "secret.example");

    const first = repository.recordCommandReceipt("cmd-1", "accounts.create", { ok: true });
    const replay = repository.getCommandReceipt("cmd-1", "accounts.create");
    assert.deepEqual(replay.response, first.response);
    assert.throws(
      () => repository.getCommandReceipt("cmd-1", "groups.create"),
      (error) => error.code === "COMMAND_ID_REUSED"
    );
  }
);

test(
  "清理与重启后保留最新对话结果和各类批量检查结果",
  { skip: !Database && "better-sqlite3 is not installed in this checkout" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-latest-runs-"));
    const options = {
      filePath: path.join(root, "keeper.db"),
      backupDirectory: path.join(root, "backups"),
      Database,
      appVersion: "test",
    };
    let repository = await openKeeperRepository(options);
    t.after(() => {
      repository.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const save = (id, resourceId, kind, state, startedAt, finishedAt = startedAt, result = null) => {
      repository.saveOperation({
        id, resourceId, kind, state, startedAt, updatedAt: finishedAt, finishedAt, result,
        error: state === "failed" ? { code: "TIMEOUT", message: "启动端口超时", retryable: true } : null,
      });
    };
    save("old-success", "acc_1", "account-run", "succeeded", "2026-08-31T09:00:00.000Z");
    save("latest-failure", "acc_1", "account-run", "failed", "2026-08-31T10:00:00.000Z");
    save("later-cancel", "acc_1", "account-run", "cancelled", "2026-08-31T11:00:00.000Z");
    save("late-finish", "acc_2", "account-run", "succeeded", "2026-08-31T09:00:00.000Z", "2026-08-31T11:00:00.000Z");
    save("early-finish", "acc_2", "account-run", "failed", "2026-08-31T10:00:00.000Z");
    const first = "2026-08-31T09:00:00.000Z";
    const next = "2026-08-31T10:00:00.000Z";
    const batchResult = { total: 1, succeeded: 0, failures: [{ id: "acc_1", detail: "连接超时" }] };
    save("old-plan", null, "account-plan-check", "succeeded", first, first, batchResult);
    save("latest-plan", null, "account-plan-check", "succeeded", next, next, batchResult);
    save("old-promo", null, "account-promo-check", "succeeded", next, next, {
      total: 1, succeeded: 0, failures: [{ id: "acc_2", detail: "旧批次失败" }],
    });
    save("latest-promo", null, "account-promo-check", "succeeded", next, next, batchResult);
    save("single-plan", "acc_1", "account-plan-check-single", "succeeded", next, next, batchResult);
    save("latest-inspection", null, "account-inspection", "succeeded", first, first, batchResult);
    const restoredWithBothBatches = new OperationRegistry({ store: createSqliteRuntimeAdapters(repository).operations });
    restoredWithBothBatches.restore();
    const latestPromo = restoredWithBothBatches.listLatestAccountChecks()
      .find(({ kind }) => kind === "account-promo-check");
    assert.equal(latestPromo?.id, "latest-promo");
    assert.deepEqual(latestPromo.result.failures, batchResult.failures);

    repository.saveOperation({
      id: "interrupted-inspection", kind: "account-inspection", state: "running",
      startedAt: next, updatedAt: next,
    });
    for (let index = 0; index < 550; index++) {
      const at = new Date(Date.parse("2026-08-31T12:00:00.000Z") + index * 1000).toISOString();
      save(`check-${index}`, "acc_1", "account-status-refresh", "succeeded", at);
    }

    repository.pruneOperations();
    assert.ok(repository.db.prepare("SELECT id FROM operations WHERE id = ?").get("latest-failure"),
      "全局500条保留上限不能删除某账号唯一的最新实际结果");
    assert.equal(repository.db.prepare("SELECT id FROM operations WHERE id = ?").get("old-success"), undefined);
    assert.equal(repository.db.prepare("SELECT count(*) AS count FROM operations").get().count, 506);

    repository.close();
    repository = await openKeeperRepository(options);
    const registry = new OperationRegistry({ store: createSqliteRuntimeAdapters(repository).operations });
    registry.restore();
    const latest = registry.listLatestAccountRuns();
    assert.deepEqual(latest.map((operation) => operation.id).sort(), ["late-finish", "latest-failure"]);
    assert.equal(latest.find((operation) => operation.resourceId === "acc_1").error.message, "启动端口超时");
    const latestChecks = registry.listLatestAccountChecks();
    assert.deepEqual(latestChecks.map(({ id }) => id).sort(), ["interrupted-inspection", "latest-inspection", "latest-plan", "latest-promo"]);
    assert.equal(latestChecks.find(({ id }) => id === "interrupted-inspection").state, "cancelled");
    assert.deepEqual(latestChecks.find(({ id }) => id === "latest-inspection").result, batchResult);
    assert.deepEqual(latestChecks.find(({ id }) => id === "latest-plan").result, batchResult);
    assert.deepEqual(latestChecks.find(({ id }) => id === "latest-promo").result, batchResult);
    assert.deepEqual(registry.get("latest-promo")?.result, batchResult);
    assert.equal(registry.get("interrupted-inspection")?.state, "cancelled");
    assert.equal(repository.integrityCheck().ok, true);
  }
);
