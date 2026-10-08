import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const refuse = reason => ({ eligible: false, reason, migrationVerified: false });

/** Read-only M1 preflight, not a migration or a decryption test. The caller must
 * retain its Profile admission lock throughout inspection AND runtime switch.
 * assertStopped supplies the broker Job count; it does not replace that lock. */
export async function inspectProfileForRuntimeCopy({ profileDirectory, assertStopped }) {
  if (typeof assertStopped !== "function") return refuse("CLOSURE_PROOF_REQUIRED");
  const root = path.resolve(profileDirectory);
  let temp;
  const observed = new Map();
  function inspect(file) {
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error("outside-profile");
    for (let part = file; ; part = path.dirname(part)) {
      let stat;
      try { stat = fs.lstatSync(part); }
      catch (error) { if (error.code === "ENOENT") { observed.set(part, null); return null; } throw error; }
      if (stat.isSymbolicLink()) throw new Error("linked-profile");
      const fingerprint = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(":");
      if (observed.has(part) && observed.get(part) !== fingerprint) throw new Error("changed-profile");
      observed.set(part, fingerprint);
      if (part === root) break;
    }
    return fs.statSync(file);
  }
  try {
    if ((await assertStopped())?.count !== 0) return refuse("PROFILE_NOT_CLOSED");
    if (!inspect(root)?.isDirectory()) return refuse("PROFILE_UNREADABLE");
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > 1000 || entries.some(entry => entry.isSymbolicLink())) return refuse("PROFILE_UNREADABLE");
    const statePath = path.join(root, "Local State");
    const stateStat = inspect(statePath);
    if (!stateStat) {
      if (entries.length) return refuse("LOCAL_STATE_MISSING");
      if ((await assertStopped())?.count !== 0) return refuse("PROFILE_NOT_CLOSED");
      if (fs.readdirSync(root).length) return refuse("PROFILE_CHANGED_DURING_CHECK");
      return { eligible: true, reason: "EMPTY_PROFILE", migrationVerified: false, cookieDatabases: 0, cipherFormats: [] };
    }
    if (!stateStat.isFile() || stateStat.size > 16 * 1024 * 1024) return refuse("LOCAL_STATE_INVALID");
    let state;
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return refuse("LOCAL_STATE_INVALID"); }
    if (!state?.os_crypt || typeof state.os_crypt !== "object") return refuse("LOCAL_STATE_INVALID");
    if (Object.hasOwn(state.os_crypt, "app_bound_encrypted_key")) return refuse("APP_BOUND_ENCRYPTION");
    const key = state.os_crypt.encrypted_key;
    if (typeof key !== "string" || key.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) return refuse("DPAPI_KEY_UNRECOGNIZED");
    const keyBytes = Buffer.from(key, "base64");
    if (keyBytes.toString("base64") !== key || keyBytes.length <= 5 || keyBytes.subarray(0, 5).toString() !== "DPAPI") return refuse("DPAPI_KEY_UNRECOGNIZED");
    const directories = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
    for (const name of Object.keys(state.profile?.info_cache ?? {})) {
      if (name === "." || name === ".." || /[\\/:]/u.test(name) || !directories.has(name)) return refuse("PROFILE_DIRECTORY_MISSING");
    }
    const formats = new Set(); let cookieDatabases = 0;
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-migration-guard-"));
    for (const name of directories) {
      const directory = path.join(root, name);
      inspect(directory);
      // Chrome versions have used both locations; never accept a v10 Default
      // database while ignoring a second Profile or a legacy Cookies database.
      const network = path.join(directory, "Network");
      const networkStat = inspect(network);
      if (networkStat && !networkStat.isDirectory()) return refuse("PROFILE_UNREADABLE");
      for (const relative of ["Cookies", path.join("Network", "Cookies")]) {
        const source = path.join(directory, relative);
        const sourceStat = inspect(source);
        const wal = source + "-wal";
        const walStat = inspect(wal);
        const journalStat = inspect(source + "-journal");
        // A hot rollback journal needs recovery before a consistent read. Never
        // silently ignore it or recover the user's original database here.
        if (journalStat && (!journalStat.isFile() || journalStat.size > 0)) return refuse("COOKIE_RECOVERY_REQUIRED");
        if (!sourceStat) {
          if (walStat) return refuse("COOKIE_DATABASE_INVALID");
          continue;
        }
        if (!sourceStat.isFile() || (walStat && !walStat.isFile())) return refuse("COOKIE_DATABASE_INVALID");
        const copy = path.join(temp, `cookies-${cookieDatabases++}.db`);
        fs.copyFileSync(source, copy);
        if (walStat) fs.copyFileSync(wal, copy + "-wal");
        // SQLite may create SHM when reading WAL. It only opens our temporary
        // snapshot, never the user's database or keys for writing/decryption.
        const db = new Database(copy, { readonly: true, fileMustExist: true });
        try {
          if (db.pragma("quick_check", { simple: true }) !== "ok") return refuse("COOKIE_DATABASE_INVALID");
          const rows = db.prepare("SELECT DISTINCT hex(substr(encrypted_value,1,3)) AS prefix, length(encrypted_value) AS size, typeof(encrypted_value) AS type FROM cookies").all();
          for (const row of rows) {
            if (row.type !== "blob") return refuse("COOKIE_FORMAT_UNRECOGNIZED");
            if (row.size === 0) { formats.add("unencrypted"); continue; }
            if (row.prefix === "763230") return refuse("APP_BOUND_COOKIE");
            // v10 requires the prefix, 12-byte nonce and 16-byte GCM tag. This
            // checks shape only; successful decryption is a separate gate.
            if (row.prefix !== "763130" || row.size < 31) return refuse("COOKIE_FORMAT_UNRECOGNIZED");
            formats.add("v10");
          }
        } finally { db.close(); }
      }
    }
    if ((await assertStopped())?.count !== 0) return refuse("PROFILE_NOT_CLOSED");
    for (const [file, previous] of observed) {
      let current = null;
      try { const stat = fs.lstatSync(file); current = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(":"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current !== previous) return refuse("PROFILE_CHANGED_DURING_CHECK");
    }
    return { eligible: true, reason: "SUPPORTED_FORMATS_ONLY", migrationVerified: false, cookieDatabases, cipherFormats: [...formats].sort() };
  } catch { return refuse("PROFILE_UNREADABLE"); }
  finally {
    if (temp && path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith("keeper-migration-guard-")) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}
