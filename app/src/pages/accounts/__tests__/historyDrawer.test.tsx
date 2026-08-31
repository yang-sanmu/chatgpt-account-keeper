// 账号卡片的「历史」按钮开抽屉，不跳页。
//
// 这条钉的是入口语义：在账号页看一眼某个账号的记录，不该把用户从当前页面（连同筛选与勾选）
// 赶到另一个页面去。回归的表现是点一下按钮整页换掉，功能上「能看到历史」所以容易被放过。

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { useAccountActions } from "@/store/selectors";

const store = () => useKeeperStore.getState();

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await store().bootstrapApp();
  tauri.emitBootstrap(
    makeBootstrap({ accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })] })
  );
  store().setNav("accounts");
});

describe("历史抽屉", () => {
  it("打开抽屉不改变当前页面", () => {
    store().openHistoryDrawer("acc-1");

    expect(store().historyDrawerAccountId).toBe("acc-1");
    expect(store().nav).toBe("accounts");
  });

  it("抽屉与历史页的选中项互不影响", () => {
    // 两个字段刻意分开：合成一个会让「在账号页看一眼」把历史页的选中项也换掉，
    // 用户下次进历史页时看到的不是他上次留下的那个账号。
    store().openHistoryFor("acc-2");
    expect(store().nav).toBe("history");
    expect(store().historyFocusAccountId).toBe("acc-2");

    store().setNav("accounts");
    store().openHistoryDrawer("acc-1");

    expect(store().historyDrawerAccountId).toBe("acc-1");
    expect(store().historyFocusAccountId).toBe("acc-2");
  });

  it("关闭抽屉只清抽屉状态", () => {
    store().openHistoryDrawer("acc-1");
    store().closeHistoryDrawer();

    expect(store().historyDrawerAccountId).toBeNull();
    expect(store().nav).toBe("accounts");
  });

  it("卡片拿到的 openHistory 开的是抽屉，不是跳转", () => {
    // 关键在于验证**卡片实际调用的那个回调**，而不是直接调 openHistoryDrawer ——
    // 后者无论 useAccountActions 绑到哪个动作都会通过，等于什么都没测。
    const { result } = renderHook(() => useAccountActions());

    result.current.openHistory("acc-2");

    expect(store().historyDrawerAccountId).toBe("acc-2");
    expect(store().nav, "点历史按钮不该把用户从账号页赶走").toBe("accounts");
  });
});
