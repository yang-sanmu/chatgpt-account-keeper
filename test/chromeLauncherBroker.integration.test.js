import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BROKER_PROTOCOL_VERSION,
  ChromeLauncherBroker,
  buildWindowsCommandLine,
  resolveBrokerExecutable,
} from "../src/chromeLauncherBroker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(here, "..");

function brokerOrSkip(t) {
  const executable = resolveBrokerExecutable();
  if (!executable) {
    t.skip("chrome-launcher broker 未构建（tools/chrome-launcher 需先 dotnet publish）");
    return null;
  }
  return executable;
}

function chromeOrSkip(t) {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    t.skip("本机没有 branded Chrome");
    return null;
  }
  return found;
}

function tempProfile(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `broker-${tag}-`));
}

/**
 * Chrome may still be releasing its profile file locks when the assertions are done.
 * The test's subject is containment, not filesystem timing, so cleanup retries briefly
 * and then gives up instead of failing an otherwise passing case.
 */
function removeProfile(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EBUSY") return;
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin: rmSync is sync */ }
    }
  }
}

test("launch 的明确前置拒绝不会被误判为所有权不确定", async () => {
  const broker = new ChromeLauncherBroker();
  for (const code of [
    "INVALID_REQUEST",
    "TOKEN_IN_USE",
    "TOKEN_RETIRED",
    "CAPACITY_EXHAUSTED",
    "LAUNCH_FAILED",
  ]) {
    broker._send = async () => ({ ok: false, code, message: code });
    await assert.rejects(
      broker.launch("token", "chrome.exe", []),
      (error) => error.code === code && error.ownershipCertain === true
    );
  }
  broker._send = async () => ({ ok: false, code: "INTERNAL", message: "unknown" });
  await assert.rejects(
    broker.launch("token", "chrome.exe", []),
    (error) => error.ownershipCertain === false
  );
});

test(
  "broker ready 握手报告协议版本、RID 与 capability",
  { timeout: 30_000 },
  async (t) => {
    if (process.platform !== "win32") return t.skip("broker 仅 Windows");
    if (!brokerOrSkip(t)) return;
    const broker = new ChromeLauncherBroker();
    try {
      const ready = await broker.start();
      assert.equal(ready.protocolVersion, BROKER_PROTOCOL_VERSION);
      assert.equal(ready.rid, "win-x64");
      assert.ok(ready.capabilities.includes("per-run-job"));
      assert.ok(ready.capabilities.includes("creation-time-containment"));
      assert.ok(ready.capabilities.includes("tombstone-idempotent-dispose"));
      assert.ok(broker.generationId);
    } finally {
      await broker.dispose();
    }
  }
);

test(
  "错误的 brokerGenerationId 与未知 runToken 都被拒绝",
  { timeout: 30_000 },
  async (t) => {
    if (process.platform !== "win32") return t.skip("broker 仅 Windows");
    if (!brokerOrSkip(t)) return;
    const broker = new ChromeLauncherBroker();
    try {
      await broker.start();
      const stale = await broker.sendRaw({
        requestId: "stale-1",
        command: "enumerate",
        brokerGenerationId: "0000000000000000deadbeef00000000",
        runToken: "whatever",
      });
      assert.equal(stale.ok, false);
      assert.equal(stale.code, "GENERATION_MISMATCH");

      const unknown = await broker.sendRaw({
        requestId: "unknown-1",
        command: "enumerate",
        brokerGenerationId: broker.generationId,
        runToken: "never-launched",
      });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.code, "UNKNOWN_TOKEN");
    } finally {
      await broker.dispose();
    }
  }
);

test(
  "真实 Chrome：per-run Job 权威枚举覆盖整棵树，terminate 后计数归零",
  { timeout: 90_000 },
  async (t) => {
    if (process.platform !== "win32") return t.skip("broker 仅 Windows");
    const executable = brokerOrSkip(t);
    if (!executable) return;
    const chrome = chromeOrSkip(t);
    if (!chrome) return;

    const broker = new ChromeLauncherBroker();
    const profile = tempProfile("tree");
    try {
      await broker.start();
      const runToken = broker.newRunToken();
      const launched = await broker.launch(runToken, chrome, [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "about:blank",
      ]);
      assert.ok(launched.rootPid > 0);
      assert.ok(launched.rootStartTime > 0);

      // Give Chrome time to spawn its helper processes.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const listed = await broker.enumerate(runToken);
      assert.ok(listed.count > 1, `Job 应包含 root 与后代，实际 ${listed.count}`);
      assert.equal(listed.disposed, false);
      assert.ok(listed.pids.includes(launched.rootPid));

      // Cross-check every live descendant with IsProcessInJob. A set difference against
      // the job pid list is NOT usable here: the two snapshots are taken at different
      // instants, so a utility process that exits in between looks like a phantom
      // escape. This was observed in practice before switching to per-pid inspection.
      const walked = descendants(launched.rootPid);
      const inspected = await broker.inspect(runToken, walked);
      assert.equal(inspected.ok, true);
      assert.deepEqual(
        inspected.outside,
        [],
        `这些后代经 IsProcessInJob 确认不在 per-run Job 内：${inspected.outside.join(",")}`
      );

      // dispose must be refused while members remain: releasing ownership early is the
      // exact "freed the slot while renderers were alive" defect being fixed.
      const premature = await broker.sendRaw({
        requestId: "premature-dispose",
        command: "dispose",
        brokerGenerationId: broker.generationId,
        runToken,
      });
      assert.equal(premature.ok, false);
      assert.equal(premature.code, "JOB_NOT_EMPTY");

      await broker.terminate(runToken);
      const drained = await broker.waitForEmpty(runToken, 5_000);
      assert.equal(drained.count, 0);

      const disposed = await broker.dispose_(runToken);
      assert.equal(disposed.ok, true);
      assert.equal(disposed.disposed, true);
    } finally {
      await broker.dispose();
      removeProfile(profile);
    }
  }
);

test(
  "dispose ack 丢失可由 tombstone 幂等收敛，token 不可复用，forget 幂等",
  { timeout: 60_000 },
  async (t) => {
    if (process.platform !== "win32") return t.skip("broker 仅 Windows");
    const executable = brokerOrSkip(t);
    if (!executable) return;
    const chrome = chromeOrSkip(t);
    if (!chrome) return;

    const broker = new ChromeLauncherBroker();
    const profile = tempProfile("tomb");
    try {
      await broker.start();
      const runToken = broker.newRunToken();
      await broker.launch(runToken, chrome, [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--headless=new",
        "about:blank",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await broker.terminate(runToken);
      await broker.waitForEmpty(runToken, 5_000);
      await broker.dispose_(runToken);

      // Simulates "dispose succeeded but every response was lost": the retry must be a
      // definitive success, otherwise the account would stay quarantined forever even
      // though Chrome was already reclaimed.
      const replayEnumerate = await broker.enumerate(runToken);
      assert.equal(replayEnumerate.count, 0);
      assert.equal(replayEnumerate.disposed, true);
      const replayDispose = await broker.dispose_(runToken);
      assert.equal(replayDispose.ok, true);
      assert.equal(replayDispose.disposed, true);

      // A retired token must never be reusable: reuse makes the tombstone ambiguous.
      const reuse = await broker.sendRaw({
        requestId: "reuse-1",
        command: "launch",
        brokerGenerationId: broker.generationId,
        runToken,
        executable: chrome,
        args: [`--user-data-dir=${profile}`, "about:blank"],
      });
      assert.equal(reuse.ok, false);
      assert.equal(reuse.code, "TOKEN_RETIRED");

      assert.equal((await broker.forget(runToken)).ok, true);
      // forget is idempotent for unknown tokens as well, so a lost forget response is
      // safe to retry and can never turn into an error the Agent must special-case.
      assert.equal((await broker.forget(runToken)).ok, true);
    } finally {
      await broker.dispose();
      removeProfile(profile);
    }
  }
);

test(
  "活动 run 存在时 shutdown 被拒；broker 崩溃使全部 per-run Job 回收 Chrome",
  { timeout: 90_000 },
  async (t) => {
    if (process.platform !== "win32") return t.skip("broker 仅 Windows");
    const executable = brokerOrSkip(t);
    if (!executable) return;
    const chrome = chromeOrSkip(t);
    if (!chrome) return;

    const broker = new ChromeLauncherBroker();
    const profiles = [tempProfile("crash1"), tempProfile("crash2")];
    const roots = [];
    try {
      await broker.start();
      for (const profile of profiles) {
        const runToken = broker.newRunToken();
        const launched = await broker.launch(runToken, chrome, [
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--headless=new",
          "about:blank",
        ]);
        roots.push(launched.rootPid);
      }
      await new Promise((resolve) => setTimeout(resolve, 6_000));

      // Refusing shutdown while runs are active is what stops broker exit from being
      // mistaken for a clean per-run close.
      const refused = await broker.sendRaw({
        requestId: "shutdown-busy",
        command: "shutdown",
        brokerGenerationId: broker.generationId,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "ACTIVE_RUNS_REMAIN");
      assert.equal(refused.activeCount, 2);

      broker.killForTest();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      for (const rootPid of roots) {
        assert.equal(
          processAlive(rootPid),
          false,
          `broker 崩溃后 root ${rootPid} 仍存活，KILL_ON_JOB_CLOSE 未生效`
        );
      }
    } finally {
      await broker.dispose();
      for (const profile of profiles) removeProfile(profile);
    }
  }
);

test(
  "Windows 命令行转义覆盖空格、引号与结尾反斜杠",
  () => {
    // Not Windows-gated: pure string logic, and profile paths with spaces are the
    // realistic failure mode when moving from ArgumentList to a single command line.
    assert.equal(
      buildWindowsCommandLine("C:/Program Files/x/chrome.exe", ["--a=b"]),
      '"C:/Program Files/x/chrome.exe" --a=b'
    );
    assert.equal(
      buildWindowsCommandLine("chrome.exe", ["--user-data-dir=C:/Users/A B/p"]),
      'chrome.exe "--user-data-dir=C:/Users/A B/p"'
    );
    assert.equal(
      buildWindowsCommandLine("chrome.exe", ['--x="y"']),
      'chrome.exe "--x=\\"y\\""'
    );
    assert.equal(
      buildWindowsCommandLine("chrome.exe", ["--dir=C:\\path with space\\"]),
      'chrome.exe "--dir=C:\\path with space\\\\"'
    );
  }
);

function descendants(rootPid) {
  const script = `
$all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
$seen = New-Object 'System.Collections.Generic.HashSet[int]'
$stack = New-Object 'System.Collections.Generic.Stack[int]'
[void]$stack.Push(${rootPid}); [void]$seen.Add(${rootPid})
while ($stack.Count -gt 0) {
  $cur = $stack.Pop()
  foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) {
    if ($seen.Add([int]$c.ProcessId)) { [void]$stack.Push([int]$c.ProcessId) }
  }
}
$seen -join ','`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
  return String(result.stdout ?? "")
    .trim()
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function processAlive(pid) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `[bool](Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -EA SilentlyContinue)`],
    { encoding: "utf8" }
  );
  return String(result.stdout ?? "").trim() === "True";
}

void repositoryRoot;
