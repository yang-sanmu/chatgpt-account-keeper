// 共享心跳，用于让相对时间（「3 分钟前」）自己走动。
//
// 为什么需要它：formatRelative 的结果是渲染那一刻算出来的，之后就冻在那里。界面上大量
// 「N 分钟前 / N 天后」只有在别的事件恰好触发重渲染时才会变，于是一个开着不动的窗口里
// 时间永远停在打开那一刻。
//
// 为什么是 30 秒而不是 1 秒：formatRelative 输出的最细粒度是**分钟**，秒级刷新 60 次里
// 有 59 次产出完全相同的字符串。而账号页有 28 张卡片，每秒全量重渲染会直接抹掉
// 「一条事件只重渲染一张卡」这个性质（见 accountCardRender.test.tsx）。
//
// 订阅必须下沉到只显示时间的那个叶子组件（见 RelativeTime），心跳才只唤醒几十个文本
// 节点而不是几十张卡片。

import { useEffect, useState } from "react";

const TICK_INTERVAL_MS = 30_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function start(): void {
  if (timer !== null) return;
  timer = setInterval(notify, TICK_INTERVAL_MS);
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/// 页面不可见时停掉心跳。
///
/// 这是个常驻托盘的程序，隐藏到托盘后窗口仍然挂着；继续每 30 秒唤醒一批组件没有意义。
/// 重新可见时立刻补一次，否则界面会停在隐藏前的那个时刻。
function handleVisibilityChange(): void {
  if (document.hidden) {
    stop();
    return;
  }
  notify();
  if (listeners.size > 0) start();
}

function subscribe(listener: Listener): () => void {
  const firstListener = listeners.size === 0;
  listeners.add(listener);

  if (firstListener) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (!document.hidden) start();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

/// 订阅心跳。返回值每次心跳递增，用来触发重渲染。
///
/// 只在**真正显示相对时间**的叶子组件里用。放在卡片或页面级别会让心跳重渲染整棵子树。
export function useTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => subscribe(() => setTick((value) => value + 1)), []);

  return tick;
}

/// 仅供测试：当前订阅者数量。用来验证组件卸载后没有泄漏。
export function __tickListenerCountForTests(): number {
  return listeners.size;
}

/// 仅供测试：手动推进一次心跳，不必等 30 秒。
export function __advanceTickForTests(): void {
  notify();
}
