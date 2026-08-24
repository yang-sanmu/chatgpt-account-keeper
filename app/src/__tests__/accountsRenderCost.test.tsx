// M2 止损判据的可判定部分。
//
// 「滚动无可见卡顿」不可判定，所以这里测的是它的成因：一次与某张卡片无关的状态变化
// 会让多少张卡片重新渲染。
//
// 28 个真实账号 + 每 15 分钟一轮巡检（每账号一条 accountStatus.changed）意味着每轮有
// 28 次状态更新。如果每次更新都重渲染全部 28 张卡片，那就是 784 次卡片渲染；只重渲染
// 受影响的那一张则是 28 次。这个差别就是「卡不卡」的来源。
//
// 这里不测 AccountCard 本身（它要 AppProvider，而 AppProvider 在 mount 时会调 Tauri
// API），而是测**上下文传播模式**：一个每次渲染都新建的 context value 会让任何
// React.memo 失效，这是与具体卡片实现无关的结构性事实。

import { act, memo, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInitialAccountsState,
  getFilteredAccounts,
  handleSingleAccountStatusChanged,
  reconcileAccountsFromBootstrap,
} from "../state/accountsStore";
import type { Account } from "../ipc/types";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/// 与 `config/accounts.json` 当前的真实规模一致。用真实数量而不是 5 或 1000：前者测不出
/// 问题，后者会把结论变成一个与本产品无关的压力测试。
const REAL_ACCOUNT_COUNT = 28;

function makeAccount(index: number): Account {
  return {
    id: `acc-${index}`,
    email: `user${index}@example.com`,
    note: `账号备注 ${index}`,
    enabled: index % 3 !== 0,
    groupId: index % 2 === 0 ? "group-a" : null,
    groupName: index % 2 === 0 ? "美国节点组" : null,
    switchRule: index % 2 === 0 ? "random" : "sequential",
    minWindows: 1,
    maxWindows: 3,
    status: index % 4 === 0 ? "needs_login" : "ok",
    statusCheckedAt: "2026-08-24T10:00:00Z",
    stale: index % 7 === 0,
    exitNode: index % 2 === 0 ? "us-west-01" : null,
    exitNodeMissing: index % 11 === 0,
    rotationTopic: "技术话题",
    rotationDone: index % 5,
    rotationTarget: 5,
    nextRunAt: "2026-08-25T09:00:00Z",
    lastRunAt: "2026-08-24T09:00:00Z",
    lastRunOk: index % 9 !== 0,
    pageOpen: false,
  };
}

function accountsFor(count: number): Account[] {
  return Array.from({ length: count }, (_, index) => makeAccount(index));
}

describe("M2 止损判据：增量事件的渲染成本", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("一条状态事件只让受影响的那张卡片重新渲染", () => {
    // 复刻真实的组件形状：一个持有全部状态的容器 + 每张卡片各自订阅自己的那一份。
    // 这里用显式 props 传递（而不是 context）来表达目标行为：卡片只依赖自己的 item。
    const renders = new Map<string, number>();

    function Card({ id, status }: { id: string; status: string }) {
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return <div data-testid={id}>{status}</div>;
    }
    const MemoCard = memo(Card);

    let state = reconcileAccountsFromBootstrap(
      createInitialAccountsState(),
      accountsFor(REAL_ACCOUNT_COUNT)
    );

    const render = () => {
      const items = getFilteredAccounts(state);
      act(() => {
        root.render(
          <div>
            {items.map((item) => (
              <MemoCard
                key={item.effective.id}
                id={item.effective.id}
                status={item.effective.status}
              />
            ))}
          </div>
        );
      });
    };

    render();
    expect(renders.size).toBe(REAL_ACCOUNT_COUNT);
    renders.clear();

    // 巡检推来一条事件：只有 acc-7 的状态变了。
    state = handleSingleAccountStatusChanged(state, { id: "acc-7", status: "waf" });
    render();

    const rerendered = [...renders.keys()].sort();
    expect(
      rerendered,
      `期望只有 acc-7 重渲染，实际 ${rerendered.length} 张：${rerendered.join(",")}`
    ).toEqual(["acc-7"]);
  });

  it("每次渲染都新建的 context value 会让所有卡片重渲染", () => {
    // 这条不是在测某个组件，而是把一个结构性事实钉下来：只要 Provider 的 value 是
    // render 期间新建的对象，任何下游 memo 都会失效。AppContext 目前就是这样，所以在
    // 给 AccountCard 加 React.memo 之前必须先把 value 记忆化，否则那个 memo 是装饰。
    const unstableRenders = countRendersUnderProvider(root, false);
    const stableRenders = countRendersUnderProvider(root, true);

    expect(
      unstableRenders,
      "未记忆化的 context value 应让全部子组件重渲染"
    ).toBe(REAL_ACCOUNT_COUNT);
    expect(
      stableRenders,
      "记忆化之后无关子组件不该重渲染"
    ).toBe(0);
  });

  it("首屏渲染 28 张卡片在预算内完成", () => {
    const state = reconcileAccountsFromBootstrap(
      createInitialAccountsState(),
      accountsFor(REAL_ACCOUNT_COUNT)
    );
    const items = getFilteredAccounts(state);

    const started = performance.now();
    act(() => {
      root.render(
        <div>
          {items.map((item) => (
            <div key={item.effective.id}>{item.effective.email}</div>
          ))}
        </div>
      );
    });
    const elapsed = performance.now() - started;

    // jsdom 没有合成器也没有真实布局，这个上限只用来捕捉数量级退化（例如某次改动让
    // 每张卡片做一次 O(n) 的分组查找）。真实卡顿要在打包版上看。
    expect(
      elapsed,
      `首屏渲染 ${REAL_ACCOUNT_COUNT} 项耗时 ${elapsed.toFixed(0)}ms`
    ).toBeLessThan(1500);
  });

  it("状态事件到 DOM 更新在 100ms 预算内", () => {
    let state = reconcileAccountsFromBootstrap(
      createInitialAccountsState(),
      accountsFor(REAL_ACCOUNT_COUNT)
    );
    const render = () => {
      const items = getFilteredAccounts(state);
      act(() => {
        root.render(
          <div>
            {items.map((item) => (
              <div key={item.effective.id} data-testid={item.effective.id}>
                {item.effective.status}
              </div>
            ))}
          </div>
        );
      });
    };
    render();

    const started = performance.now();
    state = handleSingleAccountStatusChanged(state, { id: "acc-13", status: "waf" });
    render();
    const elapsed = performance.now() - started;

    const updated = container.querySelector('[data-testid="acc-13"]');
    expect(updated?.textContent).toBe("waf");
    expect(elapsed, `事件到 DOM 更新耗时 ${elapsed.toFixed(0)}ms`).toBeLessThan(100);
  });
});

/// 在 Provider 下挂 N 个记忆化子组件，触发一次与它们无关的状态变化，返回重渲染次数。
function countRendersUnderProvider(root: Root, memoizeValue: boolean): number {
  let count = 0;

  const Child = memo(function Child({ value }: { value: { tick: number } }) {
    // 读了 value 才会因它变化而重渲染；这模拟卡片从 context 取回调和分组列表。
    void value.tick;
    count += 1;
    return null;
  });

  let bump: (() => void) | null = null;

  function Host() {
    const [unrelated, setUnrelated] = useState(0);
    bump = () => setUnrelated((previous) => previous + 1);

    // 关键差别只有这一行：value 是每次 render 新建，还是记忆化的。
    const unstable = { tick: 0 };
    const stable = useMemo(() => ({ tick: 0 }), []);
    const value = memoizeValue ? stable : unstable;

    return (
      <div data-unrelated={unrelated}>
        {Array.from({ length: REAL_ACCOUNT_COUNT }, (_, index) => (
          <Child key={index} value={value} />
        ))}
      </div>
    );
  }

  act(() => root.render(<Host />));
  count = 0;

  // 触发一次与子组件无关的状态变化（现实里是连接状态、任务列表、队列快照等）。
  act(() => bump?.());
  return count;
}
