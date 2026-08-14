import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock } from "../src/agent/instanceLock.js";

function newRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "keeper-lock-"));
}

test("第二个 Agent 实例无法占用同一个数据目录", async (t) => {
  const root = newRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "agent.lock");

  const first = await acquireInstanceLock(lockFile);
  assert.equal(fs.existsSync(lockFile), true);
  await assert.rejects(
    acquireInstanceLock(lockFile),
    (error) => error.code === "AGENT_ALREADY_RUNNING" && error.pid === process.pid
  );

  await first.release();
  assert.equal(fs.existsSync(lockFile), false);
  const replacement = await acquireInstanceLock(lockFile);
  await replacement.release();
});

test("旧锁 PID 已复用但 IPC 不存在时会安全接管", async (t) => {
  const root = newRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "agent.lock");
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: 4242, startedAt: "2020-01-01T00:00:00.000Z" }),
    "utf8"
  );

  const lock = await acquireInstanceLock(lockFile, {
    pid: 5252,
    isProcessAlive: () => true,
    endpoint: process.platform === "win32"
      ? `\\\\.\\pipe\\keeper-stale-${Date.now()}`
      : path.join(root, "missing-agent.sock"),
    probeEndpoint: async () => false,
  });
  const metadata = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(metadata.pid, 5252);
  assert.equal(typeof metadata.lockId, "string");
  await lock.release();
});

test("仍在启动宽限期内的旧 Agent 不会被接管", async (t) => {
  const root = newRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "agent.lock");
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: 4321, startedAt: new Date().toISOString() }),
    "utf8"
  );

  await assert.rejects(
    acquireInstanceLock(lockFile, {
      pid: 111,
      isProcessAlive: () => true,
      probeEndpoint: async () => false,
    }),
    (error) => error.code === "AGENT_ALREADY_RUNNING" && error.pid === 4321
  );
});

test("损坏或空的诊断锁文件不会让 Agent 永久起不来", async (t) => {
  const root = newRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "agent.lock");
  fs.writeFileSync(lockFile, "{ 半行 JSON", "utf8");

  const lock = await acquireInstanceLock(lockFile, { pid: 222 });
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, 222);
  await lock.release();
});

test("释放只删除自己的诊断文件，不会误删接管者的锁", async (t) => {
  const root = newRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "agent.lock");

  const first = await acquireInstanceLock(lockFile, { pid: 700 });
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: 800, startedAt: "now", lockId: "replacement" }),
    "utf8"
  );
  await first.release();
  assert.equal(fs.existsSync(lockFile), true, "不能删掉别人的锁");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, 800);
});
