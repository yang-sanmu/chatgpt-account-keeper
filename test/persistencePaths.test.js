import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseBootstrapPointer,
  readBootstrapPointer,
  resolvePlatformPaths,
  validateDataRoot,
  writeBootstrapPointer,
} from "../src/persistence/platformPaths.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/persistence/schema.js";

test("platform paths match the per-user Windows layout", () => {
  const paths = resolvePlatformPaths({
    platform: "win32",
    homeDir: "C:\\Users\\Keeper",
    env: {
      LOCALAPPDATA: "C:\\Users\\Keeper\\AppData\\Local",
      APPDATA: "C:\\Users\\Keeper\\AppData\\Roaming",
    },
  });
  assert.equal(paths.dataRoot, "C:\\Users\\Keeper\\AppData\\Local\\GptAccountKeeper\\data");
  assert.equal(
    paths.bootstrapFile,
    "C:\\Users\\Keeper\\AppData\\Roaming\\GptAccountKeeper\\bootstrap.json"
  );
  // path.win32, not the host path: on Linux the host join would produce forward
  // slashes and this assertion would only hold on a Windows runner.
  assert.equal(paths.databaseFile, path.win32.join(paths.dataRoot, "keeper.db"));
});

// posix fixtures and path.posix throughout: feeding a Windows temp path into the
// linux resolver only worked because the host happened to be Windows.
test("Linux paths honor XDG roots and never create directories", () => {
  const marker = path.posix.join("/tmp", `keeper-paths-${process.pid}-${Date.now()}`);
  const paths = resolvePlatformPaths({
    platform: "linux",
    homeDir: path.posix.join(marker, "home"),
    env: {
      XDG_DATA_HOME: path.posix.join(marker, "data"),
      XDG_CONFIG_HOME: path.posix.join(marker, "config"),
      XDG_CACHE_HOME: path.posix.join(marker, "cache"),
      XDG_RUNTIME_DIR: path.posix.join(marker, "run"),
    },
  });
  assert.equal(paths.dataRoot, path.posix.join(marker, "data", "gpt-account-keeper"));
  assert.equal(fs.existsSync(marker), false);
});

test("data-root validation rejects roots, relative paths, UNC, and source overlap", () => {
  const driveRoot = path.parse(process.cwd()).root;
  assert.throws(() => validateDataRoot("relative/data"), /绝对路径/);
  assert.throws(() => validateDataRoot(driveRoot), /根目录/);
  assert.throws(
    () => validateDataRoot("\\\\server\\share\\keeper", { platform: "win32" }),
    /网络共享/
  );
  assert.throws(
    () => validateDataRoot(path.join(process.cwd(), "data"), { legacyRoot: process.cwd() }),
    /旧源码目录/
  );
  assert.throws(
    () => validateDataRoot(path.join(os.tmpdir(), "keeper-data"), { volumeInfo: { isNetwork: true } }),
    /本地固定磁盘/
  );
});

test("bootstrap pointer is strict, validated, and atomically round-trips", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "config", "bootstrap.json");
  const dataRoot = path.join(root, "data");
  const written = writeBootstrapPointer(file, dataRoot);
  assert.deepEqual(readBootstrapPointer(file), written);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["bootstrap.json"]);
  assert.throws(() => parseBootstrapPointer('{"version":2,"dataRoot":"x"}'), /版本/);
  assert.throws(() => parseBootstrapPointer("{"), /有效 JSON/);
});

test("schema declares every durable subsystem and migration checksum", () => {
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    MIGRATIONS.map((_, index) => index + 1),
    "迁移版本号必须从 1 开始且连续"
  );
  for (const migration of MIGRATIONS) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  }
  // Operation 持久化是 v2 引入的：任务历史与错误详情要能跨 Agent 重启查询。
  assert.match(MIGRATIONS[1].sql, /CREATE TABLE IF NOT EXISTS operations\b/);
  assert.match(MIGRATIONS[2].sql, /_legacy_conversation_id_map/);
  for (const table of [
    "command_receipts",
    "app_settings",
    "proxy_settings",
    "proxy_nodes",
    "groups",
    "conversation_sets",
    "accounts",
    "account_status",
    "scheduler_state",
    "run_history",
    "profile_maintenance_state",
    "profile_fs_operations",
    "migration_imports",
    "migration_rejects",
  ]) {
    assert.match(MIGRATIONS[0].sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});
