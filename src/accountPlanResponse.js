export const ACCOUNTS_CHECK_PATH = "/backend-api/accounts/check/v4-2023-04-27";

export function parseAccountPlan(payload, accountId) {
  const accounts = payload?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  const entries = Object.entries(accounts).filter(([key]) => key !== "default");
  const fallback = accounts.default ?? (entries.length === 1 ? entries[0][1] : null);
  const item = accountId
    ? (Object.hasOwn(accounts, accountId) ? accounts[accountId] : null) ??
      (fallback?.account?.account_id === accountId ? fallback : null)
    : fallback;
  const plan = item?.account?.plan_type || item?.entitlement?.subscription_plan;
  if (typeof plan !== "string" || !/^[a-z\d_-]{1,64}$/iu.test(plan)) return null;
  const planType = plan.toLowerCase();
  const discountPercentage = ["free", "chatgptfreeplan"].includes(planType)
    ? item.eligible_promo_campaigns?.plus?.metadata?.discount?.percentage ?? null
    : null;
  return { planType, discountPercentage };
}
