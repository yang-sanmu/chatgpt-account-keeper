// 相对时间的心跳。
//
// 这条钉的是性能约束，不只是功能：心跳存在的意义是让「N 分钟前」自己走动，但它绝不能变成
// 「每 30 秒重渲染 28 张账号卡片」—— 那会抹掉 accountCardRender.test.tsx 保证的
// 「一条事件只重渲染一张卡」。所以订阅必须能下沉到叶子，且卸载后不留监听。

import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __advanceTickForTests,
  __tickListenerCountForTests,
  useTick,
} from "../useTick";

afterEach(() => {
  vi.useRealTimers();
});

describe("心跳订阅", () => {
  it("推进心跳会让订阅的组件重渲染", () => {
    let renders = 0;
    function Clock() {
      useTick();
      renders += 1;
      return null;
    }

    render(<Clock />);
    expect(renders).toBe(1);

    act(() => __advanceTickForTests());
    expect(renders).toBe(2);
  });

  it("只唤醒订阅了心跳的组件，不波及兄弟组件", () => {
    // 这是整个设计的要点：把 useTick 放在卡片层会让心跳重渲染整张卡片。
    let clockRenders = 0;
    let cardRenders = 0;

    function Clock() {
      useTick();
      clockRenders += 1;
      return <span>时间</span>;
    }

    const Card = React.memo(function Card() {
      cardRenders += 1;
      return (
        <div>
          <span>大量其它内容</span>
          <Clock />
        </div>
      );
    });

    render(<Card />);
    expect(cardRenders).toBe(1);
    expect(clockRenders).toBe(1);

    act(() => __advanceTickForTests());

    expect(clockRenders).toBe(2);
    expect(cardRenders, "心跳不该重渲染卡片本体").toBe(1);
  });

  it("组件卸载后不再持有监听", () => {
    // 泄漏的后果是隐藏到托盘再打开若干次之后，一次心跳唤醒几百个已卸载组件的 setState。
    const { unmount } = render(<TickProbe />);
    expect(__tickListenerCountForTests()).toBe(1);

    unmount();
    expect(__tickListenerCountForTests()).toBe(0);
  });

  it("多个订阅者共用一个计时器", () => {
    const { unmount } = render(
      <>
        <TickProbe />
        <TickProbe />
        <TickProbe />
      </>
    );
    expect(__tickListenerCountForTests()).toBe(3);
    unmount();
    expect(__tickListenerCountForTests()).toBe(0);
  });

  it("按 30 秒间隔推进，不是每秒", () => {
    // 每秒推进买不到任何东西：formatRelative 的最细粒度是分钟，60 次里 59 次产出同一个
    // 字符串，而代价是每秒唤醒一批组件。
    vi.useFakeTimers();
    let renders = 0;
    function Clock() {
      useTick();
      renders += 1;
      return null;
    }

    render(<Clock />);
    renders = 0;

    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(renders, "29 秒时还不该触发").toBe(0);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(renders).toBe(1);
  });
});

function TickProbe() {
  useTick();
  return <span>探针</span>;
}

describe("RelativeTime 叶子组件", () => {
  it("显示相对时间，绝对时间戳（含秒）放在 title", async () => {
    const { RelativeTime } = await import("@/components/ui/relative-time");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();

    render(<RelativeTime value={twoHoursAgo} />);

    const node = screen.getByText(/小时前/);
    expect(node.getAttribute("title")).toMatch(/\d{2}:\d{2}:\d{2}$/);
  });

  it("没有时间时显示传入的占位文案", async () => {
    const { RelativeTime } = await import("@/components/ui/relative-time");
    render(<RelativeTime value={null} fallback="从未运行" />);
    expect(screen.getByText("从未运行")).toBeInTheDocument();
  });
});
