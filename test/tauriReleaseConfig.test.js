import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(root, "app", "src-tauri");
const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, "tauri.conf.json"), "utf8"));
const releaseConfig = JSON.parse(
  fs.readFileSync(path.join(tauriRoot, "tauri.release.conf.json"), "utf8"),
);
const appPackage = JSON.parse(fs.readFileSync(path.join(root, "app", "package.json"), "utf8"));

test("Tauri bundles every supported installer and creates v2 updater artifacts", () => {
  assert.deepEqual(config.bundle.targets, ["nsis", "app", "dmg", "appimage", "deb", "rpm"]);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.ok(config.bundle.linux.deb.depends.includes("libwebkit2gtk-4.1-0"));
  assert.ok(config.bundle.linux.rpm.depends.includes("webkit2gtk4.1"));
});

test("release-only config maps staged Agent resources without breaking ordinary cargo tests", () => {
  assert.equal(releaseConfig.bundle.resources["release-resources/agent/"], "agent");
  assert.equal(
    releaseConfig.bundle.resources["release-resources/licenses/agent.cdx.json"],
    "licenses/agent.cdx.json",
  );
  assert.match(appPackage.scripts["tauri:build:release"], /tauri\.release\.conf\.json/);
});

test("updater configuration uses the stable HTTPS endpoint and an inline public-key field", () => {
  assert.equal(
    config.plugins.updater.endpoints[0],
    "https://github.com/yang-sanmu/chatgpt-account-keeper/releases/latest/download/latest.json",
  );
  assert.equal(typeof config.plugins.updater.pubkey, "string");
  assert.doesNotMatch(config.plugins.updater.pubkey, /PLACEHOLDER/i);
  const decoded = Buffer.from(config.plugins.updater.pubkey, "base64").toString("utf8");
  assert.match(decoded, /^untrusted comment: minisign public key: [0-9A-F]{16}\n/);
  assert.match(decoded, /\nRW[A-Za-z0-9+/=]+\n$/);
});
