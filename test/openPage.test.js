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

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("打开网页只直连 GCash 必需的静态脚本域名", () => {
  assert.deepEqual(OPEN_PAGE_PROXY_BYPASS, ["gw.alipayobjects.com"]);
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
