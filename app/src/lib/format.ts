// 数据展示的格式化。
//
// 相对时间与绝对时间**成对出现**是有意的：只显示「3 分钟前」时用户无法判断这是哪一次
// 巡检的结果，只显示时间戳又要自己算多久以前。界面上通常一个当正文、一个进 title。

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/// 脱敏邮箱。默认全部账号隐藏，用户可在账号页一键全部展示。
export function maskEmail(email: string | null | undefined): string {
  if (!email || email.trim().length === 0) return "未登录";

  const at = email.indexOf("@");
  if (at <= 0) {
    return email.length <= 4 ? email : `${email.slice(0, 2)}***${email.slice(-2)}`;
  }

  const user = email.slice(0, at);
  const domain = email.slice(at + 1);

  const maskedUser =
    user.length <= 2 ? `${user[0]}***` : `${user.slice(0, 2)}***${user.slice(-1)}`;

  const dot = domain.lastIndexOf(".");
  if (dot <= 0) {
    const maskedBare =
      domain.length <= 2 ? "***" : `${domain[0]}***${domain.slice(-1)}`;
    return `${maskedUser}@${maskedBare}`;
  }

  const name = domain.slice(0, dot);
  const tld = domain.slice(dot);
  const maskedName =
    name.length <= 2 ? `${name[0]}***` : `${name[0]}***${name.slice(-1)}`;

  return `${maskedUser}@${maskedName}${tld}`;
}

/// 按开关决定显示明文还是脱敏。集中在一处，避免各页面各写一遍三元表达式。
export function displayEmail(
  email: string | null | undefined,
  revealed: boolean
): string {
  if (!email || email.trim().length === 0) return "未登录";
  return revealed ? email : maskEmail(email);
}

/// 相对时间，如「4 天后」「10 分钟前」。取不到时间返回「未安排」。
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "未安排";

  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return iso;

  const delta = target - Date.now();
  const future = delta > 0;
  const abs = Math.abs(delta);

  if (abs < MINUTE_MS) return future ? "即将开始" : "刚刚";

  if (abs < HOUR_MS) {
    const minutes = Math.floor(abs / MINUTE_MS);
    return future ? `${minutes} 分钟后` : `${minutes} 分钟前`;
  }

  if (abs < DAY_MS) {
    const hours = Math.floor(abs / HOUR_MS);
    const minutes = Math.floor((abs % HOUR_MS) / MINUTE_MS);
    const tail = minutes > 0 ? ` ${minutes} 分` : "";
    return future ? `${hours} 小时${tail}后` : `${hours} 小时前`;
  }

  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / HOUR_MS);
  const tail = hours > 0 ? ` ${hours} 小时` : "";
  return future ? `${days} 天${tail}后` : `${days} 天前`;
}

/// 绝对时间戳，如「2026-08-27 14:11」。
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/// 只要日期部分，用于历史记录按天分组。
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/// 磁盘占用，如「2.6 GB」。
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/// 缩短 ID 用于展示，保留头尾以便与日志比对。
export function shortId(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return "—";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/// 时长，用于「已运行 3 分 20 秒」。
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
