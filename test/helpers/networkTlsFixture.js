import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

export async function createLabCertificates(directory) {
  await fs.mkdir(directory);
  await promisify(execFile)("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./networkLabCertificates.ps1", import.meta.url)), "-OutputDirectory", directory],
  { windowsHide: true, timeout: 30_000 });
  return {
    rootDer: await fs.readFile(path.join(directory, "root.der")),
    trusted: { cert: await fs.readFile(path.join(directory, "server.pem")), key: await fs.readFile(path.join(directory, "server.key")) },
    untrusted: { cert: await fs.readFile(path.join(directory, "untrusted.pem")), key: await fs.readFile(path.join(directory, "untrusted.key")) },
  };
}

// Test-only fixture for Chrome's per-Profile certificate database, schema v1:
// https://chromium.googlesource.com/chromium/src/+/main/components/server_certificate_database/
// The Profile is created here, before Chrome ever runs. Never edit an existing
// Profile or import into the Windows certificate store. No cert-error bypass.
export async function createTrustedLabProfile(root, name, rootDer) {
  if (!/^[a-z-]+$/u.test(name)) throw new Error("Invalid fixture Profile name");
  const profile = path.join(root, name);
  await fs.mkdir(profile); // Deliberately fails if the path already exists.
  await fs.mkdir(path.join(profile, "Default"));
  const db = new Database(path.join(profile, "Default", "ServerCertificate"));
  try {
    db.transaction(() => {
      db.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR); CREATE TABLE certificates(sha256hash_hex TEXT PRIMARY KEY,der_cert BLOB NOT NULL,trust_settings BLOB NOT NULL)");
      const meta = db.prepare("INSERT INTO meta VALUES (?,?)");
      meta.run("version", "1"); meta.run("last_compatible_version", "1");
      // CertificateMetadata.trust (field 1), CertificateTrust.trust_type (field 1), TRUSTED=3.
      db.prepare("INSERT INTO certificates VALUES (?,?,?)").run(createHash("sha256").update(rootDer).digest("hex"), rootDer, Buffer.from([0x0a, 0x02, 0x08, 0x03]));
    })();
  } finally { db.close(); }
  return profile;
}
