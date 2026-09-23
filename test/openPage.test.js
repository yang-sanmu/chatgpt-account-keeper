import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isHeld } from "../src/locks.js";
import {
  closePageForAccount,
  getOpenPages,
  isPageOpen,
  OPEN_PAGE_PROXY_BYPASS,
  openPageForAccount,
  sampleOpenPageSession,
  subscribeOpenPageStatus,
} from "../src/openPage.js";
import { withAccountLock } from "../src/locks.js";

class FakeContext extends EventEmitter {
  constructor(page) {
    super();
    this.page = page;
    this.closed = false;
  }

  pages() {
    return this.closed ? [] : [this.page];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

test("开窗完成登录会回填邮箱并推送，跳过空白首标签页", async (t) => {
  const account = { id: "manual-login", email: null, gptName: null };
  const blank = { url: () => "about:blank" };
  const page = { url: () => "https://chatgpt.com/c/test" };
  const session = { page: blank, context: { pages: () => [blank, page] } };
  const cached = [];
  const changes = [];
  const updates = [];
  t.after(subscribeOpenPageStatus((event) => changes.push(event)));
  const runtime = {
    getAccount: () => account,
    checkSession: async (target) => {
      assert.equal(target, page);
      return { state: "ok", email: "manual@example.com", name: "Manual", detail: null };
    },
    updateAccount: (id, patch) => { updates.push({ id, patch }); Object.assign(account, patch); },
    setCachedStatus: (...args) => cached.push(args),
  };
  await sampleOpenPageSession(account, session, runtime);
  await sampleOpenPageSession(account, session, runtime);
  assert.equal(updates.length, 1, "身份不变时不重复写账号资料");
  assert.equal(account.email, "manual@example.com");
  assert.equal(account.gptName, "Manual");
  assert.deepEqual(cached[0], [account.id, "ok", "manual@example.com", null]);
  assert.equal(changes.length, 2);
});

for (const state of ["out", "reauth", "unknown"]) {
  test(`开窗采样 ${state} 不覆盖账号身份`, async () => {
    const account = { id: "manual-existing", email: "saved@example.com" };
    const page = { url: () => "https://chatgpt.com/" };
    await sampleOpenPageSession(account, { page, context: { pages: () => [page] } }, {
      getAccount: () => account,
      checkSession: async () => ({ state, email: "unverified@example.com" }),
      updateAccount: () => assert.fail("不可覆盖身份"),
      setCachedStatus: (_id, actual) => assert.equal(actual, state),
    });
  });
}

test("开窗探测期间关闭窗口会丢弃迟到结果", async () => {
  const page = { url: () => "https://chatgpt.com/" };
  let pages = [page];
  await sampleOpenPageSession({ id: "closed" }, { page, context: { pages: () => pages } }, {
    checkSession: async () => { pages = []; return { state: "ok", email: "late@example.com" }; },
    updateAccount: () => assert.fail("不可写入迟到身份"),
    setCachedStatus: () => assert.fail("不可写入迟到状态"),
  });
});

test("打开已有会话立即采样，不必等待首个十秒周期", async (t) => {
  const account = { id: "open-page-immediate", email: null };
  const page = { goto: async () => {}, url: () => "https://chatgpt.com/" };
  const context = new FakeContext(page);
  t.after(() => closePageForAccount(account.id));
  const observations = [];
  const result = await openPageForAccount(account, null, {
    launchForAccount: async () => ({ context, page }),
    getAccount: () => account,
    checkSession: async () => ({ state: "ok", email: "existing@example.com", name: "Existing" }),
    updateAccount: (_id, patch) => Object.assign(account, patch),
    setCachedStatus: (...args) => observations.push(args),
  });
  assert.equal(result.ok, true);
  await waitUntil(() => observations.length > 0);
  assert.equal(observations[0][1], "ok");
  assert.equal(account.email, "existing@example.com");
  assert.equal(context.closed, false);
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("打开网页只直连已确认受境外节点阻断的付款依赖域名", () => {
  assert.deepEqual(OPEN_PAGE_PROXY_BYPASS, [
    "gw.alipayobjects.com",
    "sv.creditcard.ecitic.com",
  ]);
});

test("手动关窗后立即清除打开状态并释放账号占用", async (t) => {
  const account = {
    id: `open-page-close-${Date.now()}`,
    profileDir: "profiles/__open_page_close_test__",
  };
  const page = {
    goto: async () => {},
    url: () => "https://example.com/",
  };
  const context = new FakeContext(page);
  let launchOptions;
  t.after(() => context.close());

  const result = await openPageForAccount(account, "https://example.com/", {
    launchForAccount: async (_account, options) => {
      launchOptions = options;
      return { context, page };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(launchOptions, {
    headless: false,
    proxyBypass: OPEN_PAGE_PROXY_BYPASS,
  });
  assert.equal(isPageOpen(account.id), true);
  assert.equal(isHeld(account.id), true);

  await context.close();
  await waitUntil(() => !isPageOpen(account.id));

  assert.equal(isPageOpen(account.id), false);
  assert.equal(isHeld(account.id), false);
});

test("手动打开会结束同账号 Headless 任务且排队阶段不冒充已打开", async (t) => {
  const account = {
    id: `open-page-preempt-${Date.now()}`,
    profileDir: "profiles/__open_page_preempt_test__",
  };
  let releaseBusy;
  let reportBusyStarted;
  const busyStarted = new Promise((resolve) => {
    reportBusyStarted = resolve;
  });
  const busy = withAccountLock(account.id, async () => {
    reportBusyStarted();
    await new Promise((resolve) => {
      releaseBusy = resolve;
    });
  });
  await busyStarted;

  let continueInterrupt;
  let reportInterruptStarted;
  const interruptStarted = new Promise((resolve) => {
    reportInterruptStarted = resolve;
  });
  const page = {
    goto: async () => {},
    bringToFront: async () => {},
    url: () => "https://example.com/",
  };
  const context = new FakeContext(page);
  t.after(() => context.close());

  const opening = openPageForAccount(account, "https://example.com/", {
    closeHeadlessBrowserContextsForAccount: async () => {
      reportInterruptStarted();
      await new Promise((resolve) => {
        continueInterrupt = resolve;
      });
      releaseBusy();
      return 1;
    },
    launchForAccount: async () => ({ context, page }),
  });

  await interruptStarted;
  assert.equal(isPageOpen(account.id), false);
  assert.equal(getOpenPages()[account.id], undefined);

  continueInterrupt();
  const result = await opening;
  await busy;
  assert.equal(result.ok, true);
  assert.equal(isPageOpen(account.id), true);
  assert.equal(getOpenPages()[account.id].url, "https://example.com/");
});

test("非 Headless 操作占用账号时立即失败且不会留下假打开状态", async () => {
  const account = {
    id: `open-page-busy-${Date.now()}`,
    profileDir: "profiles/__open_page_busy_test__",
  };
  let releaseBusy;
  let reportBusyStarted;
  const busyStarted = new Promise((resolve) => {
    reportBusyStarted = resolve;
  });
  const busy = withAccountLock(account.id, async () => {
    reportBusyStarted();
    await new Promise((resolve) => {
      releaseBusy = resolve;
    });
  });
  await busyStarted;

  const result = await openPageForAccount(account, "https://example.com/", {
    closeHeadlessBrowserContextsForAccount: async () => 0,
    launchForAccount: async () => {
      throw new Error("不应启动第二个 Profile");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESOURCE_BUSY");
  assert.equal(isPageOpen(account.id), false);
  assert.equal(getOpenPages()[account.id], undefined);
  assert.equal(isHeld(account.id), false);

  releaseBusy();
  await busy;
});

test("重复点击会激活同一个 Chrome 窗口而不是返回已打开错误", async (t) => {
  const account = {
    id: `open-page-focus-${Date.now()}`,
    profileDir: "profiles/__open_page_focus_test__",
  };
  let launchCount = 0;
  let focusCount = 0;
  const page = {
    goto: async () => {},
    bringToFront: async () => {
      focusCount += 1;
    },
    url: () => "https://example.com/",
  };
  const context = new FakeContext(page);
  t.after(() => context.close());
  const runtime = {
    closeHeadlessBrowserContextsForAccount: async () => 0,
    launchForAccount: async () => {
      launchCount += 1;
      return { context, page };
    },
  };

  const first = await openPageForAccount(account, "https://example.com/", runtime);
  const second = await openPageForAccount(account, "https://example.com/", runtime);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.message, "已切换到现有 Chrome 窗口");
  assert.equal(launchCount, 1);
  assert.equal(focusCount, 2);
});

test("Chrome 启动过程中关闭请求不会在稍后补弹窗口", async () => {
  const account = {
    id: `open-page-cancel-${Date.now()}`,
    profileDir: "profiles/__open_page_cancel_test__",
  };
  let finishLaunch;
  let reportLaunchStarted;
  const launchStarted = new Promise((resolve) => {
    reportLaunchStarted = resolve;
  });
  let gotoCount = 0;
  const page = {
    goto: async () => {
      gotoCount += 1;
    },
    bringToFront: async () => {},
    url: () => "about:blank",
  };
  const context = new FakeContext(page);
  const opening = openPageForAccount(account, "https://example.com/", {
    closeHeadlessBrowserContextsForAccount: async () => 0,
    launchForAccount: async () => {
      reportLaunchStarted();
      await new Promise((resolve) => {
        finishLaunch = resolve;
      });
      return { context, page };
    },
  });

  await launchStarted;
  assert.equal(await closePageForAccount(account.id), true);
  finishLaunch();
  const result = await opening;
  await waitUntil(() => context.closed);

  assert.equal(result.ok, false);
  assert.equal(result.code, "OPEN_PAGE_CANCELLED");
  assert.equal(context.closed, true);
  assert.equal(gotoCount, 0);
  assert.equal(isPageOpen(account.id), false);
});
