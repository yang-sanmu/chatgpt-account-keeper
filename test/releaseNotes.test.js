import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReleaseNotes } from "../scripts/write-release-notes.mjs";

test("release notes normalize line endings and require a user-facing summary", () => {
  assert.equal(normalizeReleaseNotes("  # 0.2.0\r\n\r\n- 修复更新体验  "), "# 0.2.0\n\n- 修复更新体验\n");
  assert.throws(() => normalizeReleaseNotes(" \r\n "), /release_notes/);
});
