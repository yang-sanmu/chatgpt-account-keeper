import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLegacyMigrationPlan } from "../src/migration/legacyPlan.js";
import { runLegacyMigration } from "../src/migration/legacyMigration.js";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";

function createSource(root) {
  const write = (relative, value) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  };
  write("config/accounts.json", {
    accounts: [{ id: "a1", profileDir: "profiles/a1", enabled: true, note: "migrated" }],
  });
  write("config/conversations.json", { sets: { default: { topic: "topic", minRounds: 1, maxRounds: 2 } } });
  write("config/settings.json", { intervalMinutes: 45 });
  write("config/groups.json", { groups: [] });
  write("profiles/a1/Default/Cookies", "session-cookie");
  write("profiles/a1/DevToolsActivePort", "stale-runtime-file");
  write("logs/a1.jsonl", `${JSON.stringify({ time: "2026-01-01T00:00:00.000Z", ok: true })}\n`);
  write(
    "logs/deleted.jsonl",
    `${JSON.stringify({ time: "2025-01-01T00:00:00.000Z", ok: false, reason: "old" })}\n`
  );
}

test("full legacy migration promotes a verified DB/profile set and replays idempotently", async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-migration-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-migration-target-"));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  createSource(source);
  const plan = buildLegacyMigrationPlan(source);
  const progress = [];
  const options = {
    plan,
    targetDataRoot: target,
    appVersion: "test",
    onProgress: (entry) => progress.push(entry),
    profileCopyOptions: {
      getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
      minimumReserveBytes: 0,
      reserveRatio: 0,
    },
  };
  const result = await runLegacyMigration(options);
  assert.equal(result.alreadyMigrated, false);
  assert.equal(progress.some((entry) => entry.stage === "build-database"), true);
  assert.equal(progress.some((entry) => entry.stage === "copy-profile"), true);
  assert.equal(progress.at(-1).stage, "completed");
  assert.equal(fs.existsSync(path.join(target, "keeper.db")), true);
  assert.equal(
    fs.readFileSync(path.join(target, "profiles/a1/Default/Cookies"), "utf8"),
    "session-cookie"
  );
  assert.equal(fs.existsSync(path.join(target, "profiles/a1/DevToolsActivePort")), false);
  assert.equal(fs.existsSync(path.join(source, "profiles/a1/DevToolsActivePort")), true);

  const repository = await openKeeperRepository({
    filePath: path.join(target, "keeper.db"),
    backupDirectory: path.join(target, "backups"),
  });
  assert.equal(repository.listAccounts().length, 1);
  assert.equal(repository.getSettings().schedulerEnabled, false);
  assert.equal(repository.queryHistory({ accountId: "deleted" }).length, 1);
  assert.deepEqual(
    repository.listHistoryAccounts().map((item) => [item.accountId, item.deleted]),
    [["a1", false], ["deleted", true]]
  );
  assert.equal(repository.getCompletedMigration(plan.sourceFingerprint).id, result.migrationId);
  repository.close();

  const replay = await runLegacyMigration(options);
  assert.equal(replay.alreadyMigrated, true);
  assert.equal(replay.profiles.reusedProfiles, 1);
});

test("retry reuses promoted profiles after a progress sink failure before database promotion", async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-migration-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-migration-target-"));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  createSource(source);
  const plan = buildLegacyMigrationPlan(source);
  const baseOptions = {
    plan,
    targetDataRoot: target,
    appVersion: "test",
    profileCopyOptions: {
      getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
      minimumReserveBytes: 0,
      reserveRatio: 0,
    },
  };

  await assert.rejects(
    runLegacyMigration({
      ...baseOptions,
      onProgress(entry) {
        if (entry.stage === "final-verification") throw new Error("simulated progress sharing failure");
      },
    }),
    /simulated progress sharing failure/
  );
  assert.equal(fs.existsSync(path.join(target, "profiles/a1/Default/Cookies")), true);
  assert.equal(fs.existsSync(path.join(target, "keeper.db")), false);

  const progress = [];
  const retry = await runLegacyMigration({
    ...baseOptions,
    onProgress: (entry) => progress.push(entry),
  });
  assert.equal(retry.profiles.copiedProfiles, 0);
  assert.equal(retry.profiles.reusedProfiles, 1);
  assert.equal(fs.existsSync(path.join(target, "keeper.db")), true);
  assert.equal(progress.some((entry) => entry.stage === "copy-profile"), false);
});

test("迁移把用户自定义的 selectors 落到数据目录，而不是采集后丢弃", async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-selectors-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-selectors-target-"));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  createSource(source);
  // 旧项目里用户改过选择器（例如站点改版后自己修的输入框选择器）。
  const custom = { url: "https://chatgpt.com/?migrated=1", composer: "#custom-composer" };
  fs.writeFileSync(
    path.join(source, "config", "selectors.json"),
    JSON.stringify(custom),
    "utf8"
  );

  const plan = buildLegacyMigrationPlan(source);
  assert.deepEqual(plan.selectorsOverride, custom, "计划必须采集到覆盖");

  await runLegacyMigration({
    plan,
    targetDataRoot: target,
    appVersion: "test",
    profileCopyOptions: {
      getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
      minimumReserveBytes: 0,
      reserveRatio: 0,
    },
  });

  // 覆盖要真正可读：否则用户改过的选择器在新版本里静默失效。
  const promoted = path.join(target, "config", "selectors.json");
  assert.equal(fs.existsSync(promoted), true, "覆盖必须写入数据目录");
  assert.deepEqual(JSON.parse(fs.readFileSync(promoted, "utf8")), custom);
  // 旧项目保持原样。
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(source, "config", "selectors.json"), "utf8")),
    custom
  );
});

test("没有自定义 selectors 时不在数据目录留下空覆盖", async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-noselectors-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-noselectors-target-"));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  createSource(source);
  const plan = buildLegacyMigrationPlan(source);
  assert.equal(plan.selectorsOverride, null);

  await runLegacyMigration({
    plan,
    targetDataRoot: target,
    appVersion: "test",
    profileCopyOptions: {
      getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
      minimumReserveBytes: 0,
      reserveRatio: 0,
    },
  });

  // 留一个覆盖会把该文件永久钉死在旧版本，之后的更新再也改不动它。
  assert.equal(fs.existsSync(path.join(target, "config", "selectors.json")), false);
});
