// 一条巡检事件只重渲染一张卡片。
//
// 这是可判定的性能判据。28 个真实账号、每 15 分钟一轮巡检，每轮 28 条 accountStatus.changed。
// 如果每条事件都重渲染全部卡片，那是 784 次渲染而不是 28 次 —— 这个差别就是「滚动卡不卡」
// 的来源，而它在功能上完全看不出来，只能靠测试钉住。
//
// 真正起作用的是**订阅粒度**：卡片必须通过 useAccountRecord(id) 只订阅自己那一条。
// 把它换成 useKeeperStore(s => s.accounts)[id] —— 一个看起来完全等价的写法 —— 这些断言
// 立刻变成 28 张卡全部重渲染。memo 在这里是次要的：zustand 的选择器不返回新引用时组件
// 根本不会被唤醒，所以少了 memo 也过，但两个一起才对得起「一条事件一张卡」。

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { useAccountRecord } from "@/store/selectors";
import { TooltipProvider } from "@/components/ui/tooltip";

/// 与 config/accounts.json 当前的真实规模一致。用真实数量而不是 5 或 1000：前者测不出
/// 问题，后者会把结论变成一个与本产品无关的压力测试。
const REAL_ACCOUNT_COUNT = 28;

const renderCounts = new Map<string, number>();

/// 与 AccountCard 相同的订阅形状：只吃一个 id，自己去 store 取那条记录。
///
/// 不直接渲染 AccountCard 是因为它拉进来十几个 Radix 浮层组件，测的东西会从「订阅粒度」
/// 漂移成「那些组件在 jsdom 里能不能挂载」。这里测的是结构性事实。
const ProbeCard = React.memo(function ProbeCard({ id }: { id: string }) {
  const record = useAccountRecord(id);
  renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
  return <div data-testid={id}>{record?.effective.status ?? "missing"}</div>;
});

function Grid({ ids }: { ids: string[] }) {
  return (
    <TooltipProvider>
      {ids.map((id) => (
        <ProbeCard key={id} id={id} />
      ))}
    </TooltipProvider>
  );
}

const accounts = Array.from({ length: REAL_ACCOUNT_COUNT }, (_, index) =>
  makeAccount({
    id: `acc-${index}`,
    email: `user${index}@example.com`,
    status: index % 4 === 0 ? "reauth" : "ok",
  })
);

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  renderCounts.clear();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({ accounts }));
});

describe("账号卡片的渲染成本", () => {
  it("一条状态事件只让那一张卡片重新渲染", () => {
    const ids = useKeeperStore.getState().accountIds;
    render(<Grid ids={ids} />);

    expect(renderCounts.size).toBe(REAL_ACCOUNT_COUNT);
    renderCounts.clear();

    act(() => {
      tauri.emitAgentEvent("accountStatus.changed", { id: "acc-7", status: "out" });
    });

    const rerendered = [...renderCounts.keys()].sort();
    expect(
      rerendered,
      `期望只有 acc-7 重渲染，实际 ${rerendered.length} 张：${rerendered.join(",")}`
    ).toEqual(["acc-7"]);
    expect(screen.getByTestId("acc-7").textContent).toBe("out");
  });

  it("一轮完整巡检（28 条事件）的渲染次数与账号数同阶，而不是平方阶", () => {
    const ids = useKeeperStore.getState().accountIds;
    render(<Grid ids={ids} />);
    renderCounts.clear();

    act(() => {
      for (const id of ids) {
        tauri.emitAgentEvent("accountStatus.changed", { id, status: "out" });
      }
    });

    const total = [...renderCounts.values()].reduce((sum, count) => sum + count, 0);
    expect(
      total,
      `一轮巡检共触发 ${total} 次卡片渲染（整表替换会是 ${REAL_ACCOUNT_COUNT ** 2} 次）`
    ).toBe(REAL_ACCOUNT_COUNT);
  });

  it("与账号无关的状态变化不触发任何卡片渲染", () => {
    const ids = useKeeperStore.getState().accountIds;
    render(<Grid ids={ids} />);
    renderCounts.clear();

    // 队列快照每几秒更新一次，它不该唤醒 28 张卡片。
    act(() => {
      tauri.emitAgentEvent("queue.changed", {
        queuedTotal: 3,
        waiting: { queued: 3 },
        running: 1,
        closing: 0,
        workSlots: { used: 1, limit: 4 },
        chromeSlots: { used: 1, limit: 2 },
      });
    });

    expect(renderCounts.size).toBe(0);
  });

  it("没有实际变化的状态事件不触发渲染", () => {
    const ids = useKeeperStore.getState().accountIds;
    render(<Grid ids={ids} />);
    renderCounts.clear();

    // acc-1 已经是 ok，再推一条 ok 不该产生任何渲染。
    act(() => {
      tauri.emitAgentEvent("accountStatus.changed", { id: "acc-1", status: "ok" });
    });

    expect(renderCounts.size).toBe(0);
  });
});
