import test from "node:test";
import assert from "node:assert/strict";
import { configureStoreBackend } from "../src/store.js";
import { commitWindow, selectSetForAccount } from "../src/rotation.js";

// 主题轮换是产品行为的核心：某主题连续跑够随机窗口数才切换。它读全局会话集、
// 写全局账号，所以这里用 store 后端接缝注入固定数据，并把 secureRandom 的熵源
// 钉死，让"随机"部分变成可断言的。

/**
 * 注入会话集与账号写入观察点。返回 { updates } 记录每次 updateAccount 调用。
 */
function storeWith(sets, t) {
  const updates = [];
  const restore = configureStoreBackend({
    getConversations: () => sets,
    updateAccount: (id, patch) => {
      updates.push([id, patch]);
      return patch;
    },
  });
  t.after(restore);
  return updates;
}

/**
 * 把 crypto.getRandomValues 固定成给定的 [0,1) 序列，用完循环最后一个值。
 * rotation.js 的 secureRandom 读 Uint32Array[0] / 2**32。
 */
function fixedRandom(values, t) {
  const original = globalThis.crypto.getRandomValues;
  let i = 0;
  globalThis.crypto.getRandomValues = (array) => {
    const fraction = values[Math.min(i, values.length - 1)];
    i += 1;
    array[0] = Math.min(2 ** 32 - 1, Math.floor(fraction * 2 ** 32));
    return array;
  };
  t.after(() => {
    globalThis.crypto.getRandomValues = original;
  });
}

const twoSets = {
  设计: { topic: "系统设计" },
  算法: { topic: "算法" },
};

test("没有任何带主题的会话集时返回 null，不写账号状态", (t) => {
  const updates = storeWith({ 空集: { topic: "   " }, 无主题: {} }, t);

  assert.equal(selectSetForAccount({ id: "a1" }), null);
  assert.deepEqual(updates, []);
});

test("首次选择会切换主题、定随机目标窗口数并立即持久化", (t) => {
  const updates = storeWith(twoSets, t);
  // random 规则：第一次取值用于挑主题（0 → 第一个），第二次用于定窗口数。
  fixedRandom([0, 0.99], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "random",
    minWindows: 2,
    maxWindows: 5,
  });

  assert.equal(picked.setName, "设计");
  assert.equal(picked.set.topic, "系统设计");
  assert.deepEqual(updates, [
    ["a1", { rotation: { currentSet: "设计", windowsDone: 0, windowsTarget: 5 } }],
  ]);
});

test("目标窗口数未跑满时保持当前主题，且不产生写入", (t) => {
  const updates = storeWith(twoSets, t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计", windowsDone: 1, windowsTarget: 3 },
  });

  assert.equal(picked.setName, "设计");
  assert.deepEqual(updates, []);
});

test("跑满目标窗口数后按 sequential 切到下一个主题并重置计数", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    minWindows: 4,
    maxWindows: 4,
    rotation: { currentSet: "设计", windowsDone: 3, windowsTarget: 3 },
  });

  assert.equal(picked.setName, "算法");
  assert.deepEqual(updates, [
    ["a1", { rotation: { currentSet: "算法", windowsDone: 0, windowsTarget: 4 } }],
  ]);
});

test("sequential 在最后一个主题上回绕到第一个", (t) => {
  storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "算法", windowsDone: 2, windowsTarget: 2 },
  });

  assert.equal(picked.setName, "设计");
});

test("已被删除的当前主题会触发重新选择，而不是返回不存在的会话集", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    // windowsTarget 还没跑满，但 currentSet 已经不在会话集里了。
    rotation: { currentSet: "已删除的主题", windowsDone: 0, windowsTarget: 5 },
  });

  assert.equal(picked.setName, "设计");
  assert.ok(picked.set, "必须返回真实存在的会话集对象");
  assert.equal(updates.length, 1);
});

test("windowsTarget 为 0 的历史数据不会卡死在同一主题", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计", windowsDone: 0, windowsTarget: 0 },
  });

  assert.equal(picked.setName, "算法");
  assert.ok(updates[0][1].rotation.windowsTarget >= 1);
});

test("缺 windowsTarget 的部分 rotation 不会把账号永久钉在同一主题", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  // 旧数据或部分写入可能只留下 currentSet。undefined 参与数值比较全是 false，
  // 一旦 needSwitch 永远不成立，这个账号就再也换不了主题了。
  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计" },
  });

  assert.equal(picked.setName, "算法");
  assert.equal(updates.length, 1, "必须持久化修复后的完整 rotation");
  assert.deepEqual(updates[0][1].rotation, {
    currentSet: "算法",
    windowsDone: 0,
    windowsTarget: 1,
  });
});

test("windowsDone 缺失而 windowsTarget 为 0 时仍会切换", (t) => {
  storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计", windowsTarget: 0 },
  });

  assert.equal(picked.setName, "算法");
});

test("rotation 里的字符串计数不会被当成文本拼接", (t) => {
  const updates = storeWith(twoSets, t);

  // 手改过的 accounts.json 可能把计数存成字符串。"3" + 1 会变成 "31"，
  // 之后这个账号的窗口计数就彻底失控了。
  const next = commitWindow("a1", { currentSet: "设计", windowsDone: "3", windowsTarget: 5 });

  assert.equal(next.windowsDone, 4);
  assert.deepEqual(updates, [["a1", { rotation: next }]]);
});

test("小数计数被归整，窗口数不会漂成非整数", (t) => {
  storeWith(twoSets, t);

  // 计数一旦变成小数，之后每次递增都带着尾数，界面上显示的窗口数也不再是整数。
  const next = commitWindow("a1", { currentSet: "设计", windowsDone: 2.7, windowsTarget: 5 });

  assert.equal(next.windowsDone, 3);
  assert.ok(Number.isInteger(next.windowsDone));
});

test("小数目标窗口数按下取整判定，不会多跑一个窗口", (t) => {
  storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计", windowsDone: 2, windowsTarget: 2.5 },
  });

  assert.equal(picked.setName, "算法");
});

test("负数计数被当作 0，不会累积成永不切换的欠账", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计", windowsDone: -5, windowsTarget: 3 },
  });

  // done 为负数时 -5 >= 3 不成立，账号会停在当前主题；归一成 0 后同样不切换，
  // 但持久化的计数必须是 0 而不是负数，否则要多跑 8 个窗口才轮换。
  assert.equal(picked.setName, "设计");
  assert.deepEqual(updates, []);

  const next = commitWindow("a1", { currentSet: "设计", windowsDone: -5, windowsTarget: 3 });
  assert.equal(next.windowsDone, 1);
});

test("minWindows 为 0 时目标窗口数仍至少为 1", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0, 0], t);

  selectSetForAccount({ id: "a1", minWindows: 0, maxWindows: 0 });

  // 目标为 0 会让每跑一个窗口就换主题，轮换规则等于失效。
  assert.ok(updates[0][1].rotation.windowsTarget >= 1);
});

test("random 规则会避开当前主题", (t) => {
  storeWith(twoSets, t);
  // 随机源持续为 0 时，旧实现重试 10 次仍会抽回 index 0 的当前主题。现在直接
  // 从其他主题里抽，所以即使随机值不变也必须完成轮换。
  fixedRandom([0], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "random",
    rotation: { currentSet: "设计", windowsDone: 1, windowsTarget: 1 },
  });

  assert.equal(picked.setName, "算法");
});

test("只有一个会话集时 random 规则原地保持，不会返回 null", (t) => {
  storeWith({ 唯一: { topic: "仅此一个" } }, t);
  fixedRandom([0.5], t);

  const picked = selectSetForAccount({
    id: "a1",
    switchRule: "random",
    rotation: { currentSet: "唯一", windowsDone: 9, windowsTarget: 1 },
  });

  assert.equal(picked.setName, "唯一");
});

test("缺省 switchRule 走 random，缺省窗口区间落在 [1,3]", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0, 0.99], t);

  selectSetForAccount({ id: "a1" });

  const { windowsTarget } = updates[0][1].rotation;
  assert.ok(windowsTarget >= 1 && windowsTarget <= 3, `windowsTarget=${windowsTarget}`);
});

test("minWindows 大于 maxWindows 时不会算出空区间", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0, 0.99], t);

  selectSetForAccount({ id: "a1", minWindows: 7, maxWindows: 2 });

  assert.equal(updates[0][1].rotation.windowsTarget, 7);
});

test("显式注入依赖时完全不碰全局 store", () => {
  // 注入版必须自成一体：函数签名以前看不出 selectSetForAccount 会写库，
  // 依赖显式化之后调用方能自己决定数据从哪来、写到哪去。
  // 这里故意把全局 store 后端配成会抛错的实现，证明注入路径没有回落。
  const exploding = configureStoreBackend({
    getConversations: () => {
      throw new Error("不该访问全局 store");
    },
    updateAccount: () => {
      throw new Error("不该写全局 store");
    },
  });
  try {
    const updates = [];
    const picked = selectSetForAccount(
      { id: "a1", switchRule: "sequential", rotation: { currentSet: "设计", windowsDone: 1, windowsTarget: 1 } },
      {
        getConversations: () => twoSets,
        updateAccount: (id, patch) => updates.push([id, patch]),
      }
    );

    assert.equal(picked.setName, "算法");
    assert.equal(updates.length, 1);
    assert.equal(updates[0][0], "a1");

    const committed = [];
    const next = commitWindow("a1", { currentSet: "算法", windowsDone: 0, windowsTarget: 3 }, {
      updateAccount: (id, patch) => committed.push([id, patch]),
    });
    assert.equal(next.windowsDone, 1);
    assert.deepEqual(committed, [["a1", { rotation: next }]]);
  } finally {
    exploding();
  }
});

test("只注入一半依赖时，另一半仍走全局 store", (t) => {
  // 部分注入不能静默失效——否则调用方以为覆盖了写入路径，实际还在写全局库。
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  const picked = selectSetForAccount(
    { id: "a1", switchRule: "sequential", rotation: { currentSet: "设计", windowsDone: 2, windowsTarget: 2 } },
    { getConversations: () => ({ 独立集: { topic: "只在注入里可见" } }) }
  );

  assert.equal(picked.setName, "独立集", "会话集来自注入");
  assert.equal(updates.length, 1, "写入仍落到全局 store");
  assert.equal(updates[0][1].rotation.currentSet, "独立集");
});

test("commitWindow 递增计数并保留当前主题与目标", (t) => {
  const updates = storeWith(twoSets, t);

  const next = commitWindow("a1", {
    currentSet: "设计",
    windowsDone: 1,
    windowsTarget: 3,
  });

  assert.deepEqual(next, { currentSet: "设计", windowsDone: 2, windowsTarget: 3 });
  assert.deepEqual(updates, [["a1", { rotation: next }]]);
});

test("commitWindow 在没有既有 rotation 时从 0 起算", (t) => {
  const updates = storeWith(twoSets, t);

  const next = commitWindow("a1", undefined);

  assert.equal(next.windowsDone, 1);
  assert.deepEqual(updates, [["a1", { rotation: next }]]);
});

test("跑满目标后 commitWindow 的结果会让下一次选择触发切换", (t) => {
  const updates = storeWith(twoSets, t);
  fixedRandom([0], t);

  // 模拟真实序列：选中主题 → 跑一个窗口 → 再次选择。
  const first = selectSetForAccount({
    id: "a1",
    switchRule: "sequential",
    rotation: { currentSet: "设计", windowsDone: 0, windowsTarget: 1 },
  });
  assert.equal(first.setName, "设计");

  const rotation = commitWindow("a1", {
    currentSet: "设计",
    windowsDone: 0,
    windowsTarget: 1,
  });

  const second = selectSetForAccount({ id: "a1", switchRule: "sequential", rotation });
  assert.equal(second.setName, "算法");
  assert.equal(updates.at(-1)[1].rotation.windowsDone, 0);
});
