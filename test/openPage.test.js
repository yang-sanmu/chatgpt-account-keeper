import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isHeld } from "../src/locks.js";
import { isPageOpen, openPageForAccount } from "../src/openPage.js";

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
  t.after(() => context.close());

  const result = await openPageForAccount(account, "https://example.com/", {
    launchForAccount: async () => ({ context, page }),
  });

  assert.equal(result.ok, true);
  assert.equal(isPageOpen(account.id), true);
  assert.equal(isHeld(account.id), true);

  await context.close();
  await waitUntil(() => !isPageOpen(account.id));

  assert.equal(isPageOpen(account.id), false);
  assert.equal(isHeld(account.id), false);
});
