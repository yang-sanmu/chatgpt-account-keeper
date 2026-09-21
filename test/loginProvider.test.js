import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { closePageForAccount, getOpenPages, openPageForAccount } from "../src/openPage.js";
import {
  prepareSessionForLogin,
  shouldClearSessionBeforeLogin,
} from "../src/sessionPolicy.js";
import {
  checkLoggedIn,
  getLoginTask,
  pruneLoginTasks,
  startLogin,
} from "../src/loginProvider.js";
import {
  markHeld,
  isBusy,
  isHeld,
  releaseHeld,
  withAccountLock,
} from "../src/locks.js";

async function waitForLogin(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "登录任务未达到预期状态");
}

for (const closeOnSuccess of [false, true]) {
  for (const alreadyLoggedIn of [false, true]) {
    test(`新增登录检查一次优惠并管理窗口：自动关闭=${closeOnSuccess}，已有会话=${alreadyLoggedIn}`, async (t) => {
      const account = { id: `new-login-${closeOnSuccess}-${alreadyLoggedIn}-${Date.now()}` };
      const observations = [];
      const calls = [];
      let focused = false;
      const page = {
        goto: async () => {},
        waitForTimeout: async () => {},
        url: () => "https://chatgpt.com/",
        bringToFront: async () => { focused = true; },
      };
      const context = new EventEmitter();
      let closed = false;
      context.pages = () => closed ? [] : [page];
      context.close = async () => {
        if (closed) return;
        closed = true;
        context.emit("close");
      };
      t.after(async () => {
        await closePageForAccount(account.id);
        await context.close();
      });
      let checks = 0;
      const started = await startLogin(account, { closeOnSuccess, checkPromoOnSuccess: true }, {
        acquireInteractiveChrome: async () => ({
          context, page,
          release: async () => { calls.push("release"); await context.close(); },
        }),
        checkSession: async () => ++checks === 1 && !alreadyLoggedIn
          ? { state: "out", email: null }
          : { state: "ok", email: "new@example.com" },
        checkPromoEligibility: async (currentPage) => {
          assert.equal(currentPage, page);
          assert.equal(closed, false);
          calls.push("promo");
          return { ok: true, eligibility: "half_price" };
        },
        setCachedStatus: (...args) => observations.push(args),
      });
      await waitForLogin(() => getLoginTask(started.taskId)?.status === "success");
      assert.deepEqual(observations.at(-1), [
        account.id, "ok", "new@example.com", null,
        { promo: { ok: true, eligibility: "half_price" } },
      ]);
      assert.equal(closed, closeOnSuccess);
      if (!closeOnSuccess) {
        assert.deepEqual(calls, ["promo"]);
        assert.ok(getOpenPages()[account.id]);
        assert.equal(isHeld(account.id), true);
        assert.equal(isBusy(account.id), true);
        // 任务清理不能遗失仍打开的窗口；打开网页复用同一 Chrome。
        pruneLoginTasks({ now: Date.now() + 3600000, maxTasks: 0 });
        assert.equal((await openPageForAccount(account)).reused, true);
        assert.equal(focused, true);
        if (alreadyLoggedIn) await context.close();
        else assert.equal(await closePageForAccount(account.id), true);
      }
      await waitForLogin(() => !isBusy(account.id));
      assert.deepEqual(calls, ["promo", "release"]);
      assert.equal(isHeld(account.id), false);
      assert.equal(getOpenPages()[account.id], undefined);
      assert.equal(getLoginTask(started.taskId)?.status, "success");
    });
  }
}

test("关闭保留的登录窗口时，账号锁必须等 Chrome 完整回收后才释放", async (t) => {
  const account = { id: `login-delayed-release-${Date.now()}` };
  const page = { goto: async () => {}, url: () => "https://chatgpt.com/" };
  const context = new EventEmitter();
  let closed = false;
  let closeCalls = 0;
  let releaseCalls = 0;
  let finishRelease;
  const releaseGate = new Promise((resolve) => { finishRelease = resolve; });
  context.pages = () => closed ? [] : [page];
  context.close = async () => {
    closeCalls++;
    if (closed) return;
    closed = true;
    context.emit("close");
  };
  t.after(async () => {
    finishRelease();
    await closePageForAccount(account.id);
    await waitForLogin(() => !isBusy(account.id));
  });
  const started = await startLogin(account, { closeOnSuccess: false }, {
    acquireInteractiveChrome: async () => ({
      context, page,
      release: async () => {
        releaseCalls++;
        await context.close();
        await releaseGate;
      },
    }),
    checkSession: async () => ({ state: "ok", email: "new@example.com" }),
    setCachedStatus: () => {},
  });
  await waitForLogin(() => getLoginTask(started.taskId)?.status === "success");
  const closing = closePageForAccount(account.id);
  // 让 close 事件触发的后台 finally 完整执行，但暂不确认进程树回收。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isBusy(account.id), true, "进程树回收完成前不能释放 Profile 锁");
  assert.equal(isHeld(account.id), true);
  assert.equal(closeCalls, 1, "并发回收必须复用同一关闭操作");
  finishRelease();
  await closing;
  await waitForLogin(() => !isBusy(account.id));
  assert.equal(releaseCalls, 1);
  assert.equal(getOpenPages()[account.id], undefined);
});

test("优惠检查中关闭 Chrome 会结束检查并保留登录成功，不登记已关闭的窗口", async (t) => {
  const account = { id: `login-close-promo-${Date.now()}` };
  const observations = [];
  const page = new EventEmitter();
  const context = new EventEmitter();
  let closed = false;
  let evaluating = false;
  page.goto = async () => {};
  page.url = () => "https://chatgpt.com/";
  page.isClosed = () => closed;
  page.evaluate = () => { evaluating = true; return new Promise(() => {}); };
  context.pages = () => closed ? [] : [page];
  context.close = async () => {
    if (closed) return;
    closed = true;
    page.emit("close");
    context.emit("close");
  };
  t.after(() => context.close());
  const started = await startLogin(account, { closeOnSuccess: false, checkPromoOnSuccess: true }, {
    launchForAccount: async () => ({ context, page }),
    checkSession: async () => ({ state: "ok", email: "new@example.com" }),
    setCachedStatus: (...args) => observations.push(args),
  });
  await waitForLogin(() => evaluating);
  await context.close();
  await waitForLogin(() => getLoginTask(started.taskId)?.status === "success" && !isBusy(account.id));
  // 终态文案必须带上失败原因。只说「待复核」既不是结果也不是线索，用户无从判断是
  // 页面关早了、接口不可用还是超时 —— 而这是新建账号后唯一能看到的信息。
  const message = getLoginTask(started.taskId).message;
  assert.match(message, /登录成功/);
  assert.match(message, /页面已关闭/);
  assert.match(observations.at(-1)[4].promo.detail, /页面已关闭/);
  assert.equal(getOpenPages()[account.id], undefined);
  assert.equal(page.listenerCount("close"), 0);
});

test("优惠检查异常不会把成功登录改为失败，并保存待复核观测", async () => {
  const account = { id: `login-promo-failure-${Date.now()}` };
  const observations = [];
  const calls = [];
  const started = await startLogin(account, { closeOnSuccess: true, checkPromoOnSuccess: true }, {
    launchForAccount: async () => ({
      context: { close: async () => { calls.push("close"); } },
      page: { goto: async () => {} },
    }),
    checkSession: async () => ({ state: "ok", email: "new@example.com" }),
    checkPromoEligibility: async () => { calls.push("promo"); throw new Error("offline"); },
    setCachedStatus: (...args) => observations.push(args),
  });
  await waitForLogin(() => getLoginTask(started.taskId)?.status === "success");
  assert.deepEqual(calls, ["promo", "close"]);
  assert.equal(observations.at(-1)[4].promo.ok, false);
  assert.match(observations.at(-1)[4].promo.detail, /offline/);
});

test("只有用户明确强制重登时才允许清 Session", () => {
  assert.equal(shouldClearSessionBeforeLogin({ force: true }), true);
  assert.equal(shouldClearSessionBeforeLogin({ force: false }), false);
  assert.equal(shouldClearSessionBeforeLogin({}), false);
  assert.equal(shouldClearSessionBeforeLogin({ force: 1 }), false);
});

test("强制重登先清理再检查，不先等待旧会话健康检查", async () => {
  const calls = [];
  const current = { state: "out" };
  const result = await prepareSessionForLogin({
    opts: { force: true },
    context: {},
    page: {
      goto: async () => {
        calls.push("goto");
      },
    },
    url: "https://chatgpt.com/",
    clearSession: async () => {
      calls.push("clear");
      return { ok: true, errors: [] };
    },
    checkSession: async () => {
      calls.push("check");
      return current;
    },
  });

  assert.deepEqual(calls, ["clear", "goto", "check"]);
  assert.equal(result.forced, true);
  assert.equal(result.current, current);
});

test("普通登录只检查现有会话且绝不清理", async () => {
  const calls = [];
  await prepareSessionForLogin({
    opts: {},
    context: {},
    page: {},
    url: "https://chatgpt.com/",
    clearSession: async () => {
      calls.push("clear");
      return { ok: true };
    },
    checkSession: async () => {
      calls.push("check");
      return { state: "unknown" };
    },
  });
  assert.deepEqual(calls, ["check"]);
});

test("强制清理失败时停止流程且不能检查或报成功", async () => {
  let checked = false;
  await assert.rejects(
    () =>
      prepareSessionForLogin({
        opts: { force: true },
        context: {},
        page: { goto: async () => {} },
        url: "https://chatgpt.com/",
        clearSession: async () => ({
          ok: false,
          errors: ["Cookie 未清除"],
        }),
        checkSession: async () => {
          checked = true;
          return { state: "ok" };
        },
      }),
    (error) =>
      error.code === "SESSION_CLEAR_FAILED" && /Cookie 未清除/.test(error.message)
  );
  assert.equal(checked, false);
});

test("强清成功先失效缓存，随后导航失败会立即上抛", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      prepareSessionForLogin({
        opts: { force: true },
        context: {},
        page: {
          goto: async () => {
            calls.push("goto");
            throw new Error("network down");
          },
        },
        url: "https://chatgpt.com/",
        clearSession: async (_context, options) => {
          calls.push(`clear:${options.url}`);
          return { ok: true, errors: [] };
        },
        onCleared: async () => {
          calls.push("invalidate-cache");
        },
        checkSession: async () => {
          calls.push("check");
          return { state: "unknown" };
        },
      }),
    /network down/
  );
  assert.deepEqual(calls, [
    "clear:https://chatgpt.com/",
    "invalidate-cache",
    "goto",
  ]);
});

test("强制清理后仍是 ok 时拒绝把旧会话报成登录成功", async () => {
  await assert.rejects(
    () =>
      prepareSessionForLogin({
        opts: { force: true },
        context: {},
        page: { goto: async () => {} },
        url: "https://chatgpt.com/",
        clearSession: async () => ({ ok: true, errors: [] }),
        checkSession: async () => ({
          state: "ok",
          email: "old@example.com",
        }),
      }),
    (error) => error.code === "SESSION_CLEAR_STILL_AUTHENTICATED"
  );
});

test("force 清理成功后立即把旧 OK 缓存改为 OUT", async () => {
  const account = {
    id: `force-cache-${Date.now()}`,
    profileDir: "profiles/__login_force_cache_test__",
    groupId: null,
  };
  const observations = [];
  const operations = [];
  const page = {
    goto: async () => {
      operations.push("goto");
    },
    waitForTimeout: async () => {
      throw new Error("stop after cache assertion");
    },
  };
  const context = { close: async () => {} };
  const runtime = {
    launchForAccount: async () => ({ context, page }),
    clearSession: async () => {
      operations.push("clear");
      return { ok: true, errors: [] };
    },
    checkSession: async () => ({ state: "unknown", email: null, name: null }),
    setCachedStatus: (...args) => observations.push(args),
  };

  const started = await startLogin(account, { force: true }, runtime);
  const deadline = Date.now() + 1_000;
  while (getLoginTask(started.taskId)?.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(observations.length, 1);
  assert.equal(observations[0][0], account.id);
  assert.equal(observations[0][1], "out");
  assert.equal(observations[0][2], null);
  assert.match(observations[0][3], /强制清理旧登录态/);
  assert.equal(getLoginTask(started.taskId).force, true);
  assert.deepEqual(operations.slice(0, 2), ["clear", "goto"]);
});

test("登录成功通过当前 provider 的缓存回调写回 OK", async () => {
  const account = {
    id: `success-cache-${Date.now()}`,
    profileDir: "profiles/__login_success_cache_test__",
    groupId: null,
  };
  const observations = [];
  const page = { goto: async () => {} };
  const context = { close: async () => {} };
  const runtime = {
    launchForAccount: async () => ({ context, page }),
    checkSession: async () => ({
      state: "ok",
      email: "fresh@example.com",
      name: "Fresh",
    }),
    setCachedStatus: (...args) => observations.push(args),
  };

  const started = await startLogin(account, {}, runtime);
  const deadline = Date.now() + 1_000;
  while (getLoginTask(started.taskId)?.status !== "success" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(getLoginTask(started.taskId)?.status, "success");
  assert.deepEqual(observations, [
    [account.id, "ok", "fresh@example.com"],
  ]);
});

test("普通登录 preflight 的明确 REAUTH 会立即更新缓存", async () => {
  const account = {
    id: `reauth-cache-${Date.now()}`,
    profileDir: "profiles/__login_reauth_cache_test__",
    groupId: null,
  };
  const observations = [];
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {
      throw new Error("stop after reauth cache assertion");
    },
  };
  const context = { close: async () => {} };
  const runtime = {
    launchForAccount: async () => ({ context, page }),
    checkSession: async () => ({
      state: "reauth",
      email: "stale@example.com",
      name: "Stale",
      detail: "认证令牌已失效，需重新登录",
    }),
    setCachedStatus: (...args) => observations.push(args),
  };

  const started = await startLogin(account, {}, runtime);
  const deadline = Date.now() + 1_000;
  while (getLoginTask(started.taskId)?.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(observations, [
    [
      account.id,
      "reauth",
      "stale@example.com",
      "认证令牌已失效，需重新登录",
    ],
  ]);
});

test("普通登录 preflight 的 UNKNOWN 会立即把明确缓存标记为待复核", async () => {
  const account = {
    id: `unknown-cache-${Date.now()}`,
    profileDir: "profiles/__login_unknown_cache_test__",
    groupId: null,
  };
  const observations = [];
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {
      throw new Error("stop after unknown cache assertion");
    },
  };
  const context = { close: async () => {} };
  const runtime = {
    launchForAccount: async () => ({ context, page }),
    checkSession: async () => ({
      state: "unknown",
      email: null,
      name: null,
      detail: "会话接口被验证页拦截",
    }),
    setCachedStatus: (...args) => observations.push(args),
  };

  const started = await startLogin(account, {}, runtime);
  const deadline = Date.now() + 1_000;
  while (getLoginTask(started.taskId)?.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(observations, [
    [account.id, "unknown", null, "会话接口被验证页拦截"],
  ]);
});

test("普通登录轮询只在非成功观测发生变化时更新缓存", async () => {
  const account = {
    id: `changing-cache-${Date.now()}`,
    profileDir: "profiles/__login_changing_cache_test__",
    groupId: null,
  };
  const observations = [];
  const healthResults = [
    { state: "out", email: null, detail: "session 无用户信息" },
    { state: "out", email: null, detail: "session 无用户信息" },
    {
      state: "unknown",
      email: null,
      detail: "会话接口返回 503，未能确认登录状态",
    },
  ];
  let checks = 0;
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {
      if (checks >= healthResults.length) throw new Error("stop after transition");
    },
  };
  const context = { close: async () => {} };
  const runtime = {
    launchForAccount: async () => ({ context, page }),
    checkSession: async () =>
      healthResults[Math.min(checks++, healthResults.length - 1)],
    setCachedStatus: (...args) => observations.push(args),
  };

  const started = await startLogin(account, {}, runtime);
  const deadline = Date.now() + 1_000;
  while (getLoginTask(started.taskId)?.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(observations, [
    [account.id, "out", null, "session 无用户信息"],
    [
      account.id,
      "unknown",
      null,
      "会话接口返回 503，未能确认登录状态",
    ],
  ]);
});

test("同账号重复发起登录时返回正在运行的同一任务", async () => {
  const account = {
    id: `dedupe-${Date.now()}`,
    profileDir: "profiles/__login_dedupe_test__",
    groupId: null,
  };
  let rejectLaunch;
  const launchGate = new Promise((_, reject) => {
    rejectLaunch = reject;
  });
  const runtime = { launchForAccount: () => launchGate };

  const firstPending = startLogin(account, {}, runtime);
  const secondPending = startLogin(account, {}, runtime);
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.reused, true);
  assert.equal(second.force, false);
  assert.equal(getLoginTask(first.taskId).force, false);

  rejectLaunch(new Error("test cleanup"));
  const deadline = Date.now() + 1_000;
  while (getLoginTask(first.taskId)?.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getLoginTask(first.taskId)?.status, "failed");
});

test("普通登录进行中收到 force 时返回明确冲突且不执行第二次启动", async () => {
  const account = {
    id: `force-conflict-${Date.now()}`,
    profileDir: "profiles/__login_force_conflict_test__",
    groupId: null,
  };
  let rejectLaunch;
  let launchCount = 0;
  const launchGate = new Promise((_, reject) => {
    rejectLaunch = reject;
  });
  const runtime = {
    launchForAccount: () => {
      launchCount++;
      return launchGate;
    },
  };

  const ordinaryPending = startLogin(account, {}, runtime);
  const forcePending = startLogin(account, { force: true }, runtime);
  const [ordinary, forced] = await Promise.all([
    ordinaryPending,
    forcePending,
  ]);

  assert.notEqual(forced.taskId, ordinary.taskId);
  assert.equal(forced.status, "failed");
  assert.equal(forced.code, "LOGIN_FORCE_CONFLICT");
  assert.equal(forced.conflictTaskId, ordinary.taskId);
  assert.equal(forced.force, true);
  assert.match(forced.message, /强制重登尚未执行/);

  const publicTask = getLoginTask(forced.taskId);
  assert.equal(publicTask.code, "LOGIN_FORCE_CONFLICT");
  assert.equal(publicTask.conflictTaskId, ordinary.taskId);
  assert.equal(publicTask.force, true);
  assert.match(publicTask.message, /强制重登尚未执行/);
  assert.equal(launchCount, 1, "冲突的 force 请求不得排队启动第二个窗口");

  rejectLaunch(new Error("test cleanup"));
  const deadline = Date.now() + 1_000;
  while (
    getLoginTask(ordinary.taskId)?.status !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getLoginTask(ordinary.taskId)?.status, "failed");
});

test("已有 force 登录任务可被后续普通或 force 请求安全复用", async () => {
  const account = {
    id: `force-reuse-${Date.now()}`,
    profileDir: "profiles/__login_force_reuse_test__",
    groupId: null,
  };
  let rejectLaunch;
  let launchCount = 0;
  const launchGate = new Promise((_, reject) => {
    rejectLaunch = reject;
  });
  const runtime = {
    launchForAccount: () => {
      launchCount++;
      return launchGate;
    },
  };

  const forcePending = startLogin(account, { force: true }, runtime);
  const ordinaryPending = startLogin(account, {}, runtime);
  const sameForcePending = startLogin(account, { force: true }, runtime);
  const [forced, ordinary, sameForce] = await Promise.all([
    forcePending,
    ordinaryPending,
    sameForcePending,
  ]);

  assert.equal(ordinary.taskId, forced.taskId);
  assert.equal(sameForce.taskId, forced.taskId);
  assert.equal(ordinary.reused, true);
  assert.equal(sameForce.reused, true);
  assert.equal(ordinary.force, true);
  assert.equal(sameForce.force, true);
  assert.equal(getLoginTask(forced.taskId).force, true);
  assert.equal(launchCount, 1);

  rejectLaunch(new Error("test cleanup"));
  const deadline = Date.now() + 1_000;
  while (
    getLoginTask(forced.taskId)?.status !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getLoginTask(forced.taskId)?.status, "failed");
});

test("账号被长期窗口或其它浏览器操作占用时登录快速失败", async () => {
  const heldId = `held-${Date.now()}`;
  markHeld(heldId);
  try {
    const result = await startLogin({ id: heldId });
    assert.equal(result.status, "failed");
    assert.match(getLoginTask(result.taskId).message, /网页窗口仍在使用/);
  } finally {
    releaseHeld(heldId);
  }

  const busyId = `busy-${Date.now()}`;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = withAccountLock(busyId, () => gate);
  try {
    const result = await startLogin({ id: busyId });
    assert.equal(result.status, "failed");
    assert.match(getLoginTask(result.taskId).message, /其它浏览器操作/);
  } finally {
    release();
    await running;
  }
});

test("状态检查仅在 SESSION_OK 时持久化已验证邮箱", async () => {
  const account = {
    id: `checked-email-${Date.now()}`,
    profileDir: "profiles/__checked_email_test__",
  };
  const updates = [];
  let promoChecks = 0;
  const context = { close: async () => {} };
  const page = { goto: async () => {} };
  const baseRuntime = {
    getSettings: () => ({ promoCheckEnabled: true }),
    getAccount: () => account,
    launchForAccount: async () => ({ context, page }),
    updateAccount: (...args) => updates.push(args),
    checkPromoEligibility: async () => {
      promoChecks++;
      return { ok: true, eligibility: "free_trial" };
    },
  };

  const unknown = await checkLoggedIn(account, {
    ...baseRuntime,
    checkSession: async () => ({
      state: "unknown",
      email: "unverified@example.com",
      name: "Unverified",
      detail: "WAF",
    }),
  });
  assert.equal(unknown.state, "unknown");
  assert.equal(promoChecks, 0, "会话未确认时不应请求优惠接口");
  assert.deepEqual(updates, []);

  const ok = await checkLoggedIn(account, {
    ...baseRuntime,
    checkSession: async () => ({
      state: "ok",
      email: "verified@example.com",
      name: "Verified",
      detail: null,
    }),
  });
  assert.equal(ok.state, "ok");
  assert.deepEqual(ok.promo, { ok: true, eligibility: "free_trial" });
  assert.equal(promoChecks, 1);
  assert.deepEqual(updates, [
    [
      account.id,
      { email: "verified@example.com", gptName: "Verified" },
    ],
  ]);
});

test("已结束登录任务按 TTL 和容量有界清理", async () => {
  const ids = [];
  for (let index = 0; index < 5; index++) {
    const accountId = `prune-${Date.now()}-${index}`;
    markHeld(accountId);
    try {
      const result = await startLogin({ id: accountId });
      ids.push(result.taskId);
    } finally {
      releaseHeld(accountId);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  pruneLoginTasks({
    now: Date.now(),
    retentionMs: Number.MAX_SAFE_INTEGER,
    maxTasks: 2,
  });
  assert.ok(
    ids.filter((taskId) => getLoginTask(taskId)).length <= 2,
    "容量清理后至多保留两个新任务"
  );
  assert.ok(getLoginTask(ids.at(-1)), "最新结束的任务应优先保留");

  pruneLoginTasks({
    now: Date.now() + 1,
    retentionMs: 0,
    maxTasks: 200,
  });
  assert.equal(getLoginTask(ids.at(-1)), null, "超过 TTL 的终态任务应删除");
});


test("promo requests are opt-in even for a healthy session", async () => {
  for (const settings of [{}, { promoCheckEnabled: false }]) {
    const result = await checkLoggedIn({ id: "a" }, {
      getAccount: () => ({ id: "a" }), getSettings: () => settings,
      page: { goto: async () => {} }, updateAccount() {},
      checkSession: async () => ({ state: "ok", email: null }),
      checkPromoEligibility: () => assert.fail("disabled promo probe must not run"),
    });
    assert.equal(result.state, "ok");
    assert.equal(result.promo, undefined);
  }
});

// 优惠检查要几秒，期间任务状态必须与"正在登录"可区分。Agent 把除 waiting 之外的阶段
// 都发成 state=running，前端只能靠 stage 说出真实阶段；沿用 saving 的话标题会一直停在
// "正在登录"，用户以为登录卡住了 —— 其实账号早就登进去了。
test("优惠检查期间任务处于独立的 promo 阶段", async () => {
  const account = { id: `login-promo-stage-${Date.now()}` };
  const seen = [];
  let releasePromo;
  const promoGate = new Promise((resolve) => { releasePromo = resolve; });
  const started = await startLogin(account, { closeOnSuccess: true, checkPromoOnSuccess: true }, {
    launchForAccount: async () => ({
      context: { close: async () => {} },
      page: { goto: async () => {}, waitForTimeout: async () => {} },
    }),
    checkSession: async () => ({ state: "ok", email: "new@example.com" }),
    checkPromoEligibility: async () => {
      seen.push(getLoginTask(started.taskId).status);
      await promoGate;
      return { ok: true, eligibility: "half_price" };
    },
    setCachedStatus: () => {},
  });
  await waitForLogin(() => seen.length === 1);
  assert.deepEqual(seen, ["promo"], "优惠检查期间不能复用 saving 阶段");
  releasePromo();
  await waitForLogin(() => getLoginTask(started.taskId)?.status === "success");
});

// 登录等待循环每轮只探一次会话。内层默认 3 次重试（间隔 1.5 秒）在这里是重复的：
// 用户登录完成后要等当轮重试走完才被发现，看起来就是"登录完了还卡在正在登录"。
test("登录等待轮询每轮只做一次会话探测", async () => {
  const account = { id: `login-poll-attempts-${Date.now()}` };
  const optionsSeen = [];
  let checks = 0;
  const started = await startLogin(account, { closeOnSuccess: true }, {
    launchForAccount: async () => ({
      context: { close: async () => {} },
      page: { goto: async () => {}, waitForTimeout: async () => {} },
    }),
    checkSession: async (_page, options) => {
      checks++;
      // 第一次是 preflight（导航后立即检查，应保留默认重试）；之后才是等待轮询。
      if (checks > 1) optionsSeen.push(options);
      return checks < 3 ? { state: "out", email: null } : { state: "ok", email: "new@example.com" };
    },
    setCachedStatus: () => {},
  });
  await waitForLogin(() => getLoginTask(started.taskId)?.status === "success");
  assert.ok(optionsSeen.length > 0, "等待轮询至少探测一次");
  for (const options of optionsSeen) {
    assert.equal(options?.attempts, 1);
  }
});

