// 账号标签查表。
//
// 任务页、总览的 Chrome 明细、历史侧栏都只拿到账号 id，而 id 对用户没有意义。这个 hook 是
// 那三处共用的回退链，改坏了会让三个页面同时退回显示裸 id。

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "../keeperStore";
import { useAccountLabeler } from "../selectors";

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(
    makeBootstrap({
      accounts: [
        makeAccount({ id: "acc-email", email: "basketball7@icloud.com", note: "" }),
        makeAccount({ id: "acc-note-only", email: null, note: "备用小号" }),
        makeAccount({ id: "acc-bare-4f4a1b2c3d4e", email: null, note: "   " }),
      ],
    })
  );
});

describe("账号标签的回退链", () => {
  it("有邮箱时用邮箱，且跟随脱敏开关", () => {
    const { result } = renderHook(() => useAccountLabeler());

    expect(result.current("acc-email")).toEqual({
      label: "ba***7@i***d.com",
      known: true,
    });

    act(() => {
      useKeeperStore.getState().setEmailsRevealed(true);
    });

    expect(result.current("acc-email").label).toBe("basketball7@icloud.com");
  });

  it("没有邮箱时退到备注", () => {
    const { result } = renderHook(() => useAccountLabeler());
    expect(result.current("acc-note-only")).toEqual({ label: "备用小号", known: true });
  });

  it("邮箱和备注都没有时退到短 id，但仍算已知账号", () => {
    const { result } = renderHook(() => useAccountLabeler());
    const labeled = result.current("acc-bare-4f4a1b2c3d4e");
    expect(labeled.known).toBe(true);
    expect(labeled.label).not.toBe("acc-bare-4f4a1b2c3d4e");
    expect(labeled.label).toContain("…");
  });

  it("只有空白的备注不算备注", () => {
    // 否则卡片上会显示一个看起来是空的标签，用户以为渲染坏了。
    const { result } = renderHook(() => useAccountLabeler());
    expect(result.current("acc-bare-4f4a1b2c3d4e").label).not.toBe("   ");
  });

  it("账号已被删除时标记 known=false，让调用方能说明这是已删除的账号", () => {
    const { result } = renderHook(() => useAccountLabeler());
    const labeled = result.current("acc-long-gone-0123456789");
    expect(labeled.known).toBe(false);
    // 历史记录会引用已删除的账号，这时不能假装那个 id 是个正常账号。
    expect(labeled.label).toContain("…");
  });

  it("空 id 显示占位符而不是空字符串", () => {
    const { result } = renderHook(() => useAccountLabeler());
    expect(result.current(null)).toEqual({ label: "—", known: false });
    expect(result.current(undefined)).toEqual({ label: "—", known: false });
    expect(result.current("")).toEqual({ label: "—", known: false });
  });
});
