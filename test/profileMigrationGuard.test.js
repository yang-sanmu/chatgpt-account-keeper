import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { inspectProfileForRuntimeCopy } from "../src/network/profileMigrationGuard.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-guard-test-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const state = { os_crypt: { encrypted_key: Buffer.from("DPAPIsynthetic-test-key").toString("base64") } };
  const save = () => fs.writeFileSync(path.join(root, "Local State"), JSON.stringify(state)); save();
  const cookies = (name, prefix = "v10", location = "Network") => {
    const directory = path.join(root, name, location); fs.mkdirSync(directory, { recursive: true });
    const db = new Database(path.join(directory, "Cookies"));
    db.exec("CREATE TABLE cookies(encrypted_value BLOB, host_key TEXT)");
    db.prepare("INSERT INTO cookies VALUES (?,?)").run(Buffer.from(prefix + "synthetic-secret".repeat(3)), "private.example"); db.close();
  };
  const inspect = options => inspectProfileForRuntimeCopy({ profileDirectory: root, assertStopped: async () => ({ count: 0 }), ...options });
  return { root, state, save, cookies, inspect };
}

test("guard reads supported formats without changing Profile files or claiming a successful migration", async t => {
  const f = fixture(t); f.cookies("Default"); f.cookies("Profile 1", "v10", "");
  const file = path.join(f.root, "Default/Network/Cookies"); const before = fs.readFileSync(file);
  const result = await f.inspect();
  assert.deepEqual(result, { eligible: true, reason: "SUPPORTED_FORMATS_ONLY", migrationVerified: false, cookieDatabases: 2, cipherFormats: ["v10"] });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(JSON.stringify(result).includes("private.example"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
});

test("absence of the app-bound key never hides v20 in another Profile or legacy database", async t => {
  const f = fixture(t); f.cookies("Default"); f.cookies("Profile 2", "v20", "");
  assert.equal((await f.inspect()).reason, "APP_BOUND_COOKIE");
});

test("guard detects v20 in WAL without opening the original SQLite files", async t => {
  const f = fixture(t); f.cookies("Default");
  const file = path.join(f.root, "Default/Network/Cookies");
  const writer = new Database(file);
  try {
    writer.pragma("journal_mode = WAL"); writer.pragma("wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO cookies VALUES (?,?)").run(Buffer.from("v20" + "synthetic-secret".repeat(3)), "wal.example");
    const originals = [file, file + "-wal", file + "-shm"].map(file => [file, fs.readFileSync(file)]);
    assert.equal((await f.inspect()).reason, "APP_BOUND_COOKIE");
    for (const [file, before] of originals) assert.deepEqual(fs.readFileSync(file), before);
  } finally { writer.close(); }
});

test("guard refuses orphan WAL, pending rollback, malformed blobs and linked Network directories", async t => {
  const f = fixture(t); f.cookies("Default");
  const file = path.join(f.root, "Default/Network/Cookies");
  const db = new Database(file);
  db.prepare("UPDATE cookies SET encrypted_value=?").run(Buffer.from("v10")); db.close();
  assert.equal((await f.inspect()).reason, "COOKIE_FORMAT_UNRECOGNIZED");
  fs.writeFileSync(file + "-journal", "pending recovery");
  assert.equal((await f.inspect()).reason, "COOKIE_RECOVERY_REQUIRED");
  fs.rmSync(file + "-journal"); fs.rmSync(file);
  fs.writeFileSync(file + "-wal", "orphaned");
  assert.equal((await f.inspect()).reason, "COOKIE_DATABASE_INVALID");
  fs.rmSync(file + "-wal");
  const network = path.dirname(file); fs.rmdirSync(network);
  // A junction on Windows needs no symlink privilege. Point within the fixture;
  // the guard must reject it even though there is no Cookies file at its target.
  fs.symlinkSync(path.join(f.root, "Default"), network, process.platform === "win32" ? "junction" : "dir");
  try { assert.equal((await f.inspect()).eligible, false); }
  finally { fs.unlinkSync(network); }
});

test("guard refuses app-bound keys, invalid state and unknown cookie encryption", async t => {
  const f = fixture(t); f.cookies("Default", "v99");
  assert.equal((await f.inspect()).reason, "COOKIE_FORMAT_UNRECOGNIZED");
  f.state.os_crypt.app_bound_encrypted_key = ""; f.save();
  assert.equal((await f.inspect()).reason, "APP_BOUND_ENCRYPTION");
  delete f.state.os_crypt.app_bound_encrypted_key; f.state.os_crypt.encrypted_key = "unexpected"; f.save();
  assert.equal((await f.inspect()).reason, "DPAPI_KEY_UNRECOGNIZED");
  fs.writeFileSync(path.join(f.root, "Local State"), "{");
  assert.equal((await f.inspect()).reason, "LOCAL_STATE_INVALID");
});

test("guard refuses missing state, corrupt cookies, open Jobs and changes during inspection", async t => {
  const f = fixture(t); f.cookies("Default");
  assert.equal((await f.inspect({ assertStopped: undefined })).reason, "CLOSURE_PROOF_REQUIRED");
  assert.equal((await f.inspect({ assertStopped: async () => ({ count: 1 }) })).reason, "PROFILE_NOT_CLOSED");
  let checks = 0;
  assert.equal((await f.inspect({ assertStopped: async () => {
    if (++checks === 2) fs.appendFileSync(path.join(f.root, "Local State"), " "); return { count: 0 };
  } })).reason, "PROFILE_CHANGED_DURING_CHECK");
  fs.writeFileSync(path.join(f.root, "Default/Network/Cookies"), "corrupt");
  assert.equal((await f.inspect()).eligible, false);
  fs.rmSync(path.join(f.root, "Local State"));
  assert.equal((await f.inspect()).reason, "LOCAL_STATE_MISSING");
});
