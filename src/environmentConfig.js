// Preserve the application's pre-environment-management language default.
// The absence of a timezone override means Chrome decides it, not Node's ICU.
export const DEFAULT_BROWSER_LOCALE = "zh-CN";

export function inheritedEnvironment(accountId) {
  return Object.freeze({ accountId, mode: "inherit", locale: null, timezone: null, version: 0, updatedAt: null });
}

export function validateFixedEnvironment(input) {
  const invalid = () => Object.assign(new Error("请提供有效的语言标签与 IANA 时区，例如 zh-CN 和 Asia/Shanghai"), { statusCode: 400 });
  if (!input || typeof input.locale !== "string" || typeof input.timezone !== "string"
    || input.locale.length > 80 || input.timezone.length > 80 || /^[+-]/u.test(input.timezone)) throw invalid();
  try {
    const locale = Intl.getCanonicalLocales(input.locale.trim())[0];
    const timezone = new Intl.DateTimeFormat("en", { timeZone: input.timezone.trim() }).resolvedOptions().timeZone;
    if (!locale || !input.timezone.trim()) throw invalid();
    return Object.freeze({ mode: "fixed", locale, timezone });
  } catch { throw invalid(); }
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
