import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyReleaseVersion } from "../scripts/verify-release-version.mjs";

test("release version gate checks package, lock root and desktop project", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-release-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "desktop", "src", "GptAccountKeeper.Desktop");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2.3.4" }));
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ version: "2.3.4", packages: { "": { version: "2.3.4" } } }),
  );
  fs.writeFileSync(
    path.join(projectRoot, "GptAccountKeeper.Desktop.csproj"),
    "<Project><PropertyGroup><Version>2.3.4</Version></PropertyGroup></Project>",
  );

  assert.doesNotThrow(() => verifyReleaseVersion("2.3.4", root));
  assert.throws(() => verifyReleaseVersion("2.3.5", root), /does not match committed metadata/i);
});
