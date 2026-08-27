// 主题应用。
//
// 三档（深色 / 浅色 / 跟随系统）都要真的生效。跟随系统这一档最容易坏：它依赖
// matchMedia，而写错时的表现是「永远深色」，在一台深色系统上测不出来。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, resolveTheme, watchSystemTheme } from "../theme";

type MediaListener = (event: MediaQueryListEvent) => void;

/// 装一个可控的 matchMedia。返回改变系统偏好并通知监听者的开关。
function installMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<MediaListener>();

  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("dark") ? dark : !dark;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));

  return {
    set(next: boolean) {
      dark = next;
      for (const listener of listeners) {
        listener({ matches: dark } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("显式两档不看系统偏好", () => {
    installMatchMedia(false);
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("system 跟随系统偏好，两个方向都要对", () => {
    const media = installMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");

    media.set(false);
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("深色加 dark class，浅色去掉", () => {
    installMatchMedia(false);

    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("同时设置 colorScheme，让原生控件跟着走", () => {
    installMatchMedia(false);

    applyTheme("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("system 在浅色系统上应用浅色", () => {
    installMatchMedia(false);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system 在深色系统上应用深色", () => {
    installMatchMedia(true);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("watchSystemTheme", () => {
  it("系统偏好变化时回调，注销后不再回调", () => {
    const media = installMatchMedia(true);
    const onChange = vi.fn();

    const unsubscribe = watchSystemTheme(onChange);
    media.set(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(media.listenerCount()).toBe(0);

    media.set(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("环境没有 matchMedia 时返回一个空注销函数而不是抛错", () => {
    vi.stubGlobal("matchMedia", undefined);
    const unsubscribe = watchSystemTheme(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});
