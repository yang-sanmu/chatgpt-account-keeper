import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { MIGRATIONS, MIGRATION_LEDGER_SQL } from "../src/persistence/schema.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { ApplicationServices } from "../src/application/services.js";
import { assertMethodResultContract } from "../src/agent/contractValidator.js";
import { environmentSnapshot, environmentPending, validateFixedEnvironment } from "../src/environmentConfig.js";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-environments-"));
  const repository = await openKeeperRepository({ filePath: path.join(root, "keeper.db") });
  t.after(() => { repository.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  repository.createAccount({ id: "a", profileName: "existing-profile" });
  return { root, repository };
}

test("fixed environment persists, reset and group changes preserve the Profile; optimistic versions reject races", async t => {
  const { repository } = await fixture(t);
  const oldProfile = repository.getAccount("a").profileDir;
  assert.equal(repository.getAccountEnvironment("a").mode, "inherit");
  const fixed = repository.updateAccountEnvironment("a", { mode: "fixed", locale: "en-us", timezone: "America/New_York" }, 0);
  assert.equal(fixed.locale, "en-US"); assert.equal(fixed.version, 1);
  repository.saveGroup({ id: "g", name: "Group" });
  repository.updateAccount("a", { groupId: "g" });
  assert.deepEqual(repository.getAccountEnvironment("a"), fixed);
  repository.removeGroup("g"); assert.deepEqual(repository.getAccountEnvironment("a"), fixed);
  assert.throws(() => repository.updateAccountEnvironment("a", { mode: "inherit" }, 0), { statusCode: 409 });
  assert.equal(repository.getAccountEnvironment("a").version, 1);
  const reset = repository.updateAccountEnvironment("a", { mode: "inherit" }, 1);
  assert.equal(reset.mode, "inherit"); assert.equal(reset.locale, null); assert.equal(reset.version, 2);
  assert.equal(repository.getAccount("a").profileDir, oldProfile);
  repository.removeAccount("a"); assert.equal(repository.getAccountEnvironment("a"), null);
});

test("environment snapshots are immutable; fixed and inherited group movement have different pending semantics", () => {
  const system = { locale: "zh-CN", timeZone: "Asia/Shanghai" };
  const account = { id: "a", groupId: "g" };
  const config = { mode: "fixed", version: 1, locale: "de-DE", timezone: "Europe/Berlin" };
  const fixed = environmentSnapshot({ account, environment: config, system });
  config.locale = "fr-FR";
  assert.equal(fixed.locale, "de-DE"); assert.ok(Object.isFrozen(fixed));
  const moved = environmentSnapshot({ account: { ...account, groupId: "b" }, environment: { ...config, locale: "de-DE" }, system });
  assert.equal(environmentPending(fixed, moved), false);
  const inherit = environmentSnapshot({ account, environment: { mode: "inherit", version: 0 }, system });
  assert.equal(inherit.locale, "zh-CN"); assert.equal(inherit.localeSource, "application_default");
  assert.equal(inherit.timezoneId, null); assert.equal(inherit.timezoneSource, "browser_default");
  const foreignSystem = environmentSnapshot({ account, environment: { mode: "inherit", version: 0 },
    system: { locale: "en-US", timeZone: "America/New_York" } });
  assert.deepEqual(foreignSystem, inherit, "Node's ICU defaults must not replace the legacy Chrome launch defaults");
  const detected = environmentSnapshot({ account, environment: { mode: "inherit", version: 0 }, system,
    group: { tzManual: false }, region: { timezoneId: "Europe/Berlin", locale: "de-DE" } });
  assert.equal(environmentPending(inherit, detected), true);
  for (const values of [{ locale: "bogus_underscore", timezone: "UTC" }, { locale: "en", timezone: "+08:00" }, { locale: "en", timezone: "Nowhere/Invalid" }]) {
    assert.throws(() => validateFixedEnvironment(values), { statusCode: 400 });
  }
});

test("IPC environment edits preserve old account DTOs, reject stale writes and report pending snapshots", async t => {
  const { repository } = await fixture(t);
  const { store } = createSqliteRuntimeAdapters(repository);
  const running = [environmentSnapshot({ account: store.getAccount("a"), environment: store.getAccountEnvironment("a") })];
  const services = new ApplicationServices({ runtime: { store, getBrowserEnvironmentSnapshots: () => running } });
  t.after(() => services.dispose());
  const call = (method, params) => services.execute({ method, params, commandId: randomUUID() });
  const before = await call("environments.get", { accountId: "a" });
  assertMethodResultContract("environments.get", before); assert.equal(before.pending, false);
  assert.equal(before.probePending, false);
  repository.replaceProxyNodes([{ id: "node", name: "Test node", raw: { type: "http", server: "127.0.0.1", port: 23001 } }]);
  repository.saveGroup({ id: "unprobed", name: "Unprobed", proxyId: "node" });
  repository.updateAccount("a", { groupId: "unprobed" });
  const preview = await call("environments.get", { accountId: "a" });
  assert.equal(preview.probePending, true);
  assert.equal(preview.next.timezoneId, null);
  const params = { accountId: "a", locale: "en-US", timezone: "America/New_York", expectedVersion: 0 };
  const request = { method: "environments.update", params, commandId: randomUUID() };
  const updated = await services.execute(request); assert.equal(updated.pending, true);
  assert.equal(updated.probePending, false);
  assertMethodResultContract("environments.update", updated);
  assert.deepEqual(await services.execute(request), updated); assert.equal(store.getAccountEnvironment("a").version, 1);
  await assert.rejects(call("environments.update", params), { code: "RESOURCE_BUSY" });
  assert.equal(Object.hasOwn(store.getAccount("a"), "environment"), false);
  const caps = await call("network.getCapabilities", {}); assertMethodResultContract("network.getCapabilities", caps); assert.equal(caps.available, false);
  await assert.rejects(call("environments.get", { accountId: "missing" }), { code: "NOT_FOUND" });
});

test("v6 upgrade creates a consistent v6 backup before the new environment table; old accounts inherit", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-env-migration-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const filePath = path.join(root, "keeper.db"); const db = new Database(filePath);
  db.exec(MIGRATION_LEDGER_SQL);
  for (const migration of MIGRATIONS.filter(m => m.version <= 6)) {
    db.exec(migration.sql); db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)")
      .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    db.pragma(`user_version=${migration.version}`);
  }
  db.prepare("INSERT INTO accounts(id,sort_order,profile_name) VALUES ('old',0,'untouched')").run(); db.close();
  const profile = path.join(root, "profiles", "untouched"); fs.mkdirSync(profile, { recursive: true });
  const profileFile = path.join(profile, "synthetic-session"); fs.writeFileSync(profileFile, "keep-session");
  let backupPath;
  const repository = await openKeeperRepository({ filePath });
  try {
    assert.equal(repository.getAccountEnvironment("old").mode, "inherit");
    assert.equal(repository.getAccount("old").profileName, "untouched");
    const backups = fs.readdirSync(path.join(root, "backups")); assert.equal(backups.length, 1);
    backupPath = path.join(root, "backups", backups[0]);
    const backup = new Database(backupPath, { readonly: true });
    try { assert.equal(backup.pragma("user_version", { simple: true }), 6); assert.equal(backup.prepare("SELECT profile_name FROM accounts WHERE id='old'").get().profile_name, "untouched"); }
    finally { backup.close(); }
    repository.updateAccountEnvironment("old", { mode: "fixed", locale: "de-DE", timezone: "Europe/Berlin" }, 0);
    repository.createAccount({ id: "new-after-upgrade", profileName: "new-profile" });
  } finally { repository.close(); }
  // Stop the writer and preserve post-upgrade data before replacing the database.
  // Never merge a v6 backup with v7 WAL/SHM sidecars.
  const upgraded = path.join(root, "upgraded-v7.db"); fs.copyFileSync(filePath, upgraded);
  assert.equal(fs.existsSync(filePath + "-wal"), false); assert.equal(fs.existsSync(filePath + "-shm"), false);
  fs.copyFileSync(backupPath, filePath);
  const restored = new Database(filePath, { readonly: true });
  const preserved = new Database(upgraded, { readonly: true });
  try {
    assert.equal(restored.pragma("user_version", { simple: true }), 6);
    assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
    assert.equal(restored.prepare("SELECT name FROM sqlite_master WHERE name='account_environments'").get(), undefined);
    assert.equal(preserved.pragma("user_version", { simple: true }), 7);
    assert.equal(preserved.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 2);
    assert.equal(preserved.prepare("SELECT locale FROM account_environments WHERE account_id='old'").get().locale, "de-DE");
    assert.equal(fs.readFileSync(profileFile, "utf8"), "keep-session");
  } finally { restored.close(); preserved.close(); }
});
