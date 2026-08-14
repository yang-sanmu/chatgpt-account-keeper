import test from "node:test";
import assert from "node:assert/strict";
import { OperationRegistry } from "../src/application/operations.js";
import { ApplicationError, ERROR_CODES } from "../src/application/errors.js";

/** 内存版持久化后端：只验证 registry 与后端的契约，不牵扯 SQLite 原生依赖。 */
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    save(operation) {
      rows.set(operation.id, { ...operation });
    },
    list({ limit = 200, includeTerminal = true } = {}) {
      return [...rows.values()]
        .filter((row) => includeTerminal || !["succeeded", "failed", "timed_out", "cancelled"].includes(row.state))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, limit);
    },
    cancelUnfinished() {
      let changed = 0;
      for (const row of rows.values()) {
        if (["succeeded", "failed", "timed_out", "cancelled"].includes(row.state)) continue;
        row.state = "cancelled";
        row.message = "Agent 重启，任务已中断";
        row.finishedAt = "2026-01-01T00:00:00.000Z";
        changed++;
      }
      return changed;
    },
    prune() {},
  };
}

test("任务结果与错误详情写入持久化后端", async () => {
  const store = fakeStore();
  const registry = new OperationRegistry({ store });
  const created = registry.create("proxy-test-all", async () => ({ results: [] }));
  await registry.waitForTerminal(created.id);

  const stored = store.rows.get(created.id);
  assert.equal(stored.state, "succeeded");
  assert.deepEqual(stored.result, { results: [] });
});

test("失败任务的稳定错误码可跨重启查询", async () => {
  const store = fakeStore();
  const first = new OperationRegistry({ store });
  const failing = first.create("account-run", async () => {
    throw new ApplicationError(ERROR_CODES.VALIDATION_FAILED, "未登录");
  });
  await first.waitForTerminal(failing.id);

  // 新的注册表代表重启后的 Agent：内存是空的，只能靠后端恢复。
  const restarted = new OperationRegistry({ store });
  assert.equal(restarted.restore(), 1);
  const recovered = restarted.get(failing.id);
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.error.code, ERROR_CODES.VALIDATION_FAILED);
  assert.equal(recovered.error.message, "未登录");
});

test("重启后未完成的任务不会伪装成仍在运行", () => {
  const store = fakeStore();
  store.save({
    id: "op-stuck",
    kind: "account-login",
    state: "running",
    stage: "waiting",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blocksUpdate: true,
  });

  const registry = new OperationRegistry({ store });
  registry.restore();
  assert.deepEqual(registry.listActive(), [], "上次遗留的任务不可能继续推进");
  assert.equal(registry.get("op-stuck").state, "cancelled");
});

test("内存淘汰后仍能从后端取回历史任务", async () => {
  const store = fakeStore();
  const registry = new OperationRegistry({ store, maxTerminal: 1, retentionMs: 0 });
  const first = registry.create("profile-scan", async () => ({ profiles: [] }));
  await registry.waitForTerminal(first.id);
  const second = registry.create("profile-scan", async () => ({ profiles: [] }));
  await registry.waitForTerminal(second.id);

  assert.equal(registry._operations.has(first.id), false, "内存里应已淘汰");
  assert.equal(registry.get(first.id).id, first.id, "错误中心仍要能回看历史失败");
  assert.equal(registry.list({ limit: 10 }).length, 2);
});

test("后端异常不会让任务本身失败", async () => {
  const broken = {
    save() {
      throw new Error("磁盘满了");
    },
    list() {
      throw new Error("磁盘满了");
    },
    cancelUnfinished() {
      throw new Error("磁盘满了");
    },
  };
  const registry = new OperationRegistry({ store: broken });
  const created = registry.create("profile-scan", async () => ({ ok: true }));
  const settled = await registry.waitForTerminal(created.id);
  assert.equal(settled.state, "succeeded");
  assert.deepEqual(registry.list({ limit: 5 }).map((item) => item.id), [created.id]);
});

test("多阶段任务的 stage 与 progress 会逐步上报", async () => {
  const store = fakeStore();
  const registry = new OperationRegistry({ store });
  const seen = [];
  const events = {
    publish: (_name, operation) => seen.push({
      state: operation.state,
      stage: operation.stage,
      progress: operation.progress,
    }),
  };
  const tracked = new OperationRegistry({ store, events });
  const created = tracked.create("proxy-test-all", async ({ update }) => {
    update({ stage: "measure", message: "1/2", progress: 0.25 });
    update({ stage: "measure", message: "2/2", progress: 0.75 });
    return { results: [] };
  });
  await tracked.waitForTerminal(created.id);
  // 进度条必须收到真实的中间值，而不是只有开始的 null 和结束的 1。
  assert.deepEqual(
    seen.filter((item) => item.state === "running").map((item) => item.progress),
    [null, 0.25, 0.75]
  );
  assert.equal(seen.at(-1).state, "succeeded");
  assert.equal(seen.at(-1).progress, 1);
  assert.equal(registry.listActive().length, 0);
});
