import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installShutdownHandlers } from "../src/shutdown.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.exits = [];
  }

  exit(code) {
    this.exits.push(code);
  }
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test("SIGINT 完成清理后以 Ctrl+C 状态码退出", async () => {
  const processRef = new FakeProcess();
  let finishCleanup;
  let cleanupCalls = 0;
  const cleanup = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  let watchdogCleared = false;

  installShutdownHandlers({
    processRef,
    shutdown: async () => {
      cleanupCalls++;
      await cleanup;
    },
    logger: { info() {}, warn() {}, error() {} },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {
      watchdogCleared = true;
    },
  });

  processRef.emit("SIGINT");
  await flushPromises();

  assert.equal(cleanupCalls, 1);
  assert.equal(processRef.exitCode, 130);
  assert.deepEqual(processRef.exits, []);

  finishCleanup();
  await flushPromises();

  assert.equal(watchdogCleared, true);
  assert.deepEqual(processRef.exits, [130]);
});

test("清理期间再次收到信号会立即退出", async () => {
  const processRef = new FakeProcess();

  installShutdownHandlers({
    processRef,
    shutdown: () => new Promise(() => {}),
    logger: { info() {}, warn() {}, error() {} },
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  });

  processRef.emit("SIGINT");
  processRef.emit("SIGINT");

  assert.deepEqual(processRef.exits, [130]);
});

test("清理失败仍会记录错误并退出", async () => {
  const processRef = new FakeProcess();
  const errors = [];

  installShutdownHandlers({
    processRef,
    shutdown: async () => {
      throw new Error("cleanup failed");
    },
    logger: {
      info() {},
      warn() {},
      error(message) {
        errors.push(message);
      },
    },
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  });

  processRef.emit("SIGTERM");
  await flushPromises();

  assert.match(errors[0], /cleanup failed/);
  assert.deepEqual(processRef.exits, [143]);
});
