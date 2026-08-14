import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("installed Agent separates data, cache and state from the immutable app root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-roots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const cache = path.join(root, "cache");
  const state = path.join(root, "state");
  const script = [
    "import('./src/paths.js').then((p) => console.log(JSON.stringify({",
    "data:p.fromRoot('profiles'),",
    "cache:p.fromCacheRoot('mihomo'),",
    "state:p.fromStateRoot('logs'),",
    "install:p.fromInstallRoot('public')",
    "})))",
  ].join("");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      GPT_ACCOUNT_KEEPER_DATA_ROOT: data,
      GPT_ACCOUNT_KEEPER_CACHE_ROOT: cache,
      GPT_ACCOUNT_KEEPER_STATE_ROOT: state,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const resolved = JSON.parse(result.stdout.trim());
  assert.equal(resolved.data, path.join(data, "profiles"));
  assert.equal(resolved.cache, path.join(cache, "mihomo"));
  assert.equal(resolved.state, path.join(state, "logs"));
  assert.notEqual(path.dirname(resolved.install), data);
});
