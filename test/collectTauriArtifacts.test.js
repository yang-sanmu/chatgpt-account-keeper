import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectTauriArtifacts } from "../scripts/collect-tauri-artifacts.mjs";

function rootFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-tauri-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundles = path.join(root, "target", "release", "bundle");
  const sbom = path.join(root, "agent.cdx.json");
  fs.writeFileSync(sbom, "{}");
  return { root, bundles, sbom };
}

function touch(root, relative, content = relative) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test("collector maps Linux bundles and the updater signature to stable asset names", (t) => {
  const { root, bundles, sbom } = rootFixture(t);
  const appimage = touch(bundles, "appimage/original.AppImage");
  fs.writeFileSync(`${appimage}.sig`, "tauri-signature");
  touch(bundles, "deb/original.deb");
  touch(bundles, "rpm/original.rpm");
  const output = path.join(root, "output");

  collectTauriArtifacts({ bundleRoot: path.join(root, "target"), version: "0.2.1", rid: "linux-x64", outputDirectory: output, sbom });

  assert.deepEqual(fs.readdirSync(output).sort(), [
    "ChatGPT-Account-Keeper_0.2.1_linux-x64-agent.cdx.json",
    "ChatGPT-Account-Keeper_0.2.1_linux_x86_64.AppImage",
    "ChatGPT-Account-Keeper_0.2.1_linux_x86_64.AppImage.sig",
    "ChatGPT-Account-Keeper_0.2.1_linux_x86_64.deb",
    "ChatGPT-Account-Keeper_0.2.1_linux_x86_64.rpm",
  ]);
});

test("collector ignores same-extension files nested below a bundle output directory", (t) => {
  const { root, bundles, sbom } = rootFixture(t);
  const installer = touch(bundles, "nsis/keeper-setup.exe");
  fs.writeFileSync(`${installer}.sig`, "tauri-signature");
  touch(bundles, "nsis/internal/helper.exe");

  assert.doesNotThrow(() => collectTauriArtifacts({
    bundleRoot: path.join(root, "target"),
    version: "0.2.1",
    rid: "win-x64",
    outputDirectory: path.join(root, "output"),
    sbom,
  }));
});

test("collector rejects ambiguous Tauri bundle output", (t) => {
  const { root, bundles, sbom } = rootFixture(t);
  const first = touch(bundles, "nsis/one-setup.exe");
  fs.writeFileSync(`${first}.sig`, "one");
  const second = touch(bundles, "nsis/two-setup.exe");
  fs.writeFileSync(`${second}.sig`, "two");
  assert.throws(
    () => collectTauriArtifacts({
      bundleRoot: path.join(root, "target"),
      version: "0.2.1",
      rid: "win-x64",
      outputDirectory: path.join(root, "output"),
      sbom,
    }),
    /exactly one nsis.*found 2/i,
  );
});
