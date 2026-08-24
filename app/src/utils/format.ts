// 通用数据展示格式化工具

// 脱敏邮箱展示：如 ba***7@i***d.com
export function maskEmail(email: string | null | undefined): string {
  if (!email || email.trim().length === 0) {
    return "未登录";
  }

  const atIndex = email.indexOf("@");
  if (atIndex <= 0) {
    // 非标准邮箱做简单遮蔽
    if (email.length <= 4) return email;
    return `${email.slice(0, 2)}***${email.slice(-2)}`;
  }

  const username = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  const maskedUser =
    username.length <= 2
      ? `${username[0]}***`
      : `${username.slice(0, 2)}***${username.slice(-1)}`;

  const domainDotIndex = domain.lastIndexOf(".");
  let maskedDomain = domain;
  if (domainDotIndex > 0) {
    const domainName = domain.slice(0, domainDotIndex);
    const domainExt = domain.slice(domainDotIndex);
    const mDomain =
      domainName.length <= 2
        ? `${domainName[0]}***`
        : `${domainName.slice(0, 1)}***${domainName.slice(-1)}`;
    maskedDomain = `${mDomain}${domainExt}`;
  } else {
    maskedDomain = domain.length <= 2 ? "***" : `${domain[0]}***${domain.slice(-1)}`;
  }

  return `${maskedUser}@${maskedDomain}`;
}

// 格式化相对时间（如 "4 天后"、"10 分钟前"）
export function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return "未安排";

  try {
    const target = new Date(isoString).getTime();
    if (isNaN(target)) return isoString;

    const now = Date.now();
    const diffMs = target - now;
    const isFuture = diffMs > 0;
    const absDiff = Math.abs(diffMs);

    const minutes = Math.floor(absDiff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      const remHours = hours % 24;
      if (remHours > 0) {
        return isFuture ? `${days}天 ${remHours}小时后` : `${days}天前`;
      }
      return isFuture ? `${days} 天后` : `${days} 天前`;
    }

    if (hours > 0) {
      const remMinutes = minutes % 60;
      if (remMinutes > 0) {
        return isFuture ? `${hours}小时 ${remMinutes}分后` : `${hours}小时前`;
      }
      return isFuture ? `${hours} 小时后` : `${hours} 小时前`;
    }

    if (minutes > 0) {
      return isFuture ? `${minutes} 分钟后` : `${minutes} 分钟前`;
    }

    return isFuture ? "即将运行" : "刚刚";
  } catch {
    return isoString;
  }
}

// 格式化绝对时间戳（如 "2026-08-27 14:11"）
export function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return "-";

  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;

    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());

    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return isoString;
  }
}

// 格式化文件字节大小（如 "2.6 GB", "14.2 MB"）
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || isNaN(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let unitIndex = 0;

  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }

  return `${val.toFixed(val >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
