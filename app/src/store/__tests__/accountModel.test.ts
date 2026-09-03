// 账号编辑模型的三条规则。
//
// 每条都对应一个已经发生过的用户可见缺陷，所以断言写的是**用户能看到什么**，
// 而不是内部字段长什么样。三条规则的实现都在 accountModel.ts。

import { describe, expect, it } from "vitest";
import type { Account } from "@/ipc/types";
import {
  applyAccountChanged,
  applyAccountRemoved,
  applyAccountStatus,
  applyDraft,
  beginSubmit,
  DEFAULT_ACCOUNT_FILTER,
  discardDraft,
  failSubmit,
  finishSubmit,
  isAccountDirty,
  makeAccountRecord,
  reconcileFromSnapshot,
  selectVisibleAccounts,
  type AccountRecords,
} from "../accountModel";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    email: "user@example.com",
    note: "原始备注",
    enabled: true,
    groupId: null,
    groupName: null,
    switchRule: "random",
    minWindows: 1,
    maxWindows: 3,
    status: "ok",
    statusCheckedAt: "2026-08-27T00:00:00Z",
    stale: false,
    promoEligibility: null,
    promoCheckedAt: null,
    promoStale: false,
    promoCheckDetail: null,
    exitNode: null,
    exitNodeMissing: false,
    rotationTopic: null,
    rotationDone: 0,
    rotationTarget: 0,
    nextRunAt: null,
    lastRunAt: null,
    lastRunOk: null,
    pageOpen: false,
    running: false,
    ...overrides,
  };
}

function seed(accounts: readonly Account[]): {
  records: AccountRecords;
  ids: string[];
} {
  return reconcileFromSnapshot({}, accounts);
}

describe("规则 1：刷新不丢正在编辑的草稿", () => {
  it("收到含旧值的快照后，输入框里仍是用户的值", () => {
    let { records } = seed([account({ note: "原始备注" })]);
    records = applyDraft(records, "acc-1", { note: "用户正在写的备注" });

    // 巡检推来一份仍带旧备注的全量快照。
    ({ records } = reconcileFromSnapshot(records, [account({ note: "原始备注" })]));

    expect(records["acc-1"]?.effective.note).toBe("用户正在写的备注");
    expect(records["acc-1"]?.baseline.note).toBe("原始备注");
    expect(isAccountDirty(records["acc-1"]!)).toBe(true);
  });

  it("没被编辑过的字段跟随服务端更新", () => {
    let { records } = seed([account({ note: "原始备注", maxWindows: 3 })]);
    records = applyDraft(records, "acc-1", { note: "改了备注" });

    ({ records } = reconcileFromSnapshot(records, [
      account({ note: "原始备注", maxWindows: 9 }),
    ]));

    expect(records["acc-1"]?.effective.note).toBe("改了备注");
    expect(records["acc-1"]?.effective.maxWindows).toBe(9);
  });

  it("服务端的新值恰好等于用户草稿时，脏标记消失", () => {
    let { records } = seed([account({ note: "原始备注" })]);
    records = applyDraft(records, "acc-1", { note: "两边一致" });

    ({ records } = reconcileFromSnapshot(records, [account({ note: "两边一致" })]));

    expect(isAccountDirty(records["acc-1"]!)).toBe(false);
    expect(records["acc-1"]?.effective.note).toBe("两边一致");
  });
});

describe("规则 2：提交期间继续编辑不丢新值", () => {
  it("响应确认 A 而用户已改成 B 时，界面保留 B 且仍标记为脏", () => {
    let { records } = seed([account({ note: "原始备注" })]);

    // 用户改成 A 并提交。
    records = applyDraft(records, "acc-1", { note: "A" });
    records = beginSubmit(records, "acc-1", { note: "A" });

    // 响应还没到，用户又改成 B。
    records = applyDraft(records, "acc-1", { note: "B" });

    // 服务端确认了 A。
    records = finishSubmit(records, "acc-1", { note: "A" }, account({ note: "A" }));

    expect(records["acc-1"]?.effective.note).toBe("B");
    expect(records["acc-1"]?.baseline.note).toBe("A");
    expect(isAccountDirty(records["acc-1"]!)).toBe(true);
    expect(records["acc-1"]?.inFlight).toBeNull();
  });

  it("提交期间没有再改动时，草稿被清空并转为干净", () => {
    let { records } = seed([account({ note: "原始备注" })]);
    records = applyDraft(records, "acc-1", { note: "A" });
    records = beginSubmit(records, "acc-1", { note: "A" });
    records = finishSubmit(records, "acc-1", { note: "A" }, account({ note: "A" }));

    expect(records["acc-1"]?.effective.note).toBe("A");
    expect(isAccountDirty(records["acc-1"]!)).toBe(false);
  });

  it("同一次提交里，一个字段被改过、另一个没有：只保留被改过的那个", () => {
    let { records } = seed([account({ note: "原始备注", maxWindows: 3 })]);
    records = applyDraft(records, "acc-1", { note: "A", maxWindows: 5 });
    records = beginSubmit(records, "acc-1", { note: "A", maxWindows: 5 });
    records = applyDraft(records, "acc-1", { note: "B" });
    records = finishSubmit(
      records,
      "acc-1",
      { note: "A", maxWindows: 5 },
      account({ note: "A", maxWindows: 5 })
    );

    expect(records["acc-1"]?.effective.note).toBe("B");
    expect(records["acc-1"]?.effective.maxWindows).toBe(5);
    expect([...records["acc-1"]!.dirtyFields]).toEqual(["note"]);
  });

  it("提交失败后草稿完整保留，只清掉在途标记", () => {
    let { records } = seed([account({ note: "原始备注" })]);
    records = applyDraft(records, "acc-1", { note: "没保存成功的值" });
    records = beginSubmit(records, "acc-1", { note: "没保存成功的值" });
    records = failSubmit(records, "acc-1");

    expect(records["acc-1"]?.effective.note).toBe("没保存成功的值");
    expect(records["acc-1"]?.inFlight).toBeNull();
    expect(isAccountDirty(records["acc-1"]!)).toBe(true);
  });

  it("放弃草稿回到服务端确认的值", () => {
    let { records } = seed([account({ note: "原始备注" })]);
    records = applyDraft(records, "acc-1", { note: "临时改的" });
    records = discardDraft(records, "acc-1");

    expect(records["acc-1"]?.effective.note).toBe("原始备注");
    expect(isAccountDirty(records["acc-1"]!)).toBe(false);
  });
});

describe("规则 3：增量事件只动那一条记录", () => {
  const many = Array.from({ length: 28 }, (_, index) =>
    account({ id: `acc-${index}`, email: `user${index}@example.com` })
  );

  it("一条状态事件后，其余记录保持同一引用", () => {
    const { records, ids } = seed(many);
    const next = applyAccountStatus(records, "acc-7", { status: "out" });

    const movedIds = ids.filter((id) => records[id] !== next[id]);
    expect(movedIds).toEqual(["acc-7"]);
    expect(next["acc-7"]?.effective.status).toBe("out");
  });

  it("状态事件不改变草稿", () => {
    let { records } = seed(many);
    records = applyDraft(records, "acc-3", { note: "正在编辑" });
    records = applyAccountStatus(records, "acc-3", { status: "reauth" });

    expect(records["acc-3"]?.effective.note).toBe("正在编辑");
    expect(records["acc-3"]?.effective.status).toBe("reauth");
  });

  it("没有实际变化的状态事件返回原引用", () => {
    const { records } = seed(many);
    const next = applyAccountStatus(records, "acc-5", { status: "ok" });
    expect(next).toBe(records);
  });

  it("account.changed 保留草稿并只动那一条", () => {
    let { records } = seed(many);
    records = applyDraft(records, "acc-2", { note: "编辑中" });
    const before = records;

    const { records: after, isNew } = applyAccountChanged(
      records,
      account({ id: "acc-2", status: "reauth", note: "服务端的备注" })
    );

    expect(isNew).toBe(false);
    expect(after["acc-2"]?.effective.note).toBe("编辑中");
    expect(after["acc-2"]?.effective.status).toBe("reauth");
    expect(after["acc-9"]).toBe(before["acc-9"]);
  });

  it("account.changed 带来未知 id 时报告为新增", () => {
    const { records } = seed(many);
    const { isNew } = applyAccountChanged(records, account({ id: "brand-new" }));
    expect(isNew).toBe(true);
  });

  it("account.removed 删掉那一条，其余不动", () => {
    const { records } = seed(many);
    const next = applyAccountRemoved(records, "acc-4");
    expect(next["acc-4"]).toBeUndefined();
    expect(next["acc-5"]).toBe(records["acc-5"]);
  });
});

describe("规则 3 的另一半：增量事件后重新应用筛选", () => {
  it("筛选「仅需登录」时，状态转 ok 的那张卡从可见列表消失", () => {
    const seeded = seed([
      account({ id: "acc-1", status: "reauth" }),
      account({ id: "acc-2", status: "reauth" }),
    ]);
    const filter = { ...DEFAULT_ACCOUNT_FILTER, status: "reauth" as const };

    expect(
      selectVisibleAccounts(seeded.records, seeded.ids, filter).map((r) => r.effective.id)
    ).toEqual(["acc-1", "acc-2"]);

    const after = applyAccountStatus(seeded.records, "acc-1", { status: "ok" });

    expect(
      selectVisibleAccounts(after, seeded.ids, filter).map((r) => r.effective.id)
    ).toEqual(["acc-2"]);
  });

  it("草稿影响筛选结果：改了分组的卡片按草稿值参与筛选", () => {
    const seeded = seed([
      account({ id: "acc-1", groupId: "g1" }),
      account({ id: "acc-2", groupId: "g2" }),
    ]);
    const filter = { ...DEFAULT_ACCOUNT_FILTER, groupId: "g2" };

    const records = applyDraft(seeded.records, "acc-1", { groupId: "g2" });

    expect(
      selectVisibleAccounts(records, seeded.ids, filter).map((r) => r.effective.id)
    ).toEqual(["acc-1", "acc-2"]);
  });

  it("关键词匹配邮箱、备注、ID、GPT 昵称与分组名", () => {
    const seeded = seed([
      account({ id: "acc-1", email: "alpha@example.com", note: "" }),
      account({ id: "acc-2", email: null, note: "备用小号" }),
      account({ id: "acc-3", email: null, note: "", gptName: "Plus" }),
      account({ id: "acc-4", email: null, note: "", groupName: "香港节点" }),
    ]);
    const pick = (keyword: string): string[] =>
      selectVisibleAccounts(seeded.records, seeded.ids, {
        ...DEFAULT_ACCOUNT_FILTER,
        keyword,
      }).map((record) => record.effective.id);

    expect(pick("alpha")).toEqual(["acc-1"]);
    expect(pick("小号")).toEqual(["acc-2"]);
    expect(pick("acc-3")).toEqual(["acc-3"]);
    expect(pick("plus")).toEqual(["acc-3"]);
    expect(pick("香港")).toEqual(["acc-4"]);
  });

  it("状态筛选覆盖 stale / node_missing / disabled / page_open 四个派生项", () => {
    const seeded = seed([
      account({ id: "acc-stale", stale: true }),
      account({ id: "acc-node", exitNodeMissing: true }),
      account({ id: "acc-off", enabled: false }),
      account({ id: "acc-page", pageOpen: true }),
    ]);
    const pick = (status: "stale" | "node_missing" | "disabled" | "page_open"): string[] =>
      selectVisibleAccounts(seeded.records, seeded.ids, {
        ...DEFAULT_ACCOUNT_FILTER,
        status,
      }).map((record) => record.effective.id);

    expect(pick("stale")).toEqual(["acc-stale"]);
    expect(pick("node_missing")).toEqual(["acc-node"]);
    expect(pick("disabled")).toEqual(["acc-off"]);
    expect(pick("page_open")).toEqual(["acc-page"]);
  });

  it("优惠筛选区分免费试用、半价、无资格与未检查", () => {
    const seeded = seed([
      account({ id: "acc-free", promoEligibility: "free_trial" }),
      account({ id: "acc-half", promoEligibility: "half_price" }),
      account({ id: "acc-both", promoEligibility: "both" }),
      account({ id: "acc-none", promoEligibility: "none" }),
      account({ id: "acc-unchecked", promoEligibility: null }),
    ]);
    const pick = (promo: "eligible" | "free_trial" | "half_price" | "none" | "unchecked"): string[] =>
      selectVisibleAccounts(seeded.records, seeded.ids, {
        ...DEFAULT_ACCOUNT_FILTER,
        promo,
      }).map((record) => record.effective.id);

    expect(pick("eligible")).toEqual(["acc-free", "acc-half", "acc-both"]);
    expect(pick("free_trial")).toEqual(["acc-free", "acc-both"]);
    expect(pick("half_price")).toEqual(["acc-half", "acc-both"]);
    expect(pick("none")).toEqual(["acc-none"]);
    expect(pick("unchecked")).toEqual(["acc-unchecked"]);
  });

  it("未分组筛选把 null 与空串都算作未分组", () => {
    const seeded = seed([
      account({ id: "acc-1", groupId: null }),
      account({ id: "acc-2", groupId: "" }),
      account({ id: "acc-3", groupId: "g1" }),
    ]);

    expect(
      selectVisibleAccounts(seeded.records, seeded.ids, {
        ...DEFAULT_ACCOUNT_FILTER,
        groupId: "none",
      }).map((record) => record.effective.id)
    ).toEqual(["acc-1", "acc-2"]);
  });
});

describe("记录组装", () => {
  it("与基线相同的草稿项被剪掉，不产生假脏值", () => {
    const record = makeAccountRecord(account({ note: "同一个值" }), {
      note: "同一个值",
    });
    expect(isAccountDirty(record)).toBe(false);
    expect(record.effective).toBe(record.baseline);
  });

  it("快照里消失的账号从 ids 与 records 中一并移除", () => {
    const first = seed([account({ id: "acc-1" }), account({ id: "acc-2" })]);
    const second = reconcileFromSnapshot(first.records, [account({ id: "acc-1" })]);

    expect(second.ids).toEqual(["acc-1"]);
    expect(second.records["acc-2"]).toBeUndefined();
  });

  it("顺序跟随服务端快照", () => {
    const { ids } = seed([
      account({ id: "c" }),
      account({ id: "a" }),
      account({ id: "b" }),
    ]);
    expect(ids).toEqual(["c", "a", "b"]);
  });
});
