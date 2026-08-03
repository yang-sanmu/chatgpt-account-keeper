export const DEFAULT_STATUS_CHECK_MINUTES = 15;
export const MAX_STATUS_CHECK_MINUTES = 7 * 24 * 60;
export const DEFAULT_SETTINGS = Object.freeze({
  intervalMinutes: 180,
  jitterMinutes: 30,
  headless: true,
  statusCheckMinutes: DEFAULT_STATUS_CHECK_MINUTES,
  statusCheckOnStartup: true,
  openPageTimeoutMinutes: 0,
});

const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);
const KNOWN_SETTINGS = new Set([
  "intervalMinutes",
  "jitterMinutes",
  "headless",
  "statusCheckMinutes",
  "statusCheckOnStartup",
  "openPageTimeoutMinutes",
]);

export function safeStatusCheckMinutes(value) {
  return safeMinutes(value, 1, DEFAULT_STATUS_CHECK_MINUTES);
}

function safeMinutes(value, min, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_STATUS_CHECK_MINUTES, Math.max(min, value));
}

export function normalizeSettings(value) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    intervalMinutes: safeMinutes(
      input.intervalMinutes,
      1,
      DEFAULT_SETTINGS.intervalMinutes
    ),
    jitterMinutes: safeMinutes(
      input.jitterMinutes,
      0,
      DEFAULT_SETTINGS.jitterMinutes
    ),
    headless:
      typeof input.headless === "boolean"
        ? input.headless
        : DEFAULT_SETTINGS.headless,
    statusCheckMinutes: safeStatusCheckMinutes(input.statusCheckMinutes),
    statusCheckOnStartup:
      typeof input.statusCheckOnStartup === "boolean"
        ? input.statusCheckOnStartup
        : DEFAULT_SETTINGS.statusCheckOnStartup,
    openPageTimeoutMinutes: safeMinutes(
      input.openPageTimeoutMinutes,
      0,
      DEFAULT_SETTINGS.openPageTimeoutMinutes
    ),
  };
}

function validateFiniteMinutes(patch, key, min) {
  if (!hasOwn(patch, key)) return null;
  const value = patch[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > MAX_STATUS_CHECK_MINUTES
  ) {
    return `${key} 必须是 ${min} 到 ${MAX_STATUS_CHECK_MINUTES} 之间的有限数字`;
  }
  return null;
}

export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return "设置内容必须是 JSON 对象";
  }

  const unknownKey = Object.keys(patch).find((key) => !KNOWN_SETTINGS.has(key));
  if (unknownKey) return `未知设置字段：${unknownKey}`;

  for (const key of ["headless", "statusCheckOnStartup"]) {
    if (hasOwn(patch, key) && typeof patch[key] !== "boolean") {
      return `${key} 必须是布尔值`;
    }
  }

  for (const [key, min] of [
    ["intervalMinutes", 1],
    ["jitterMinutes", 0],
    ["statusCheckMinutes", 1],
    ["openPageTimeoutMinutes", 0],
  ]) {
    const error = validateFiniteMinutes(patch, key, min);
    if (error) return error;
  }

  return null;
}
