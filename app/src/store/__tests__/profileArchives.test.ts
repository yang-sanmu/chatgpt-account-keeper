import { describe, expect, it } from "vitest";
import { normalizeProfileScan } from "../normalize";
import { applyAccountProfileRemoval, applyProfileOperation } from "../profileUpdates";
import { makeOperation, makeProfileInfo, makeProfileScan } from "@/test/harness";

it("preserves actionable archives through scan normalization", () => {
  const archive = { name: "old__2026", archived: true, linked: false, nonStandardReference: false, accountIds: [], accountLabels: [], busy: false, bytes: 25, files: 1, cacheBytes: 0, cacheFiles: 0 };
  const scan = normalizeProfileScan({ ...makeProfileScan(), archives: [archive] });
  expect(scan?.archives).toEqual([archive]);
  expect(normalizeProfileScan({ ...makeProfileScan(), archives: [{}] })).toBeNull();
});

describe("Profile cache updates", () => {
  it("uses a successful single-profile clean result without rescanning", () => {
    const linked = makeProfileInfo({
      name: "linked",
      linked: true,
      bytes: 1_000,
      files: 20,
      cacheBytes: 300,
      cacheFiles: 5,
    });
    const scan = normalizeProfileScan(makeProfileScan({ profiles: [linked], orphans: [] }))!;
    const next = applyProfileOperation(scan, makeOperation({
      kind: "profile-cache-clean",
      resourceId: "linked",
      state: "succeeded",
      result: { profilesCleaned: 1, freedBytes: 300, freedFiles: 5, skipped: [] },
    }));

    expect(next?.profiles[0]).toMatchObject({
      bytes: 700,
      files: 15,
      cacheBytes: 0,
      cacheFiles: 0,
    });
    expect(next?.totals.cacheBytes).toBe(0);
  });

  it("respects scope for a bulk clean", () => {
    const linked = makeProfileInfo({ name: "linked", linked: true, bytes: 500, cacheBytes: 100 });
    const orphan = makeProfileInfo({ name: "orphan", linked: false, bytes: 600, cacheBytes: 200 });
    const scan = normalizeProfileScan(makeProfileScan({ profiles: [linked, orphan], orphans: [orphan] }))!;
    const next = applyProfileOperation(scan, makeOperation({
      kind: "profile-cache-clean",
      resourceId: null,
      state: "succeeded",
      result: { profilesCleaned: 1, freedBytes: 100, scope: "linked", skipped: [] },
    }));

    expect(next?.profiles.find((profile) => profile.name === "linked")?.cacheBytes).toBe(0);
    expect(next?.profiles.find((profile) => profile.name === "orphan")?.cacheBytes).toBe(200);
    expect(next?.totals.cacheBytes).toBe(200);
  });
});

describe("account-centered Profile lifecycle", () => {
  it("removes a purged account Profile from an existing storage snapshot", () => {
    const profile = makeProfileInfo({
      name: "acc-1",
      linked: true,
      accountIds: ["acc-1"],
      accountLabels: ["user@example.com"],
      bytes: 1_000,
    });
    const scan = normalizeProfileScan(makeProfileScan({ profiles: [profile], orphans: [] }))!;

    const next = applyAccountProfileRemoval(scan, "acc-1", {
      action: "purge",
      deleted: true,
    });

    expect(next?.profiles).toEqual([]);
    expect(next?.totals.profiles).toBe(0);
    expect(next?.totals.bytes).toBe(0);
  });

  it("turns a retained Profile into an orphan when only the account is detached", () => {
    const profile = makeProfileInfo({
      name: "acc-1",
      linked: true,
      accountIds: ["acc-1"],
      accountLabels: ["user@example.com"],
    });
    const scan = normalizeProfileScan(makeProfileScan({ profiles: [profile], orphans: [] }))!;

    const next = applyAccountProfileRemoval(scan, "acc-1", { action: "detach" });

    expect(next?.profiles[0]).toMatchObject({ linked: false, accountIds: [], accountLabels: [] });
    expect(next?.orphans).toHaveLength(1);
  });
});
