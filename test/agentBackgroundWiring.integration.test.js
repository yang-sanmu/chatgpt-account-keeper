import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame, decodeJsonFrame } from "../src/agent/framing.js";
import { resolveBrokerExecutable } from "../src/chromeLauncherBroker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 真实接线验证：把 launcher 作为**受控子进程**启动（明确超时、正常 shutdown、等待
 * 退出），而不是在测试进程内 import 常驻入口——那会拉起一个无法自然退出的 Agent。
 */
function uniqueEndpoint() {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\gpt-keeper-wiring-${suffix}`;
  }
  const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  return path.posix.join(base.replace(/\\/g, "/"), `kpr-wire-${suffix}.sock`);
}

async function connectWithRetry(endpoint, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Agent 在 IPC 就绪前退出：code=${child.exitCode}`);
    }
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error("Agent IPC 连接超时");
}

function createClient(socket) {
  const decoder = new FrameDecoder();
  const pending = new Map();
  const events = [];
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const envelope = decodeJsonFrame(frame);
      if (envelope.event) {
        events.push(envelope);
        continue;
      }
      if (envelope.id && pending.has(envelope.id)) {
        pending.get(envelope.id)(envelope);
        pending.delete(envelope.id);
      }
    }
  });
  let nextId = 0;
  return {
    events,
    call(method, params = {}, commandId = undefined) {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`IPC 调用超时：${method}`));
        }, 8_000);
        pending.set(id, (envelope) => {
          clearTimeout(timer);
          if (envelope.error) reject(Object.assign(new Error(envelope.error.message), envelope.error));
          else resolve(envelope.result);
        });
        socket.write(encodeFrame({ id, method, params, ...(commandId ? { commandId } : {}) }));
      });
    },
  };
}

/**
 * 输出环形截断到 8 KB：无界累积会让测试进程一直持有活跃 handle 并放大内存。
 */
function ringCollector(limit = 8 * 1024) {
  let text = "";
  return {
    push(chunk) {
      text += chunk;
      if (text.length > limit) text = text.slice(text.length - limit);
    },
    get value() {
      return text;
    },
  };
}

/**
 * 数**本次 Agent 自己的**直接子 chrome-launcher。
 *
 * 早先用全机进程名的前后差值，那个量在并发套件里不归本测试所有：采样窗口横跨其它
 * 集成测试的 broker 生命周期，差值证明不了「这个 Agent 只创建了 1 个 broker」，
 * 单跑绿、全套红。按 ParentProcessId 过滤才与其它测试完全隔离。
 */
function countAgentBrokers(agentPid) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter \"Name='chrome-launcher.exe' AND "
        + `ParentProcessId=${agentPid}" -EA SilentlyContinue | Measure-Object).Count`,
    ],
    { encoding: "utf8" }
  );
  return Number(String(result.stdout ?? "").trim()) || 0;
}

/** 超时时先 kill child 并等它退出，再让断言失败，保证 after 钩子前已回收。 */
async function killAndWait(child) {
  if (child.exitCode === null) {
    try { child.kill(); } catch { /* already gone */ }
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 5_000);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function detachPipes(child) {
  for (const stream of [child.stdout, child.stderr]) {
    try {
      stream?.removeAllListeners("data");
      stream?.destroy();
    } catch { /* ignore */ }
  }
}

function spawnAgent(dataRoot, tempRoot, endpoint) {
  return spawn(
    process.execPath,
    ["src/agent/launcher.js", "--endpoint", endpoint, "--data-root", dataRoot],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GPT_ACCOUNT_KEEPER_BUILD: "wiring-test",
        GPT_ACCOUNT_KEEPER_CACHE_ROOT: path.join(tempRoot, "cache"),
        GPT_ACCOUNT_KEEPER_STATE_ROOT: path.join(tempRoot, "state"),
        GPT_ACCOUNT_KEEPER_RUNTIME_ROOT: path.join(tempRoot, "run"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
}

test(
  "真实 Agent：协议 minor 3、队列与 BrowserRun 方法可用、broker 恒为 1，shutdown 干净退出",
  { timeout: 90_000 },
  async (t) => {
    if (process.platform === "win32" && !resolveBrokerExecutable()) {
      return t.skip("chrome-launcher broker 未构建，Windows Agent 会 fail-closed");
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-wiring-"));
    const dataRoot = path.join(tempRoot, "data");
    const endpoint = uniqueEndpoint();
    const child = spawnAgent(dataRoot, tempRoot, endpoint);
    const collector = ringCollector();
    child.stdout.on("data", (chunk) => collector.push(String(chunk)));
    child.stderr.on("data", (chunk) => collector.push(String(chunk)));
    const output = () => collector.value;

    let socket;
    t.after(async () => {
      socket?.destroy();
      await killAndWait(child);
      detachPipes(child);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    socket = await connectWithRetry(endpoint, child);
    const client = createClient(socket);
    const hello = await client.call("system.hello", {
      protocol: { major: 1, minor: 3 },
      clientVersion: "wiring-test",
      capabilities: ["events"],
    });
    assert.equal(hello.protocol.maxMinor, 3, output());

    // 新方法必须真的接在服务上，而不只是写进契约。
    const snapshot = await client.call("queue.getSnapshot");
    assert.equal(snapshot.workSlots.limit, 4, output());
    assert.equal(snapshot.chromeSlots.limit, 4);
    assert.equal(snapshot.queuedTotal, 0);
    if (process.platform === "win32") {
      assert.ok(snapshot.broker, "Windows 上应报告 broker 状态");
      assert.equal(snapshot.broker.running, true);
    }

    const runs = await client.call("browserRuns.list");
    assert.deepEqual(runs.active, []);
    assert.equal(runs.chromeOccupancy, 0);
    assert.deepEqual(runs.quarantined, []);

    // 未知 BrowserRun 必须是 NOT_FOUND，而不是静默成功——browserRuns.close 的语义是
    // 「精确重试关闭 / 复验」，不是从列表里删掉。
    await assert.rejects(
      () => client.call("browserRuns.close", { browserRunId: "does-not-exist" }, randomUUID()),
      (error) => error.code === "NOT_FOUND"
    );

    if (process.platform === "win32") {
      // broker 是 Agent 级基础设施：存活期间恒为 1 个，不按 BrowserRun 重复创建。
      const brokers = countAgentBrokers(child.pid);
      assert.equal(brokers, 1, `本次 Agent 应恰好有 1 个直接子 broker，实际 ${brokers}`);
    }

    const shutdown = await client.call("system.shutdown", { reason: "wiring-test" }, randomUUID());
    assert.equal(shutdown.accepted, true);
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 25_000);
      timer.unref?.();
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exited === null) {
      await killAndWait(child);
      assert.fail(`Agent 未在 25 秒内退出：${output()}`);
    }
    assert.equal(exited, 0, output());

    if (process.platform === "win32") {
      await new Promise((resolve) => { const t2 = setTimeout(resolve, 1_500); t2.unref?.(); });
      const brokers = countAgentBrokers(child.pid);
      assert.equal(brokers, 0, `Agent 退出后不得留下 broker，实际 ${brokers}`);
    }
  }
);

test(
  "Windows：broker 可执行文件缺失时 Agent 在接受 IPC 前 fail-closed 且不留子进程",
  { timeout: 60_000 },
  async (t) => {
    if (process.platform !== "win32") return t.skip("仅 Windows 要求 broker");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-nobroker-"));
    const dataRoot = path.join(tempRoot, "data");
    const endpoint = uniqueEndpoint();
    const child = spawn(
      process.execPath,
      ["src/agent/launcher.js", "--endpoint", endpoint, "--data-root", dataRoot],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          GPT_ACCOUNT_KEEPER_BUILD: "nobroker-test",
          GPT_ACCOUNT_KEEPER_CACHE_ROOT: path.join(tempRoot, "cache"),
          GPT_ACCOUNT_KEEPER_STATE_ROOT: path.join(tempRoot, "state"),
          GPT_ACCOUNT_KEEPER_RUNTIME_ROOT: path.join(tempRoot, "run"),
          // 指向一个不存在的 broker，模拟安装损坏。
          GPT_ACCOUNT_KEEPER_CHROME_LAUNCHER: path.join(tempRoot, "missing", "chrome-launcher.exe"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    const collector = ringCollector();
    child.stdout.on("data", (chunk) => collector.push(String(chunk)));
    child.stderr.on("data", (chunk) => collector.push(String(chunk)));
    const output = () => collector.value;

    t.after(async () => {
      await killAndWait(child);
      detachPipes(child);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      timer.unref?.();
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode === null) {
      await killAndWait(child);
      assert.fail(`Agent 未在 30 秒内退出：${output()}`);
    }
    // 不允许启动一个没有进程树兜底的 Windows Agent，也不允许退化成每个账号各自失败。
    assert.notEqual(exitCode, 0, `broker 缺失时必须非零退出，实际 ${exitCode}；输出：${output()}`);
    assert.match(output(), /CHROME_BROKER_UNAVAILABLE|chrome-launcher/i, output());
    // IPC 端点不应可连接。
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const probe = net.createConnection(endpoint);
        probe.once("connect", () => { probe.destroy(); resolve(); });
        probe.once("error", reject);
      })
    );
  }
);
