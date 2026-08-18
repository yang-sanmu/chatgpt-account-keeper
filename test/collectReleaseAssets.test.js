import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectReleaseAssets } from "../scripts/collect-release-assets.mjs";

test("release collector excludes downloaded history and keeps current channel assets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-release-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releases = path.join(root, "Releases");
  const compliance = path.join(root, "compliance");
  const output = path.join(root, "upload");
  fs.mkdirSync(releases);
  fs.mkdirSync(compliance);
  for (const [name, content] of Object.entries({
    "current.AppImage": "current",
    "current.AppImage.minisig": "signature",
    "current-full.nupkg": "package",
    "old-full.nupkg": "history",
    "releases.linux-x64.json": "index",
    "releases.linux-x64.json.minisig": "index signature",
    "RELEASES-linux-x64": "legacy index",
  })) {
    fs.writeFileSync(path.join(releases, name), content);
  }
  fs.writeFileSync(
    path.join(releases, "assets.linux-x64.json"),
    JSON.stringify([
      { RelativeFileName: "current.AppImage", Type: 3 },
      { RelativeFileName: "current-full.nupkg", Type: 1 },
    ]),
  );
  fs.writeFileSync(path.join(compliance, "SHA256SUMS.linux-x64.txt"), "checksums");

  const names = collectReleaseAssets({
    releaseDirectory: releases,
    complianceDirectory: compliance,
    outputDirectory: output,
    channel: "linux-x64",
  });

  assert.equal(names.includes("old-full.nupkg"), false);
  assert.deepEqual(fs.readdirSync(output).sort(), [
    "RELEASES-linux-x64",
    "SHA256SUMS.linux-x64.txt",
    "current-full.nupkg",
    "current.AppImage",
    "current.AppImage.minisig",
    "releases.linux-x64.json",
    "releases.linux-x64.json.minisig",
  ]);
});
