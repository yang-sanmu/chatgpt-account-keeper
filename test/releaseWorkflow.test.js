import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "windows-release.yml"),
  "utf8",
);
const release = YAML.parse(releaseSource);
const ci = YAML.parse(fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"));
const publishScript = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "publish-windows-release.ps1"),
  "utf8",
);
const localBuildScript = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "build-local-release.ps1"),
  "utf8",
);

test("release workflow builds the four Tauri targets and aggregates once", () => {
  assert.equal(release.name, "Cross-platform Tauri release candidate");
  assert.deepEqual(Object.keys(release.jobs), ["gate", "build", "aggregate"]);
  const matrix = release.jobs.build.strategy.matrix.include;
  assert.deepEqual(matrix.map((entry) => entry.rid).sort(), [
    "linux-x64",
    "osx-arm64",
    "osx-x64",
    "win-x64",
  ]);
  assert.equal(matrix.find((entry) => entry.rid === "linux-x64").runner, "ubuntu-22.04");
  assert.deepEqual(release.jobs.aggregate.needs, ["gate", "build"]);
  assert.equal(release.on.workflow_dispatch.inputs.release_notes.required, true);
});

test("CI has one Tauri cargo gate and keeps the four-platform Node matrix", () => {
  assert.deepEqual(Object.keys(ci.jobs), ["tauri-client", "agent-tests"]);
  const tauriCommands = ci.jobs["tauri-client"].steps.map((step) => step.run ?? "").join("\n");
  assert.match(tauriCommands, /cargo fmt/);
  assert.match(tauriCommands, /cargo clippy/);
  assert.match(tauriCommands, /cargo test/);
  assert.deepEqual(
    ci.jobs["agent-tests"].strategy.matrix.include.map((entry) => entry.rid).sort(),
    ["linux-x64", "osx-arm64", "osx-x64", "win-x64"],
  );
  assert.equal(JSON.stringify(ci).includes("NativeAOT"), false);
});

test("Windows publishes the Chrome broker before staging and smoking the Agent", () => {
  const steps = release.jobs.build.steps;
  const broker = steps.findIndex((step) => step.name === "Publish chrome-launcher broker");
  const stage = steps.findIndex(
    (step) => step.name === "Stage Tauri resources, generate Agent SBOM and smoke the private Agent",
  );
  assert.ok(broker >= 0 && broker < stage);
  assert.match(steps[stage].run, /--chrome-launcher artifacts\/chrome-launcher\/chrome-launcher\.exe/);
  assert.match(steps[stage].run, /smoke-staged-agent\.mjs/);
  assert.match(steps[stage].run, /npm sbom/);
});

test("release pipeline uses Tauri updater signatures and contains no VeloPack build path", () => {
  assert.match(releaseSource, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(releaseSource, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required/);
  assert.match(releaseSource, /tauri:build:release/);
  assert.match(releaseSource, /collect-tauri-artifacts\.mjs/);
  assert.match(releaseSource, /write-latest-json\.mjs/);
  assert.doesNotMatch(releaseSource, /vpk pack|NativeAOT|dotnet publish desktop/i);
  assert.equal((releaseSource.match(/gh release create/g) ?? []).length, 1);
});

test("Draft creation requires N-1 verification and every platform signing marker", () => {
  assert.match(releaseSource, /n_minus_one_verified/);
  assert.match(releaseSource, /UNSIGNED-\*\.txt/);
  for (const rid of ["win-x64", "osx-arm64", "osx-x64", "linux-x64"]) {
    assert.match(releaseSource, new RegExp("SIGNED-.*" + rid + "|SIGNED-\\$rid"));
  }
  assert.match(releaseSource, /xcrun stapler validate/);
  assert.match(releaseSource, /Get-AuthenticodeSignature/);
  assert.match(releaseSource, /"\$minisign_bin" -V/);
});

test("Linux only installs the pinned Minisign tool when signing is configured", () => {
  const steps = release.jobs.build.steps;
  const prerequisites = steps.find((step) => step.name === "Install Linux Tauri bundler prerequisites");
  const signing = steps.find((step) => step.name === "Detect and apply Linux Minisign");
  assert.doesNotMatch(prerequisites.run, /\bminisign\b/i);
  assert.ok(signing.run.indexOf("minisign_version=0.12") > signing.run.indexOf('if [[ "$configured" -eq 0 ]]'));
  assert.match(signing.run, /9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73/);
  assert.match(signing.run, /sha256sum --check/);
});

test("unsigned Apple candidates do not expose empty certificate variables to the bundler", () => {
  const apple = release.jobs.build.steps.find(
    (step) => step.name === "Configure Apple signing and notarization",
  );
  assert.equal(release.jobs.build.env.APPLE_CERTIFICATE, undefined);
  assert.equal(apple.env.MACOS_APP_CERTIFICATE_BASE64, "${{ secrets.MACOS_APP_CERTIFICATE_BASE64 }}");
  assert.match(apple.run, /APPLE_CERTIFICATE=\$MACOS_APP_CERTIFICATE_BASE64/);
  assert.match(apple.run, /APPLE_SIGNING_IDENTITY=-/);
});

test("aggregate filenames delimit the Bash version variable before suffixes", () => {
  const aggregateCommands = release.jobs.aggregate.steps.map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(aggregateCommands, /\$VERSION_/);
  assert.match(aggregateCommands, /ChatGPT-Account-Keeper_\$\{VERSION\}_windows_x86_64-setup\.exe/);
});

test("local dispatcher downloads the Tauri aggregate and requires updater attestation to publish", () => {
  assert.match(publishScript, /ChatGPT-Account-Keeper-all-\$Version/);
  assert.match(publishScript, /PublishDraft requires -UpdaterVerified/);
  assert.match(publishScript, /-Mode PublishDraft -UpdaterVerified/);
  assert.match(localBuildScript, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required/);
  assert.match(publishScript, /UploadDraft is no longer supported/);
  assert.doesNotMatch(publishScript, /AllowExistingTag/);
  assert.match(publishScript, /latest\.json/);
  assert.doesNotMatch(publishScript, /full\.nupkg|releases\.win\.json|GptAccountKeeper\.Desktop-all/);
});
