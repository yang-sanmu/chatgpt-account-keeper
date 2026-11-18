// Preserve the application's pre-environment-management language default.
// The absence of a timezone override means Chrome decides it, not Node's ICU.
export const DEFAULT_BROWSER_LOCALE = "zh-CN";

export function inheritedEnvironment(accountId) {
  return Object.freeze({ accountId, mode: "inherit", locale: null, timezone: null, version: 0, updatedAt: null });
}

export function normalizeLocale(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

export function normalizeTimezone(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const trimmed = value.trim();
  if (!trimmed || /^[+-]/u.test(trimmed)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: trimmed }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function validateFixedEnvironment(input) {
  const invalid = () => Object.assign(new Error("请提供有效的语言标签与 IANA 时区，例如 zh-CN 和 Asia/Shanghai"), { statusCode: 400 });
  const locale = normalizeLocale(input?.locale);
  const timezone = normalizeTimezone(input?.timezone);
  if (!locale || !timezone) throw invalid();
  return Object.freeze({ mode: "fixed", locale, timezone });
}

export function environmentSnapshot({ account, environment, group, region = {} }) {
  const fixed = environment.mode === "fixed";
  const source = fixed ? "account" : group?.tzManual ? "group_manual" : "group_auto";
  return Object.freeze({ mode: environment.mode, version: environment.version,
    groupId: fixed ? null : account.groupId ?? null,
    locale: (fixed ? environment.locale : region.locale) || DEFAULT_BROWSER_LOCALE,
    timezoneId: (fixed ? environment.timezone : region.timezoneId) || null,
    localeSource: fixed || region.locale ? source : "application_default",
    timezoneSource: fixed || region.timezoneId ? source : "browser_default" });
}

export function environmentPending(current, next) {
  return ["mode", "version", "groupId", "locale", "timezoneId"].some(key => current[key] !== next[key]);
}
