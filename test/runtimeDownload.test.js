import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRuntimeDownloads,
  verifySha256,
} from "../scripts/download-release-runtime.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "build", "runtime-versions.json"), "utf8"),
);

test("runtime downloader resolves immutable URLs for every release RID", () => {
  for (const rid of ["win-x64", "linux-x64", "osx-arm64", "osx-x64"]) {
    const downloads = resolveRuntimeDownloads(manifest, rid);
    assert.ok(downloads.node.url.endsWith(`/${downloads.node.archive}`));
    assert.ok(downloads.mihomo.url.endsWith(`/${downloads.mihomo.archive}`));
    assert.match(downloads.node.sha256, /^[0-9a-f]{64}$/);
    assert.match(downloads.mihomo.sha256, /^[0-9a-f]{64}$/);
  }
});

test("runtime downloader rejects bytes that do not match the pinned hash", () => {
  const bytes = Buffer.from("verified runtime");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() => verifySha256(bytes, hash, "fixture"));
  assert.throws(() => verifySha256(Buffer.from("tampered"), hash, "fixture"), /mismatch/i);
});
