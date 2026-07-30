import test from "node:test";
import assert from "node:assert/strict";
import { withClashVergeDirectory } from "../src/proxyManager.js";

test("saving a Clash Verge directory clears the legacy executable override", () => {
  const original = {
    subscription: { url: "https://example.com/subscription" },
    nodes: [{ id: "px_1" }],
    mihomoPath: "C:\\legacy\\mihomo.exe",
    clashVergeDir: "C:\\old",
  };

  const updated = withClashVergeDirectory(original, "D:\\Apps\\Clash Verge");

  assert.equal(updated.clashVergeDir, "D:\\Apps\\Clash Verge");
  assert.equal(updated.mihomoPath, null);
  assert.equal(updated.subscription, original.subscription);
  assert.equal(updated.nodes, original.nodes);
  assert.equal(original.mihomoPath, "C:\\legacy\\mihomo.exe");
});
