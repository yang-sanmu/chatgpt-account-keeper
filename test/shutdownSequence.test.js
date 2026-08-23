import test from "node:test";
import assert from "node:assert/strict";
import { runShutdownSequence } from "../src/agent/shutdownSequence.js";
import { OperationRegistry } from "../src/application/operations.js";

function recorder() {
  const calls = [];
  const deps = {
    log: { warn() {}, error() {}, info() {} },
    stepTimeoutMs: 200,
    overallTimeoutMs: 5_000,
    beginDraining: () => calls.push("draining"),
    stopAccepting: () => calls.push("stopAccepting"),
    stopTimers: () => calls.push("stopTimers"),
    cancelQueued: () => calls.push("cancelQueued"),
    signalActive: () => calls.push("signalActive"),
    closeInteractive: () => calls.push("closeInteractive"),
    closeBrowserRuns: () => calls.push("closeBrowserRuns"),
    awaitConvergence: () => calls.push("awaitConvergence"),
    shutdownBroker: () => calls.push("shutdownBroker"),
    flushOperations: () => calls.push("flush"),
    sealOperations: () => calls.push("seal"),
    stopProxies: () => calls.push("stopProxies"),
    closeRepository: () => calls.push("closeRepository"),
    releaseBackends: () => calls.push("releaseBackends"),
    destroyServer: () => calls.push("destroyServer"),
    releaseInstanceLock: () => calls.push("releaseInstanceLock"),
    unresolved: () => [],
  };
  return { calls, deps };
}

test("正常关闭按 16 步顺序执行，IPC 销毁晚于最终事件推送", async () => {
  const { calls, deps } = recorder();
  const result = await runShutdownSequence(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "draining",
    "stopAccepting",
    "stopTimers",
    "cancelQueued",
    "signalActive",
    "closeInteractive",
    "closeBrowserRuns",
    "awaitConvergence",
    "shutdownBroker",
    "flush",
    "seal",
    "stopProxies",
    "closeRepository",
    "releaseBackends",
    "destroyServer",
    "releaseInstanceLock",
  ]);
  // The whole point of the two-stage IPC split: clients stay connected long enough to
  // receive the final events flushed in step 10.
  assert.ok(calls.indexOf("flush") < calls.indexOf("destroyServer"));
  assert.ok(calls.indexOf("seal") < calls.indexOf("closeRepository"));
});

test("broker registry 仍有 active entry 时不得 seal 也不得关库", async () => {
  const { calls, deps } = recorder();
  deps.unresolved = () => [{ kind: "browserRun", runToken: "tok-1", accountId: "acc-1" }];
  const result = await runShutdownSequence(deps);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(result.step, 9);
  // A live handler writing after the database is closed is worse than not
  // checkpointing, so these must not run.
  assert.equal(calls.includes("seal"), false, "未收敛时禁止 seal");
  assert.equal(calls.includes("closeRepository"), false, "未收敛时禁止 checkpoint/close");
});

test("handler 未收敛（第 8 步超时）同样阻止 seal 与关库", async () => {
  const { calls, deps } = recorder();
  deps.awaitConvergence = () => new Promise(() => {});
  const result = await runShutdownSequence(deps);
  assert.equal(result.fatal, true);
  assert.equal(result.step, 8);
  assert.equal(calls.includes("seal"), false);
  assert.equal(calls.includes("closeRepository"), false);
});

test("broker shutdown 被拒时进入 fatal 路径", async () => {
  const { calls, deps } = recorder();
  deps.shutdownBroker = () => {
    throw new Error("ACTIVE_RUNS_REMAIN");
  };
  const result = await runShutdownSequence(deps);
  assert.equal(result.fatal, true);
  assert.equal(result.step, 9);
  assert.equal(calls.includes("seal"), false);
});

test("整体硬超时把卡住的步骤上报为 fatal", async () => {
  const { deps } = recorder();
  deps.overallTimeoutMs = 300;
  deps.stepTimeoutMs = 10_000;
  deps.closeBrowserRuns = () => new Promise(() => {});
  const result = await runShutdownSequence(deps);
  assert.equal(result.fatal, true);
  assert.equal(result.step, 7);
  assert.match(result.detail, /整体关闭超过/);
});

test("seal 之后的写入是 invariant violation：计数而不抛，且不改内存态", () => {
  const saved = [];
  const registry = new OperationRegistry({
    store: { save: (operation) => saved.push(operation.id) },
    log: { warn() {}, error() {} },
  });
  const declared = registry.declare("account-run", { resourceId: "acc-1" });
  assert.equal(registry.sealViolations, 0);

  registry.flush("Agent 关闭，任务已中断");
  assert.equal(registry.get(declared.id).state, "cancelled");

  registry.seal();
  registry.update(declared.id, { message: "post-seal" });
  // Terminal operations ignore updates, so force a persist attempt on a fresh one.
  registry.declare("late-arrival", { resourceId: "acc-2" });
  assert.ok(registry.sealViolations > 0, "seal 之后的写入必须被计数");
  assert.equal(registry.sealed, true);
});

test("运行期持久化失败只记账，不反向覆盖业务主结果", () => {
  const registry = new OperationRegistry({
    store: {
      save: () => {
        throw new Error("disk full");
      },
    },
    log: { warn() {}, error() {} },
  });
  const declared = registry.declare("account-run", { resourceId: "acc-1" });
  registry.update(declared.id, { state: "succeeded", result: { ok: true } });
  // A transient write failure must not become a business failure.
  assert.equal(registry.get(declared.id).state, "succeeded");
  assert.deepEqual(registry.get(declared.id).result, { ok: true });
  assert.ok(registry.persistFailures > 0, "持久化失败必须被计数而不是静默吞掉");
});
