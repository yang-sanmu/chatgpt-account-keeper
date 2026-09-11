import type { Operation, ProfileInfo, ProfileScanResult } from "@/ipc/types";

// Move/remove the affected row immediately; a background scan refreshes byte counts.
export function applyProfileOperation(scan: ProfileScanResult | null, operation: Operation): ProfileScanResult | null {
  if (!scan || operation.state !== "succeeded") return scan;
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
  const orphans = profiles.filter((p) => !p.linked);
  const sum = (items: ProfileInfo[], field: "bytes" | "cacheBytes") => items.reduce((total, p) => total + p[field], 0);
  return {
    ...scan, profiles, orphans, archives,
    totals: {
      ...scan.totals, profiles: profiles.length, linked: profiles.length - orphans.length,
      orphans: orphans.length, bytes: sum(profiles, "bytes"), cacheBytes: sum(profiles, "cacheBytes"),
      orphanBytes: sum(orphans, "bytes"), archiveCount: archives.length, archiveBytes: sum(archives, "bytes"),
    },
  };
}
