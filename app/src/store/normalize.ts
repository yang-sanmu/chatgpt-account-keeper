// Agent 原始 JSON 的窄化函数。
//
// 这些结构跨进程传来，字段可能缺、可能是 null、也可能类型不对。宁可返回 null 让界面显示
// 「取不到」，也不要把半成品塞进状态里等渲染时炸 —— 后者的错误现场离成因很远。

import type { ProfileInfo, ProfileScanResult, SchedulerState } from "@/ipc/types";
import type { SchedulerAccountState } from "@/ipc/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isProfileInfo(value: unknown): value is ProfileInfo {
  const raw = asRecord(value);
  if (!raw) return false;
  return (
    typeof raw.name === "string" &&
    raw.name.length > 0 &&
    typeof raw.linked === "boolean" &&
    isStringArray(raw.accountIds) &&
    isStringArray(raw.accountLabels) &&
    typeof raw.nonStandardReference === "boolean" &&
    typeof raw.busy === "boolean" &&
    isNonNegativeInteger(raw.bytes) &&
    isNonNegativeInteger(raw.files) &&
    isNonNegativeInteger(raw.cacheBytes) &&
    isNonNegativeInteger(raw.cacheFiles)
  );
}

const SCAN_TOTAL_KEYS = [
  "profiles",
  "linked",
  "orphans",
  "bytes",
  "cacheBytes",
  "orphanBytes",
  "archiveCount",
  "archiveBytes",
  "trashCount",
  "trashBytes",
] as const;

/// 窄化 profiles.scan 的结果。
///
/// 任何字段缺失或类型不符一律返回 null：Profile 页据此显示「扫描失败」而不是「没有
/// Profile」。这两句话对一台有 47 个 Profile 的机器意义完全不同。
export function normalizeProfileScan(raw: unknown): ProfileScanResult | null {
  const source = asRecord(raw);
  if (!source) return null;
  if (!Array.isArray(source.profiles) || !Array.isArray(source.orphans)) return null;
  if (!source.profiles.every(isProfileInfo)) return null;
  if (!source.orphans.every(isProfileInfo)) return null;

  const totals = asRecord(source.totals);
  if (!totals) return null;

  const narrowed: Record<string, number> = {};
  for (const key of SCAN_TOTAL_KEYS) {
    const value = totals[key];
    if (!isNonNegativeInteger(value)) return null;
    narrowed[key] = value;
  }

  return {
    profiles: source.profiles,
    orphans: source.orphans,
    totals: {
      profiles: narrowed.profiles!,
      linked: narrowed.linked!,
      orphans: narrowed.orphans!,
      bytes: narrowed.bytes!,
      cacheBytes: narrowed.cacheBytes!,
      orphanBytes: narrowed.orphanBytes!,
      archiveCount: narrowed.archiveCount!,
      archiveBytes: narrowed.archiveBytes!,
      trashCount: narrowed.trashCount!,
      trashBytes: narrowed.trashBytes!,
    },
  };
}

/// 窄化调度状态。
///
/// Agent 的字段名与界面用的名字不一致（nextAt / lastAt vs nextRunAt / lastRunAt），
/// 且每账号的运行结果放在另一个 lastResults 映射里，这里合并成一份。
export function normalizeScheduler(raw: unknown): SchedulerState {
  const source = asRecord(raw);
  if (!source) return { running: false, enabled: false, accounts: {} };

  const rawAccounts = asRecord(source.accounts) ?? {};
  const rawResults = asRecord(source.lastResults) ?? {};
  const accounts: Record<string, SchedulerAccountState> = {};

  for (const [id, value] of Object.entries(rawAccounts)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const result = asRecord(rawResults[id]);

    accounts[id] = {
      nextRunAt: typeof entry.nextAt === "string" ? entry.nextAt : null,
      lastRunAt: typeof entry.lastAt === "string" ? entry.lastAt : null,
      lastRunOk: result && typeof result.ok === "boolean" ? result.ok : null,
      reason: result && typeof result.reason === "string" ? result.reason : null,
      busy: entry.busy === true,
    };
  }

  return {
    running: source.running === true,
    enabled: source.enabled === true,
    accounts,
    lastResults: rawResults,
    message: typeof source.message === "string" ? source.message : undefined,
  };
}
