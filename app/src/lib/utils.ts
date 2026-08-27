// shadcn/ui 约定的类名合并工具。
//
// clsx 负责条件拼接，tailwind-merge 负责让后写的 Tailwind 类真的覆盖前面的同族类
// （没有它，`className` 传入的 `p-2` 不会覆盖组件内置的 `p-4`，因为 CSS 里两者优先级
// 相同、胜负只看声明顺序）。

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
