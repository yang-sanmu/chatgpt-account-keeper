import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyReleaseVersion } from "../scripts/verify-release-version.mjs";

test("release version gate checks the independent Tauri version line", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-release-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "app");
  const tauriRoot = path.join(appRoot, "src-tauri");
  fs.mkdirSync(tauriRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ version: "2.3.4" }));
  fs.writeFileSync(
    path.join(appRoot, "package-lock.json"),
    JSON.stringify({ version: "2.3.4", packages: { "": { version: "2.3.4" } } }),
  );
  fs.writeFileSync(path.join(tauriRoot, "tauri.conf.json"), JSON.stringify({ version: "2.3.4" }));
  fs.writeFileSync(path.join(tauriRoot, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "2.3.4"\n');

  assert.doesNotThrow(() => verifyReleaseVersion("2.3.4", root));
  assert.throws(() => verifyReleaseVersion("2.3.5", root), /does not match committed metadata/i);
});

test("release version gate never mistakes another Cargo section for package.version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-release-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "app");
  const tauriRoot = path.join(appRoot, "src-tauri");
  fs.mkdirSync(tauriRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ version: "2.3.4" }));
  fs.writeFileSync(
    path.join(appRoot, "package-lock.json"),
    JSON.stringify({ version: "2.3.4", packages: { "": { version: "2.3.4" } } }),
  );
  fs.writeFileSync(path.join(tauriRoot, "tauri.conf.json"), JSON.stringify({ version: "2.3.4" }));
  fs.writeFileSync(
    path.join(tauriRoot, "Cargo.toml"),
    '[package]\nname = "fixture"\n\n[dependencies.fixture]\nversion = "2.3.4"\n',
  );

  assert.throws(
    () => verifyReleaseVersion("2.3.4", root),
    /app\/src-tauri\/Cargo\.toml: <missing>/i,
  );
});
