import { expect, it } from "vitest";
import { normalizeProfileScan } from "../normalize";
import { makeProfileScan } from "@/test/harness";

it("preserves actionable archives through scan normalization", () => {
  const archive = { name: "old__2026", archived: true, linked: false, nonStandardReference: false, accountIds: [], accountLabels: [], busy: false, bytes: 25, files: 1, cacheBytes: 0, cacheFiles: 0 };
  const scan = normalizeProfileScan({ ...makeProfileScan(), archives: [archive] });
  expect(scan?.archives).toEqual([archive]);
  expect(normalizeProfileScan({ ...makeProfileScan(), archives: [{}] })).toBeNull();
});
