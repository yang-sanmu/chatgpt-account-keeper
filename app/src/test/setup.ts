// vitest 全局测试环境准备。
//
// jsdom 缺三样这套 UI 真实依赖的东西，缺了会在渲染期直接抛错而不是给出有用的失败信息：
// matchMedia（主题跟随系统）、ResizeObserver 与 IntersectionObserver（Radix 的浮层定位）。
// 这里补的是最小可用实现，不模拟行为——需要断言行为的测试自己接管。

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

class MockObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

globalThis.ResizeObserver ??= MockObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??=
  MockObserver as unknown as typeof IntersectionObserver;

// Radix 的 Select / DropdownMenu 在打开时调它做滚动锁定与命中测试，jsdom 里没有。
Element.prototype.scrollIntoView ??= vi.fn();
Element.prototype.hasPointerCapture ??= vi.fn(() => false);
Element.prototype.setPointerCapture ??= vi.fn();
Element.prototype.releasePointerCapture ??= vi.fn();
