import { describe, it, expect } from "vitest";
import type { Account } from "../ipc/types";
import {
  createInitialAccountsState,
  reconcileAccountsFromBootstrap,
  updateAccountDraft,
  startAccountSubmit,
  finishAccountSubmit,
  handleSingleAccountStatusChanged,
  handleSingleAccountChanged,
  handleSingleAccountRemoved,
  toggleAccountSelection,
  setAccountFilter,
  getFilteredAccounts,
  isAccountDirty,
} from "../state/accountsStore";

function createMockAccount(id: string, overrides?: Partial<Account>): Account {
  return {
    id,
    email: `${id}@example.com`,
    note: `Initial note for ${id}`,
    enabled: true,
    groupId: null,
    groupName: null,
    switchRule: "random",
    minWindows: 1,
    maxWindows: 2,
    status: "needs_login",
    statusCheckedAt: null,
    stale: false,
    exitNode: null,
    exitNodeMissing: false,
    rotationTopic: null,
    rotationDone: 0,
    rotationTarget: 5,
    nextRunAt: null,
    lastRunAt: null,
    lastRunOk: null,
    pageOpen: false,
    ...overrides,
  };
}

describe("UI_BRIEF 第四节：三条必须实现的关键行为（生产实现验证）", () => {
  it("行为 1: 刷新（bootstrap / status 事件）不丢正在编辑的草稿", () => {
    let state = createInitialAccountsState();
    const acc1 = createMockAccount("acc-1", { note: "原始备注", status: "needs_login" });
    const acc2 = createMockAccount("acc-2", { note: "账号2备注", status: "needs_login" });
    state = reconcileAccountsFromBootstrap(state, [acc1, acc2]);

    // 用户修改了 acc-1 的备注和最大窗口数草稿
    state = updateAccountDraft(state, "acc-1", {
      note: "用户正在编辑的新草稿内容",
      maxWindows: 5,
    });

    const item1 = state.accounts["acc-1"];
    expect(item1).toBeDefined();
    expect(item1?.effective.note).toBe("用户正在编辑的新草稿内容");
    expect(item1?.effective.maxWindows).toBe(5);
    expect(isAccountDirty(item1!)).toBe(true);
    expect(isAccountDirty(item1!, "note")).toBe(true);
    expect(isAccountDirty(item1!, "groupId")).toBe(false);

    // 此时后台推送了一次全量 bootstrap 快照（服务端基线仍是旧备注，但巡检状态已变为 ok，且更新了 nextRunAt）
    const serverSnapshot = [
      createMockAccount("acc-1", {
        note: "原始备注",
        status: "ok",
        nextRunAt: "2026-08-28T10:00:00Z",
      }),
      createMockAccount("acc-2", {
        note: "账号2新服务端备注",
        status: "ok",
      }),
    ];
    state = reconcileAccountsFromBootstrap(state, serverSnapshot);

    const updatedItem1 = state.accounts["acc-1"];
    const updatedItem2 = state.accounts["acc-2"];

    // 断言：acc-1 的用户编辑草稿（note、maxWindows）被完整保留
    expect(updatedItem1?.effective.note).toBe("用户正在编辑的新草稿内容");
    expect(updatedItem1?.effective.maxWindows).toBe(5);
    // 断言：acc-1 未被草稿覆盖的字段（status、nextRunAt）顺利跟随服务端更新
    expect(updatedItem1?.effective.status).toBe("ok");
    expect(updatedItem1?.effective.nextRunAt).toBe("2026-08-28T10:00:00Z");
    // 断言：acc-2 未被用户编辑，完全跟随服务端更新
    expect(updatedItem2?.effective.note).toBe("账号2新服务端备注");
    expect(updatedItem2?.effective.status).toBe("ok");
  });

  it("行为 2: 提交期间继续编辑不丢新值（三路合并）", () => {
    let state = createInitialAccountsState();
    const acc1 = createMockAccount("acc-1", { note: "初始值" });
    state = reconcileAccountsFromBootstrap(state, [acc1]);

    // 1. 用户将备注改为了 A
    state = updateAccountDraft(state, "acc-1", { note: "值A" });
    expect(state.accounts["acc-1"]?.effective.note).toBe("值A");

    // 2. 发起提交：标记提交在途
    state = startAccountSubmit(state, "acc-1", { note: "值A" });
    expect(state.accounts["acc-1"]?.submitting?.note).toBe("值A");

    // 3. 在请求未返回前，用户又将备注改为了 B
    state = updateAccountDraft(state, "acc-1", { note: "值B" });
    expect(state.accounts["acc-1"]?.effective.note).toBe("值B");

    // 4. 提交响应到达，服务端确认接收了值 A
    state = finishAccountSubmit(state, "acc-1", { note: "值A" }, {
      ...acc1,
      note: "值A",
    });

    const itemAfterSubmit = state.accounts["acc-1"]!;
    // 断言：界面仍保持用户最新的值 B
    expect(itemAfterSubmit.effective.note).toBe("值B");
    // 断言：基线已更新为 A
    expect(itemAfterSubmit.baseline.note).toBe("值A");
    // 断言：草稿针对新基线 A 依然标记为脏
    expect(isAccountDirty(itemAfterSubmit, "note")).toBe(true);
    // 断言：在途提交标记已清空
    expect(itemAfterSubmit.submitting).toBeNull();
  });

  it("行为 3: 增量事件不破坏筛选与勾选状态，且正确重新应用筛选条件", () => {
    let state = createInitialAccountsState();
    const acc1 = createMockAccount("acc-1", { status: "needs_login" });
    const acc2 = createMockAccount("acc-2", { status: "needs_login" });
    const acc3 = createMockAccount("acc-3", { status: "needs_login" });
    state = reconcileAccountsFromBootstrap(state, [acc1, acc2, acc3]);

    // 用户勾选了 acc-1 和 acc-2
    state = toggleAccountSelection(state, "acc-1");
    state = toggleAccountSelection(state, "acc-2");
    expect(state.selectedIds.has("acc-1")).toBe(true);
    expect(state.selectedIds.has("acc-2")).toBe(true);
    expect(state.selectedIds.has("acc-3")).toBe(false);

    // 用户设置了筛选条件：只看 "needs_login"
    state = setAccountFilter(state, { status: "needs_login" });
    let visible = getFilteredAccounts(state);
    expect(visible.map((v) => v.effective.id)).toEqual(["acc-1", "acc-2", "acc-3"]);

    // 此时后台发来 acc-1 的状态变更增量事件：状态变为 ok
    state = handleSingleAccountStatusChanged(state, {
      id: "acc-1",
      status: "ok",
    });

    // 断言 1：原有选中状态不被破坏（选中的集合依然包含 acc-1 和 acc-2）
    expect(state.selectedIds.has("acc-1")).toBe(true);
    expect(state.selectedIds.has("acc-2")).toBe(true);

    // 断言 2：React 使用稳定 key={account.id}，acc-2 和 acc-3 的对象引用不应被全表替换破坏
    // 断言 3：重新计算筛选后，acc-1 由于状态变为 ok，自动从 "needs_login" 筛选列表中消失
    visible = getFilteredAccounts(state);
    expect(visible.map((v) => v.effective.id)).toEqual(["acc-2", "acc-3"]);

    // 当筛选切回 "all" 时，acc-1 依然存在且状态为 ok
    state = setAccountFilter(state, { status: "all" });
    visible = getFilteredAccounts(state);
    expect(visible.map((v) => v.effective.id)).toEqual(["acc-1", "acc-2", "acc-3"]);
    expect(state.accounts["acc-1"]?.effective.status).toBe("ok");
  });

  it("辅助测试：账号删除与单卡片增量更新", () => {
    let state = createInitialAccountsState();
    const acc1 = createMockAccount("acc-1", { note: "Acc 1" });
    const acc2 = createMockAccount("acc-2", { note: "Acc 2" });
    state = reconcileAccountsFromBootstrap(state, [acc1, acc2]);
    state = toggleAccountSelection(state, "acc-1");

    // 增量更新 acc-2
    const updatedAcc2 = { ...acc2, note: "Acc 2 Updated" };
    state = handleSingleAccountChanged(state, updatedAcc2);
    expect(state.accounts["acc-2"]?.effective.note).toBe("Acc 2 Updated");
    expect(state.selectedIds.has("acc-1")).toBe(true);

    // 移除 acc-1
    state = handleSingleAccountRemoved(state, "acc-1");
    expect(state.accounts["acc-1"]).toBeUndefined();
    expect(state.accountIds).toEqual(["acc-2"]);
    expect(state.selectedIds.has("acc-1")).toBe(false);
  });
});
