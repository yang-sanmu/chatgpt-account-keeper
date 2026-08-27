// profiles.cleanCache 的结果窄化。
//
// 形状来自 src/profileManager.js 的 cleanCache：
// `{ profilesCleaned, freedBytes, freedFiles, skipped: [{ name, reason }] }`。
// 契约把操作结果声明为任意 JSON，所以这里必须自己验，不能断言。
//
// 拿不到可识别字段时返回 null，界面据此只陈述「已完成」——不能顺口说成「已清理全部缓存」。
// 那句话在结果实际是「全部跳过（Profile 正被占用）」时是错的，而用户会据此以为磁盘已经
// 腾出来了。

export interface CleanCacheOutcome {
  profilesCleaned: number;
  freedBytes: number;
  /// 被跳过的 Profile 及原因。占用中的条目会落在这里，不是失败。
  skipped: { name: string; reason: string }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function narrowSkipped(value: unknown): { name: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const raw = asRecord(entry);
    if (!raw) return [];
    return [
      {
        name: typeof raw.name === "string" ? raw.name : "未知 Profile",
        reason: typeof raw.reason === "string" ? raw.reason : "正被占用",
      },
    ];
  });
}

export function narrowCleanCacheResult(raw: unknown): CleanCacheOutcome | null {
  const source = asRecord(raw);
  if (!source) return null;

  // profilesCleaned 是唯一的必需字段：没有它就无法判断到底清了几个，
  // 任何关于结果的断言都会变成猜测。
  if (typeof source.profilesCleaned !== "number" || !Number.isFinite(source.profilesCleaned)) {
    return null;
  }

  return {
    profilesCleaned: source.profilesCleaned,
    freedBytes:
      typeof source.freedBytes === "number" && Number.isFinite(source.freedBytes)
        ? source.freedBytes
        : 0,
    skipped: narrowSkipped(source.skipped),
  };
}
