// 主题应用。
//
// 深色是默认，浅色是一等公民的第二套，system 跟随操作系统。三档都要在设置页可选。
//
// 单独一个模块而不是写在 store 里：这是 DOM 副作用，且首帧就要生效。放到 React effect 里
// 会先按 HTML 的初始 class 渲染一帧再切换，在浅色系统上表现为一次深色闪屏。

import type { AppTheme } from "@/ipc/types";

const DARK_CLASS = "dark";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(SYSTEM_QUERY).matches
    : true;
}

/// 解析出最终该用深色还是浅色。
export function resolveTheme(theme: AppTheme): "dark" | "light" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark() ? "dark" : "light";
}

export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, resolveTheme(theme) === "dark");
  // 让原生控件（滚动条、日期选择器、右键菜单）跟着走。
  root.style.colorScheme = resolveTheme(theme);
}

/// 订阅系统主题变化，只在 theme 为 system 时有意义。返回取消订阅函数。
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(SYSTEM_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
