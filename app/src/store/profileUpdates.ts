import type { Operation, ProfileInfo, ProfileScanResult } from "@/ipc/types";

interface CleanResult {
  profilesCleaned?: number;
  freedBytes?: number;
  freedFiles?: number;
  skipped?: Array<{ name?: string }>;
  scope?: "all" | "linked" | "orphan";
}

function withRecomputedTotals(
  scan: ProfileScanResult,
  profiles: ProfileInfo[],
  archives: ProfileInfo[],
): ProfileScanResult {
  const orphans = profiles.filter((profile) => !profile.linked);
  const sum = (items: ProfileInfo[], field: "bytes" | "cacheBytes") =>
    items.reduce((total, profile) => total + profile[field], 0);
  return {
    ...scan,
    profiles,
    orphans,
    archives,
    totals: {
      ...scan.totals,
      profiles: profiles.length,
      linked: profiles.length - orphans.length,
      orphans: orphans.length,
      bytes: sum(profiles, "bytes"),
      cacheBytes: sum(profiles, "cacheBytes"),
      orphanBytes: sum(orphans, "bytes"),
      archiveCount: archives.length,
      archiveBytes: sum(archives, "bytes"),
    },
  };
}

function applyCacheClean(
  scan: ProfileScanResult,
  operation: Operation,
): ProfileScanResult {
  const result = operation.result as CleanResult | null;
  if (!result || (result.profilesCleaned ?? 0) <= 0) return scan;

  const skipped = new Set(
    (result.skipped ?? [])
      .map((item) => item.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const targetName = operation.resourceId;
  let remainingFreedBytes = Math.max(0, result.freedBytes ?? 0);
  let remainingFreedFiles = Math.max(0, result.freedFiles ?? 0);

  const profiles = scan.profiles.map((profile) => {
    if (profile.archived || skipped.has(profile.name)) return profile;
    if (targetName && profile.name !== targetName) return profile;
    if (!targetName && result.scope === "linked" && !profile.linked) return profile;
    if (!targetName && result.scope === "orphan" && profile.linked) return profile;

    // 清理会完整移除该 Profile 已统计的可重建缓存目录。单条操作优先采用后端的
    // 实际释放量；批量操作没有逐项明细，使用扫描时的 cacheBytes 做确定性扣减。
    const freedBytes = targetName
      ? Math.min(profile.cacheBytes, remainingFreedBytes)
      : profile.cacheBytes;
    const freedFiles = targetName
      ? Math.min(profile.cacheFiles, remainingFreedFiles)
      : profile.cacheFiles;
    remainingFreedBytes -= freedBytes;
    remainingFreedFiles -= freedFiles;
    return {
      ...profile,
      bytes: Math.max(0, profile.bytes - freedBytes),
      files: Math.max(0, profile.files - freedFiles),
      cacheBytes: 0,
      cacheFiles: 0,
    };
  });
  return withRecomputedTotals(scan, profiles, scan.archives ?? []);
}

// Profile 操作的结果足以更新当前目录快照；无需为了移动或删除一项再次递归扫描全部目录。
export function applyProfileOperation(
  scan: ProfileScanResult | null,
  operation: Operation,
): ProfileScanResult | null {
  if (!scan || operation.state !== "succeeded") return scan;
  if (operation.kind === "profile-cache-clean") {
    return applyCacheClean(scan, operation);
  }
  const archive = operation.kind === "profile-orphan-archive";
  const restore = operation.kind === "profile-archive-restore";
  const purge = operation.kind === "profile-orphan-purge" || operation.kind === "profile-archive-purge";
  if (!archive && !restore && !purge) return scan;
  const fromArchive = restore || operation.kind === "profile-archive-purge";
  const source = fromArchive ? scan.archives ?? [] : scan.profiles;
  const previous = source.find((profile) => profile.name === operation.resourceId);
  if (!previous) return scan;
  const result = operation.result as { name?: string; accountIds?: string[]; accountLabels?: string[] } | null;
  if ((archive || restore) && !result?.name) return scan;
  let profiles = fromArchive ? scan.profiles : scan.profiles.filter((p) => p.name !== previous.name);
  let archives = fromArchive ? (scan.archives ?? []).filter((p) => p.name !== previous.name) : scan.archives ?? [];
  if (archive || restore) {
    const accountIds = restore ? result?.accountIds ?? [] : [];
    const moved: ProfileInfo = {
      ...previous, name: result!.name!, archived: archive, linked: accountIds.length > 0,
      accountIds, accountLabels: restore ? result?.accountLabels ?? [] : [],
    };
    if (archive) archives = [...archives, moved];
    else profiles = [...profiles, moved];
  }
  return withRecomputedTotals(scan, profiles, archives);
}

interface AccountProfileResult {
  action?: "detach" | "archive" | "purge";
  name?: string;
  archived?: boolean;
  deleted?: boolean;
  missing?: boolean;
}

export function applyAccountProfileRemoval(
  scan: ProfileScanResult | null,
  accountId: string,
  rawResult: unknown,
): ProfileScanResult | null {
  if (!scan || !rawResult || typeof rawResult !== "object") return scan;
  const result = rawResult as AccountProfileResult;
  const source = scan.profiles.find((profile) => profile.accountIds.includes(accountId));
  if (!source) return scan;

  const accountIndex = source.accountIds.indexOf(accountId);
  const detached: ProfileInfo = {
    ...source,
    linked: source.accountIds.length > 1,
    accountIds: source.accountIds.filter((id) => id !== accountId),
    accountLabels: source.accountLabels.filter((_label, index) => index !== accountIndex),
  };
  if (result.action === "purge" && (result.deleted || result.missing)) {
    return withRecomputedTotals(
      scan,
      scan.profiles.filter((profile) => profile.name !== source.name),
      scan.archives ?? [],
    );
  }
  if (result.action === "archive" && result.archived && result.name) {
    return withRecomputedTotals(
      scan,
      scan.profiles.filter((profile) => profile.name !== source.name),
      [...(scan.archives ?? []), {
        ...detached,
        name: result.name,
        archived: true,
        linked: false,
        accountIds: [],
        accountLabels: [],
      }],
    );
  }
  // detach，或永久删除在落盘后失败并恢复成孤儿目录：账号关联消失，但目录仍在。
  return withRecomputedTotals(
    scan,
    scan.profiles.map((profile) => profile.name === source.name ? detached : profile),
    scan.archives ?? [],
  );
}
