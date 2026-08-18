import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame, decodeJsonFrame } from "../src/agent/framing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 短名 + /tmp：macOS 的 sun_path 上限是 104 字节，而 os.tmpdir() 在 macOS 上
// 本身就占约 50 字节，原来的长名在那里必然 bind 失败。
function uniqueEndpoint() {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\gpt-account-keeper-integration-${suffix}`;
  }
  const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  return path.posix.join(base.replace(/\\/g, "/"), `kpr-int-${suffix}.sock`);
}

async function connectWithRetry(endpoint, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Agent exited before IPC was ready: ${child.exitCode}`);
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
  throw lastError ?? new Error("Agent IPC connect timed out");
}

function createClient(socket) {
  const decoder = new FrameDecoder();
  const pending = new Map();
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const envelope = decodeJsonFrame(frame);
      if (envelope.id && pending.has(envelope.id)) {
        pending.get(envelope.id)(envelope);
        pending.delete(envelope.id);
      }
    }
  });
  let nextId = 0;
  return {
    call(method, params = {}, commandId = undefined) {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`IPC call timed out: ${method}`));
        }, 5_000);
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

test("installed launcher initializes SQLite and replays durable IPC command receipts", { timeout: 20_000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-agent-installed-"));
  const dataRoot = path.join(tempRoot, "data");
  const cacheRoot = path.join(tempRoot, "isolated-cache");
  const stateRoot = path.join(tempRoot, "isolated-state");
  const runtimeRoot = path.join(tempRoot, "isolated-run");
  const endpoint = uniqueEndpoint();
  const child = spawn(
    process.execPath,
    ["src/agent/launcher.js", "--endpoint", endpoint, "--data-root", dataRoot],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GPT_ACCOUNT_KEEPER_BUILD: "integration-test",
        GPT_ACCOUNT_KEEPER_CACHE_ROOT: cacheRoot,
        GPT_ACCOUNT_KEEPER_STATE_ROOT: stateRoot,
        GPT_ACCOUNT_KEEPER_RUNTIME_ROOT: runtimeRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  let socket;
  t.after(async () => {
    socket?.destroy();
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  socket = await connectWithRetry(endpoint, child);
  const client = createClient(socket);
  const hello = await client.call("system.hello", {
    protocol: { major: 1, minor: 0 },
    clientVersion: "integration-test",
    capabilities: ["events"],
  });
  assert.equal(hello.protocol.major, 1);

  const commandId = randomUUID();
  const created = await client.call("accounts.create", {
    note: "installed integration",
    enabled: true,
    switchRule: "random",
    minWindows: 1,
    maxWindows: 3,
  }, commandId);
  const replayed = await client.call("accounts.create", {
    note: "must not duplicate",
    enabled: true,
    switchRule: "random",
    minWindows: 1,
    maxWindows: 3,
  }, commandId);
  assert.equal(replayed.id, created.id);

  const bootstrap = await client.call("system.bootstrap");
  assert.equal(bootstrap.accounts.length, 1);
  assert.equal(bootstrap.accounts[0].id, created.id);
  assert.ok(fs.existsSync(path.join(dataRoot, "keeper.db")), output);
  assert.ok(fs.existsSync(path.join(stateRoot, "logs")), "custom Agent state root was ignored");
  assert.equal(fs.existsSync(path.join(dataRoot, "config", "accounts.json")), false);

  const shutdown = await client.call(
    "system.shutdown",
    { reason: "integration-test" },
    randomUUID()
  );
  assert.equal(shutdown.accepted, true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent did not exit: ${output}`)), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      assert.equal(code, 0, output);
      resolve();
    });
  });
});
