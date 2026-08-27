// 邮箱的「全部隐藏 / 全部展示」开关。
//
// 这是一个用户明确要求的功能，且默认必须是**全部隐藏**：账号页会被截图和录屏，邮箱是这一屏
// 里唯一的真实个人信息。默认值写错不会有任何报错，只会静默泄露，所以钉在这里。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { displayEmail } from "@/lib/format";

const store = () => useKeeperStore.getState();

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await store().bootstrapApp();
  tauri.emitBootstrap(
    makeBootstrap({
      accounts: [
        makeAccount({ id: "acc-1", email: "basketball7@icloud.com" }),
        makeAccount({ id: "acc-2", email: null }),
      ],
    })
  );
});

describe("邮箱显示开关", () => {
  it("默认全部隐藏", () => {
    expect(store().emailsRevealed).toBe(false);
  });

  it("开关切换后所有账号一起变，不是逐个记状态", () => {
    const emails = () =>
      store().accountIds.map((id) =>
        displayEmail(store().accounts[id]?.effective.email, store().emailsRevealed)
      );

    expect(emails()).toEqual(["ba***7@i***d.com", "未登录"]);

    store().setEmailsRevealed(true);
    expect(emails()).toEqual(["basketball7@icloud.com", "未登录"]);

    store().setEmailsRevealed(false);
    expect(emails()).toEqual(["ba***7@i***d.com", "未登录"]);
  });

  it("开关状态不会被全量快照重置", () => {
    store().setEmailsRevealed(true);

    // 巡检推来一份新快照。这只应该更新账号数据，不该把用户刚打开的显示开关关掉。
    tauri.emitBootstrap(
      makeBootstrap({ accounts: [makeAccount({ id: "acc-1", email: "a@b.com" })] })
    );

    expect(store().emailsRevealed).toBe(true);
  });

  it("未登录账号在两种模式下都显示未登录，不泄露空值形态", () => {
    expect(displayEmail(null, false)).toBe("未登录");
    expect(displayEmail(null, true)).toBe("未登录");
    expect(displayEmail("", true)).toBe("未登录");
  });
});
