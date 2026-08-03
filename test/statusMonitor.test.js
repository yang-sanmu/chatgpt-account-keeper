import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markHeld, releaseHeld, withAccountLock } from "../src/locks.js";

const statusCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-status-cache-"));
const statusCacheFile = path.join(statusCacheDir, "status-cache.json");
const statusCacheEnv = "CHATGPT_ACCOUNT_KEEPER_STATUS_CACHE_FILE";
const previousStatusCacheFile = process.env[statusCacheEnv];
process.env[statusCacheEnv] = statusCacheFile;

const {
  createSingleFlight,
  deleteCachedStatus,
  getCachedStatus,
  mergeStatusObservation,
  refreshAccount,
  setCachedStatus,
  shouldRunImmediateCheck,
} = await import("../src/statusMonitor.js");
const { readPersistedStatuses, writePersistedStatuses } = await import(
  "../src/statusCacheStore.js"
);

after(() => {
  if (previousStatusCacheFile === undefined) delete process.env[statusCacheEnv];
  else process.env[statusCacheEnv] = previousStatusCacheFile;
  fs.rmSync(statusCacheDir, { recursive: true, force: true });
});

test("startup check setting only triggers an immediate check on process startup", () => {
  assert.equal(shouldRunImmediateCheck({ statusCheckOnStartup: true }, true), true);
  assert.equal(shouldRunImmediateCheck({ statusCheckOnStartup: false }, true), false);
  assert.equal(shouldRunImmediateCheck({ statusCheckOnStartup: "false" }, true), false);
  assert.equal(shouldRunImmediateCheck({ statusCheckOnStartup: true }, false), false);
  // 旧配置没有该字段时保持原来的启动即巡检行为。
  assert.equal(shouldRunImmediateCheck({}, true), true);
});

test("refreshAccount returns cached state immediately for a manually held account", async () => {
  const accountId = "test_held_account";
  setCachedStatus(accountId, "ok", "held@example.com");
  markHeld(accountId);

  try {
    const startedAt = Date.now();
    const result = await refreshAccount({ id: accountId });

    assert.equal(result.skipped, true);
    assert.equal(result.skipKind, "held");
    assert.match(result.skipReason, /窗口正在使用/);
    assert.equal(result.state, "ok");
    assert.equal(result.email, "held@example.com");
    assert.ok(Date.now() - startedAt < 100);
  } finally {
    releaseHeld(accountId);
    deleteCachedStatus(accountId);
  }
});

test("refreshAccount 对正在执行其它任务的账号立即返回缓存而不排队", async () => {
  const accountId = "test_busy_account";
  setCachedStatus(accountId, "ok", "busy@example.com");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = withAccountLock(accountId, () => gate);

  try {
    const startedAt = Date.now();
    const result = await refreshAccount({ id: accountId });
    assert.equal(result.skipped, true);
    assert.equal(result.skipKind, "busy");
    assert.equal(result.state, "ok");
    assert.equal(result.email, "busy@example.com");
    assert.match(result.skipReason, /其它任务/);
    assert.ok(Date.now() - startedAt < 100);
  } finally {
    release();
    await running;
    deleteCachedStatus(accountId);
  }
});

test("refreshAccount skips a stale queued account after it has been deleted", async () => {
  const result = await refreshAccount({ id: `missing_${Date.now()}` });

  assert.equal(result.skipped, true);
  assert.equal(result.deleted, true);
  assert.equal(result.state, null);
  assert.equal(result.loggedIn, false);
});

test("一次 unknown 保留上次明确状态并记录最近检查异常", () => {
  const t0 = Date.parse("2026-08-03T00:00:00.000Z");
  const confirmed = mergeStatusObservation(
    null,
    { state: "ok", email: "person@example.com", detail: null },
    { nowMs: t0 }
  );
  const uncertain = mergeStatusObservation(
    confirmed,
    {
      state: "unknown",
      email: "untrusted@example.com",
      detail: "会话接口返回 403",
    },
    { nowMs: t0 + 60_000 }
  );

  assert.equal(uncertain.state, "ok");
  assert.equal(uncertain.loggedIn, true);
  assert.equal(uncertain.email, "person@example.com");
  assert.equal(uncertain.lastCheckState, "unknown");
  assert.equal(uncertain.lastCheckDetail, "会话接口返回 403");
  assert.equal(uncertain.consecutiveUnknowns, 1);
  assert.equal(uncertain.stale, true);
  assert.equal(uncertain.confirmedAt, confirmed.confirmedAt);
});

test("有明确基线后持续 unknown 也只标记待复核，不覆盖有效状态", () => {
  const t0 = Date.parse("2026-08-03T00:00:00.000Z");
  let state = mergeStatusObservation(
    null,
    { state: "ok", email: "person@example.com" },
    { nowMs: t0 }
  );
  state = mergeStatusObservation(
    state,
    { state: "unknown", detail: "temporary" },
    { nowMs: t0 + 60_000 }
  );
  state = mergeStatusObservation(
    state,
    { state: "unknown", detail: "temporary" },
    { nowMs: t0 + 4 * 60_000 }
  );
  assert.equal(state.state, "ok");

  state = mergeStatusObservation(
    state,
    { state: "unknown", detail: "temporary" },
    { nowMs: t0 + 24 * 60 * 60_000 }
  );
  assert.equal(state.state, "ok");
  assert.equal(state.loggedIn, true);
  assert.equal(state.confirmedState, "ok");
  assert.equal(state.stale, true);
  assert.equal(state.consecutiveUnknowns, 3);
});

test("非法或缺失状态按 unknown 处理，不能抹掉明确基线", () => {
  const t0 = Date.parse("2026-08-03T00:00:00.000Z");
  const confirmed = mergeStatusObservation(
    null,
    { state: "ok", email: "person@example.com" },
    { nowMs: t0 }
  );

  for (const invalidState of [undefined, null, "typo", 1, {}]) {
    const result = mergeStatusObservation(
      confirmed,
      { state: invalidState, detail: "invalid probe" },
      { nowMs: t0 + 1_000 }
    );
    assert.equal(result.state, "ok");
    assert.equal(result.loggedIn, true);
    assert.equal(result.confirmedAt, confirmed.confirmedAt);
    assert.equal(result.lastCheckState, "unknown");
    assert.equal(result.stale, true);
  }
});

test("最近明确状态写入磁盘并能由新的模块实例恢复", async () => {
  const accountId = "persisted_status_account";
  const written = setCachedStatus(
    accountId,
    "ok",
    "persisted@example.com",
    null,
    { nowMs: Date.parse("2026-08-03T01:00:00.000Z") }
  );
  assert.equal(fs.existsSync(statusCacheFile), true);

  const restarted = await import(
    `../src/statusMonitor.js?status-cache-restart=${Date.now()}`
  );
  const restored = restarted.getCachedStatus(accountId);
  assert.equal(restored.state, "ok");
  assert.equal(restored.loggedIn, true);
  assert.equal(restored.email, "persisted@example.com");
  assert.equal(restored.confirmedState, "ok");
  assert.equal(restored.confirmedAt, written.confirmedAt);
  assert.equal(restored.lastCheckState, "ok");
  assert.equal(restored.consecutiveUnknowns, 0);
  assert.equal(restored.stale, true);

  restarted.deleteCachedStatus(accountId);
  deleteCachedStatus(accountId);
});

test("状态缓存原子替换、失败清理临时文件且损坏内容安全回退", async () => {
  writePersistedStatuses({ first: { state: "ok" } });
  writePersistedStatuses({ second: { state: "out" } });
  assert.deepEqual(Object.keys(readPersistedStatuses()), ["second"]);
  assert.equal(
    fs.readdirSync(statusCacheDir).some((name) => name.endsWith(".tmp")),
    false
  );

  fs.writeFileSync(statusCacheFile, '{"version":1,"accounts":', "utf8");
  const damaged = await import(
    `../src/statusMonitor.js?damaged-status-cache=${Date.now()}`
  );
  assert.equal(damaged.getCachedStatus("second").state, null);

  const blockedTarget = path.join(statusCacheDir, "blocked-target");
  fs.mkdirSync(blockedTarget);
  process.env[statusCacheEnv] = blockedTarget;
  try {
    assert.throws(() => writePersistedStatuses({ any: {} }));
    assert.equal(
      fs
        .readdirSync(statusCacheDir)
        .some((name) => name.startsWith(".blocked-target.") && name.endsWith(".tmp")),
      false
    );
  } finally {
    process.env[statusCacheEnv] = statusCacheFile;
    fs.rmdirSync(blockedTarget);
  }
  writePersistedStatuses({});
});

test("明确结果立即生效并清除 unknown 迟滞", () => {
  const t0 = Date.parse("2026-08-03T00:00:00.000Z");
  const unknown = mergeStatusObservation(
    null,
    { state: "unknown", detail: "network" },
    { nowMs: t0 }
  );
  assert.equal(unknown.state, "unknown", "没有可信基线时不能伪造已登录");

  const ok = mergeStatusObservation(
    unknown,
    { state: "ok", email: "person@example.com" },
    { nowMs: t0 + 1_000 }
  );
  assert.equal(ok.state, "ok");
  assert.equal(ok.stale, false);
  assert.equal(ok.consecutiveUnknowns, 0);

  const out = mergeStatusObservation(
    ok,
    { state: "out", email: null, detail: "session 无用户信息" },
    { nowMs: t0 + 2_000 }
  );
  assert.equal(out.state, "out");
  assert.equal(out.loggedIn, false);
  assert.equal(out.stale, false);

  const reauth = mergeStatusObservation(
    out,
    { state: "reauth", email: "person@example.com", detail: "token invalid" },
    { nowMs: t0 + 3_000 }
  );
  assert.equal(reauth.state, "reauth");
  assert.equal(reauth.loggedIn, false);
  assert.equal(reauth.lastCheckState, "reauth");
  assert.equal(reauth.stale, false);
});

test("删除状态缓存后不会留下幽灵条目", () => {
  const accountId = "deleted_status_cache";
  setCachedStatus(accountId, "ok", "person@example.com");
  assert.equal(getCachedStatus(accountId).state, "ok");
  assert.equal(deleteCachedStatus(accountId), true);
  assert.equal(getCachedStatus(accountId).state, null);
});

test("巡检 single-flight 不重入，完成或失败后均可再次运行", async () => {
  let calls = 0;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const run = createSingleFlight(async () => {
    calls++;
    await blocker;
    return calls;
  });

  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 0, "任务在微任务中启动");
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);

  await run();
  assert.equal(calls, 2);

  let failures = 0;
  const failing = createSingleFlight(async () => {
    failures++;
    if (failures === 1) throw new Error("boom");
  });
  await assert.rejects(failing(), /boom/);
  await failing();
  assert.equal(failures, 2);
});
