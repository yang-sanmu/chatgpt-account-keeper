import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts", "verify-package.mjs");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-package-"));
  for (const directory of [
    "agent/runtime",
    "agent/src/agent",
    "agent/bin",
    "agent/contracts",
    "agent/config",
    "licenses",
  ]) {
    fs.mkdirSync(path.join(dir, ...directory.split("/")), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "agent", "runtime", process.platform === "win32" ? "node.exe" : "node"), "runtime");
  fs.writeFileSync(path.join(dir, "agent", "src", "agent", "launcher.js"), "agent");
  fs.writeFileSync(
    path.join(dir, "agent", "package.json"),
    JSON.stringify({ name: "fixture", version: "1.2.3" })
  );
  fs.writeFileSync(
    path.join(dir, "agent", "package-lock.json"),
    JSON.stringify({ name: "fixture", version: "1.2.3", packages: { "": { version: "1.2.3" } } })
  );
  fs.writeFileSync(path.join(dir, "agent", "contracts", "ipc-v1.schema.json"), "{}");
  fs.writeFileSync(path.join(dir, "agent", "contracts", "ipc-v1.methods.schema.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "agent", "config", "selectors.json"),
    JSON.stringify({ url: "https://chatgpt.com/" })
  );
  fs.writeFileSync(path.join(dir, "agent", "bin", process.platform === "win32" ? "mihomo.exe" : "mihomo"), "mihomo");
  fs.writeFileSync(path.join(dir, "licenses", "mihomo-GPL-3.0.txt"), "gpl");
  fs.writeFileSync(path.join(dir, "licenses", "Node.js-LICENSE.txt"), "node license");
  fs.writeFileSync(path.join(dir, "licenses", "runtime-versions.json"), "{}");
  fs.writeFileSync(path.join(dir, "GptAccountKeeper.Desktop.exe"), "desktop");
  return dir;
}

test("release verifier accepts a private Node package without browser payloads", (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(dir, "SHA256SUMS")), true);
});

test("release verifier rejects Chromium and the legacy web panel", (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "ms-playwright", "chromium-123"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ms-playwright", "chromium-123", "chrome.exe"), "browser");
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden browser\/web-panel\/development assets/i);
});

test("release verifier rejects native debug symbols", (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "GptAccountKeeper.Desktop.pdb"), "debug symbols");
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GptAccountKeeper\.Desktop\.pdb/);
});

test("release verifier rejects a package without the site selectors", (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 少了这个文件，打包步骤不会报错，但安装版会在用户点“打开网页”或“登录”时
  // 以 ENOENT 失败 —— 这类缺失必须在发布门禁挡住。
  fs.rmSync(path.join(dir, "agent", "config", "selectors.json"));
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /selectors/i);
});

test("release verifier rejects a staged Agent whose version differs from the release", (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, dir, "1.2.4"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version mismatch/i);
});
