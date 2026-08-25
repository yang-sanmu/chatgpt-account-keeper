import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLATFORM_OPTIONS, writeLatestJson } from "../scripts/write-latest-json.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-latest-json-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = {
    windows: "ChatGPT.Account.Keeper_0.2.1_x64-setup.exe",
    "darwin-arm64": "ChatGPT.Account.Keeper_aarch64.app.tar.gz",
    "darwin-x64": "ChatGPT.Account.Keeper_x64.app.tar.gz",
    "linux-appimage": "ChatGPT.Account.Keeper_0.2.1_amd64.AppImage",
  };
  const artifacts = {};
  for (const [key, name] of Object.entries(names)) {
    const artifact = path.join(root, name);
    fs.writeFileSync(artifact, key);
    fs.writeFileSync(`${artifact}.sig`, `signature-${key}\n`);
    artifacts[key] = artifact;
  }
  return { root, artifacts };
}

test("latest.json embeds signature contents and only the four supported updater targets", (t) => {
  const { root, artifacts } = fixture(t);
  const outputFile = path.join(root, "latest.json");
  const manifest = writeLatestJson({
    version: "0.2.1",
    notes: "Fix update flow\n",
    pubDate: "2026-08-25T08:00:00+08:00",
    baseUrl: "https://github.com/yang-sanmu/chatgpt-account-keeper/releases/download/v0.2.1",
    artifacts,
    outputFile,
  });

  assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.values(PLATFORM_OPTIONS).sort());
  assert.equal(Object.hasOwn(manifest.platforms, "linux-x86_64"), false);
  assert.equal(manifest.platforms["linux-x86_64-appimage"].signature, "signature-linux-appimage");
  assert.match(manifest.platforms["windows-x86_64"].url, /x64-setup\.exe$/);
  assert.equal(manifest.pub_date, "2026-08-25T00:00:00.000Z");
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, "utf8")), manifest);
});

test("latest.json generation fails closed when a signature is missing", (t) => {
  const { root, artifacts } = fixture(t);
  fs.rmSync(`${artifacts["darwin-x64"]}.sig`);
  assert.throws(
    () => writeLatestJson({
      version: "0.2.1",
      notes: "notes",
      baseUrl: "https://example.invalid/v0.2.1",
      artifacts,
      outputFile: path.join(root, "latest.json"),
    }),
    /missing updater signature.*darwin-x86_64/i,
  );
});
