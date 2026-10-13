import test from "node:test";
import assert from "node:assert/strict";
import { estimateRuntimeCapacity } from "../src/network/runtimeCapacity.js";

const budget = { availableBytes: 1200, existingRuntimeBytes: 4000, candidateBytes: 700,
  additionalBackupBytes: 200, temporaryBytes: 100, safetyMarginBytes: 200 };

test("runtime capacity counts only new allocations against current free space", () => {
  const result = estimateRuntimeCapacity(budget);
  assert.equal(result.additionalBytes, 1000);
  assert.equal(result.requiredAvailableBytes, 1200);
  assert.equal(result.peakBudgetBytes, 5200);
  assert.equal(result.sufficient, true);
  assert.equal(result.deficitBytes, 0);
  assert.equal(result.launchAuthorization, "not_issued");
  // Already retained copies affect the total peak, not additional free space.
  const retained = estimateRuntimeCapacity({ ...budget, existingRuntimeBytes: 4800 });
  assert.equal(retained.requiredAvailableBytes, result.requiredAvailableBytes);
  assert.equal(retained.peakBudgetBytes, result.peakBudgetBytes + 800);
});

test("runtime capacity reports shortfall and includes the requested safety margin", () => {
  const result = estimateRuntimeCapacity({ ...budget, availableBytes: 1199 });
  assert.equal(result.sufficient, false);
  assert.equal(result.deficitBytes, 1);
  const first = estimateRuntimeCapacity({ ...budget, existingRuntimeBytes: 0, additionalBackupBytes: 0 });
  assert.equal(first.peakBudgetBytes, 1000);
  assert.equal(first.requiredAvailableBytes, 1000);
});

test("runtime capacity refuses missing, negative, fractional and overflowing amounts", () => {
  for (const name of Object.keys(budget)) {
    for (const value of [undefined, -1, 0.5, "1000", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => estimateRuntimeCapacity({ ...budget, [name]: value }), { code: "RUNTIME_CAPACITY_INVALID" });
    }
  }
  for (const name of ["candidateBytes", "existingRuntimeBytes", "safetyMarginBytes"]) {
    assert.throws(() => estimateRuntimeCapacity({ ...budget, [name]: Number.MAX_SAFE_INTEGER }), { code: "RUNTIME_CAPACITY_INVALID" });
  }
});
