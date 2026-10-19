import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = fileURLToPath(new URL("../scripts/registration-browser.mjs", import.meta.url));

async function rejectRequest(request, bootstrap = null) {
  return new Promise((resolve, reject) => {
    const args = bootstrap ? ["--input-type=module", "--eval", bootstrap] : [script];
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let diagnostics = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("bridge failed to exit")); }, 10_000);
    child.on("error", reject);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, events: output.trim().split("\n").filter(Boolean).map(JSON.parse), diagnostics });
    });
    if (bootstrap) child.stdin.write(request + "\n");
    else child.stdin.end(request + "\n");
  });
}

test("registration bridge rejects invalid input without launching or creating a profile", async () => {
  for (const request of ["invalid-json", JSON.stringify({ protocol: 2, command: "open" }),
    JSON.stringify({ protocol: 1, command: "open", proxy: "http://user:secret@proxy.example:80" }),
    JSON.stringify({ protocol: 1, command: "open", timezone: "not-a-timezone" })]) {
    const result = await rejectRequest(request);
    assert.equal(result.code, 1, result.diagnostics);
    assert.ok(result.events.some(event => event.event === "error"));
    const closed = result.events.find(event => event.event === "closed");
    assert.equal(closed.cleaned, true);
    assert.equal(closed.runtime_dir, null);
    assert.ok(!JSON.stringify(result.events).includes("secret"));
  }
});

test("missing Chrome keeps the launch error and removes the unused temporary profile", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registration-bridge-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bootstrap = `
    for (const kind of ["DATA", "CACHE", "STATE"]) process.env["GPT_ACCOUNT_KEEPER_" + kind + "_ROOT"] = ${JSON.stringify(root)};
    const { ChromeLauncherBroker } = await import(${JSON.stringify(new URL("../src/chromeLauncherBroker.js", import.meta.url).href)});
    const { ChromeProcessLauncher } = await import(${JSON.stringify(new URL("../src/chromeProcessLauncher.js", import.meta.url).href)});
    ChromeLauncherBroker.prototype.start = async function() {};
    ChromeLauncherBroker.prototype.dispose = async function() {};
    ChromeProcessLauncher.prototype.launch = async function() {
      throw Object.assign(new Error("Chrome not found"), { code: "CHROME_NOT_FOUND" });
    };
    await import(${JSON.stringify(new URL("../scripts/registration-browser.mjs", import.meta.url).href)});
  `;
  const result = await rejectRequest(JSON.stringify({ protocol: 1, command: "open", headless: false }), bootstrap);
  assert.equal(result.code, 1, result.diagnostics);
  assert.equal(result.events.find(e => e.event === "error")?.message, "Chrome not found");
  const closed = result.events.find(e => e.event === "closed");
  // Even a failed assertion must remove only this test's confirmed, never-launched directory.
  if (closed?.runtime_dir) {
    const owned = path.resolve(closed.runtime_dir);
    assert.equal(await fs.promises.realpath(path.dirname(owned)), await fs.promises.realpath(os.tmpdir()));
    assert.ok(path.basename(owned).startsWith("gptaccount-registration-"));
    t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  }
  assert.equal(closed?.cleaned, true, result.diagnostics);
  assert.equal(fs.existsSync(closed.runtime_dir), false);
});
