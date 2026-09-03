// 账号状态的显示映射。
//
// Agent 实际只发四个值（见 src/health.js）：
//   ok      会话可用
//   reauth  有会话但需要重新认证
//   out     未登录
//   unknown 有 token 但后端鉴权既没明确成功也没明确失败（网络抖动、限流、5xx）
//
// 界面此前按 `needs_login` / `waf` 来判断，那两个名字 Agent 从来不发 —— 所以「需要登录」
// 的筛选项永远筛不出东西，总览的健康度统计里真正掉线的账号全落进「其它」。
//
// `Account.status` 在契约里仍是开放字符串（Agent 可能加新值），所以查不到的值原样显示，
// 不塌缩成「未知」：塌缩会让新增状态与真正的 unknown 无法区分。

import type { StatusDotProps } from "@/components/ui/status-dot";
import type { PromoEligibility } from "@/ipc/types";

type DotStatus = NonNullable<StatusDotProps["status"]>;

/// Agent 会发的账号状态。
export const ACCOUNT_STATES = ["ok", "reauth", "out", "unknown"] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

const STATUS_LABELS: Record<string, string> = {
  ok: "正常",
  reauth: "需重新登录",
  out: "未登录",
  unknown: "无法确认",
};

const STATUS_DOTS: Record<string, DotStatus> = {
  ok: "ok",
  // reauth 用 warn 而不是 danger：会话还在，只是要重登一次，属于可修复的待办。
  reauth: "needs_login",
  // out 是真的掉了，需要完整登录流程。
  out: "waf",
  unknown: "unknown",
};

/// 状态是否需要用户处理。决定卡片上「强制重登」按钮是否出现。
export function statusNeedsAttention(status: string): boolean {
  return status === "reauth" || status === "out";
}

export interface AccountStatusDisplay {
  dot: DotStatus;
  label: string;
}

export const PROMO_LABELS: Record<Exclude<PromoEligibility, "none">, string> = {
  free_trial: "免费试用",
  half_price: "半价优惠",
  both: "免费试用 + 半价优惠",
};

function promoStatusLabel(
  eligibility: PromoEligibility | null | undefined,
  stale: boolean | undefined
): string | null {
  if (!eligibility || eligibility === "none") return null;
  const label = PROMO_LABELS[eligibility];
  return stale ? `${label}（待复核）` : label;
}

/// 把账号状态收敛成一个色点 + 一段中文。
///
/// enabled 优先于 status：一个已停用的账号不参与调度，此时它的巡检状态是次要信息 ——
/// 只显示「正常」会让用户以为它在跑。
export function describeAccountStatus(
  status: string,
  options: {
    stale: boolean;
    enabled: boolean;
    promoEligibility?: PromoEligibility | null;
    promoStale?: boolean;
  }
): AccountStatusDisplay {
  const promo = promoStatusLabel(options.promoEligibility, options.promoStale);
  if (!options.enabled) {
    const underlying = STATUS_LABELS[status] ?? status;
    return {
      dot: "disabled",
      label: ["已停用", underlying, promo].filter(Boolean).join(" · "),
    };
  }

  const label = [
    STATUS_LABELS[status] ?? status,
    options.stale ? "待复核" : null,
    promo,
  ].filter(Boolean).join(" · ");
  return {
    dot: STATUS_DOTS[status] ?? "unknown",
    label,
  };
}

/// 健康度分档。总览的统计与账号页的筛选共用，避免两处各写一套判断而对不上。
export type HealthBucket = "ok" | "reauth" | "out" | "unknown" | "disabled";

export function healthBucketOf(account: {
  enabled: boolean;
  status: string;
}): HealthBucket {
  if (!account.enabled) return "disabled";
  if (account.status === "ok") return "ok";
  if (account.status === "reauth") return "reauth";
  if (account.status === "out") return "out";
  return "unknown";
}

export const HEALTH_LABELS: Record<HealthBucket, string> = {
  ok: "正常",
  reauth: "需重登",
  out: "未登录",
  unknown: "无法确认",
  disabled: "已停用",
};
