import type { AccountCheckResult, Operation } from "@/ipc/types";

export const ACCOUNT_CHECK_KINDS = {
  inspection: "account-inspection",
  plan: "account-plan-check",
  singlePlan: "account-plan-check-single",
  promo: "account-promo-check",
} as const;

export function isAccountCheckPending(operation: Operation) {
  return operation.state === "queued" || operation.state === "running" || operation.state === "waiting_user";
}

export function accountCheckResult(operation?: Operation): AccountCheckResult | undefined {
  if (!operation || !Object.values(ACCOUNT_CHECK_KINDS).some((kind) => kind === operation.kind)) return undefined;
  return (operation.result as AccountCheckResult | null) ?? undefined;
}
