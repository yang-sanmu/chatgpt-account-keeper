import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { SCHEMA_VERSION } from "../src/persistence/schema.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { OperationRegistry } from "../src/application/operations.js";

const require = createRequire(import.meta.url);
let Database = null;
try {
  const loaded = require("better-sqlite3");
  Database = loaded.default ?? loaded;
} catch {
  // The source module deliberately supports driver injection. Packaging adds
  // this RID/ABI-specific native dependency; pure migration tests still run.
}

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

    assert.equal(repository.getSchemaVersion(), SCHEMA_VERSION);
    assert.equal(repository.integrityCheck().ok, true);
    repository.replaceProxyNodes([
      { id: "px1", name: "node", raw: { type: "http", server: "secret.example", port: 1 } },
    ]);
    repository.saveGroup({ id: "g1", name: "group", proxyId: "px1" });
    repository.createAccount({ id: "a1", profileName: "a1", groupId: "g1" });
    repository.saveConversationSet("default", { topic: "test", minRounds: 1, maxRounds: 2 });
    repository.updateSettings({ intervalMinutes: 60, schedulerEnabled: true });
    repository.upsertStatus("a1", { state: "ok", email: "a@example.test", stale: false });
    repository.updateSchedulerAccount("a1", { nextAt: "2026-08-14T00:00:00.000Z" });
    repository.appendHistory("a1", { ok: true, prompt: "p", reply: "r" });

    assert.equal(repository.getAccount("a1").profileDir, "profiles/a1");
    assert.equal(repository.getGroup("g1").proxyId, "px1");
    assert.equal(repository.getConversationSetsObject().default.topic, "test");
    assert.equal(repository.getSettings().intervalMinutes, 60);
    assert.equal(repository.getStatus("a1").stale, false);
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
  "清理与重启后仍保留每个账号按完成时间选出的最新非取消对话结果",
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
    const save = (id, resourceId, kind, state, startedAt, finishedAt = startedAt) => {
      repository.saveOperation({
        id, resourceId, kind, state, startedAt, updatedAt: finishedAt, finishedAt,
        error: state === "failed" ? { code: "TIMEOUT", message: "启动端口超时", retryable: true } : null,
      });
    };
    save("old-success", "acc_1", "account-run", "succeeded", "2026-08-31T09:00:00.000Z");
    save("latest-failure", "acc_1", "account-run", "failed", "2026-08-31T10:00:00.000Z");
    save("later-cancel", "acc_1", "account-run", "cancelled", "2026-08-31T11:00:00.000Z");
    save("late-finish", "acc_2", "account-run", "succeeded", "2026-08-31T09:00:00.000Z", "2026-08-31T11:00:00.000Z");
    save("early-finish", "acc_2", "account-run", "failed", "2026-08-31T10:00:00.000Z");
    for (let index = 0; index < 550; index++) {
      const at = new Date(Date.parse("2026-08-31T12:00:00.000Z") + index * 1000).toISOString();
      save(`check-${index}`, "acc_1", "account-status-refresh", "succeeded", at);
    }

    repository.pruneOperations();
    assert.ok(repository.db.prepare("SELECT id FROM operations WHERE id = ?").get("latest-failure"),
      "全局500条保留上限不能删除某账号唯一的最新实际结果");
    assert.equal(repository.db.prepare("SELECT id FROM operations WHERE id = ?").get("old-success"), undefined);
    assert.equal(repository.db.prepare("SELECT count(*) AS count FROM operations").get().count, 502);

    repository.close();
    repository = await openKeeperRepository(options);
    const registry = new OperationRegistry({ store: createSqliteRuntimeAdapters(repository).operations });
    registry.restore();
    const latest = registry.listLatestAccountRuns();
    assert.deepEqual(latest.map((operation) => operation.id).sort(), ["late-finish", "latest-failure"]);
    assert.equal(latest.find((operation) => operation.resourceId === "acc_1").error.message, "启动端口超时");
    assert.equal(repository.integrityCheck().ok, true);
  }
);
