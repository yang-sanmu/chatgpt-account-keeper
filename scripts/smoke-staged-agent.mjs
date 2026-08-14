#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const stage = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.statSync(stage, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("usage: node scripts/smoke-staged-agent.mjs <staged-package-dir>");
  process.exit(2);
}

const nodeExecutable = path.join(stage, "agent", "runtime", process.platform === "win32" ? "node.exe" : "node");
const launcher = path.join(stage, "agent", "src", "agent", "launcher.js");
const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const endpoint = process.platform === "win32"
  ? `\\\\.\\pipe\\gpt-account-keeper-stage-smoke-${suffix}`
  : path.join(os.tmpdir(), `gpt-account-keeper-stage-smoke-${suffix}.sock`);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-staged-agent-"));
const dataRoot = path.join(temporaryRoot, "data");
const expectedAgentVersion = JSON.parse(
  fs.readFileSync(path.join(stage, "agent", "package.json"), "utf8")
).version;

function encodeFrame(value) {
  const json = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(4 + json.length);
  result.writeUInt32LE(json.length, 0);
  json.copy(result, 4);
  return result;
}

async function connect(child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let failure;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`staged Agent exited with ${child.exitCode}`);
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw failure ?? new Error("staged Agent IPC timeout");
}

function clientFor(socket) {
  let buffer = Buffer.alloc(0);
  let id = 0;
  const pending = new Map();
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const envelope = JSON.parse(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
      if (envelope.id && pending.has(envelope.id)) {
        pending.get(envelope.id)(envelope);
        pending.delete(envelope.id);
      }
    }
  });
  return (method, params = {}, commandId = undefined) => new Promise((resolve, reject) => {
    const requestId = String(++id);
    const timer = setTimeout(() => reject(new Error(`IPC timeout: ${method}`)), 5_000);
    pending.set(requestId, (envelope) => {
      clearTimeout(timer);
      if (envelope.error) reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
      else resolve(envelope.result);
    });
    socket.write(encodeFrame({
      id: requestId,
      method,
      params,
      ...(commandId ? { commandId } : {}),
    }));
  });
}

let child;
let socket;
let output = "";
try {
  child = spawn(nodeExecutable, [launcher, "--endpoint", endpoint, "--data-root", dataRoot], {
    cwd: path.join(stage, "agent"),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  socket = await connect(child);
  const call = clientFor(socket);
  const hello = await call("system.hello", {
    protocol: { major: 1, minor: 0 },
    clientVersion: "release-smoke",
    capabilities: ["events"],
  });
  if (hello.protocol?.major !== 1) throw new Error("unexpected Agent protocol");
  if (hello.agentVersion !== expectedAgentVersion) {
    throw new Error(
      `staged Agent version mismatch: expected ${expectedAgentVersion}, got ${hello.agentVersion}`
    );
  }
  const bootstrap = await call("system.bootstrap");
  if (!Array.isArray(bootstrap.accounts)) throw new Error("invalid bootstrap snapshot");
  if (!fs.existsSync(path.join(dataRoot, "keeper.db"))) throw new Error("SQLite database was not initialized");
  await call("system.shutdown", { reason: "release-smoke" }, randomUUID());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("staged Agent did not stop")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`staged Agent exited with ${code}`));
      else resolve();
    });
  });
  console.log("Staged private Node Agent passed IPC/SQLite startup smoke test.");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  socket?.destroy();
  if (child?.exitCode === null) child.kill();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
