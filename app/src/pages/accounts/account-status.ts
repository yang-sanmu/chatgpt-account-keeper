// 账号状态的显示映射。
//
// `Account.status` 在契约里是开放字符串（Agent 可能加新值），所以这里必须能处理没见过的
// 状态：原样显示那个字符串，而不是统一塌缩成「未知」。塌缩会让一个新增的状态在界面上
// 与真正的 unknown 无法区分，排查时看不出发生了什么。

import type { StatusDotProps } from "@/components/ui/status-dot";

type DotStatus = NonNullable<StatusDotProps["status"]>;

const STATUS_LABELS: Record<string, string> = {
  ok: "正常",
  needs_login: "需要登录",
  waf: "风控隔离",
  unknown: "未知",
};

const STATUS_DOTS: Record<string, DotStatus> = {
  ok: "ok",
  needs_login: "needs_login",
  waf: "waf",
  unknown: "unknown",
};

export interface AccountStatusDisplay {
  dot: DotStatus;
  label: string;
}

/// 把账号状态收敛成一个色点 + 一段中文。
///
/// enabled 优先于 status：一个已停用的账号不参与调度，此时它的巡检状态是次要信息 ——
/// 只显示「正常」会让用户以为它在跑。
export function describeAccountStatus(
  status: string,
  options: { stale: boolean; enabled: boolean }
): AccountStatusDisplay {
  if (!options.enabled) {
    const underlying = STATUS_LABELS[status] ?? status;
    return { dot: "disabled", label: `已停用 · ${underlying}` };
  }

  const label = STATUS_LABELS[status] ?? status;
  return {
    dot: STATUS_DOTS[status] ?? "unknown",
    label: options.stale ? `${label} · 待复核` : label,
  };
}
