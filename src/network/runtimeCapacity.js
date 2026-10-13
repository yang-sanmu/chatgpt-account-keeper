/** Single-volume estimate, not a reservation or launch approval. Existing bytes
 * include active AND already-retained copies. Renaming an old active copy does
 * not allocate another copy; charge only additional allocations below. */
export function estimateRuntimeCapacity({ availableBytes, existingRuntimeBytes, candidateBytes,
  additionalBackupBytes, temporaryBytes, safetyMarginBytes }) {
  const values = { availableBytes, existingRuntimeBytes, candidateBytes, additionalBackupBytes, temporaryBytes, safetyMarginBytes };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw Object.assign(new Error(`${name} 必须是非负安全整数字节数`), { code: "RUNTIME_CAPACITY_INVALID" });
    }
  }
  const additionalBytes = candidateBytes + additionalBackupBytes + temporaryBytes;
  const requiredAvailableBytes = additionalBytes + safetyMarginBytes;
  const peakBudgetBytes = existingRuntimeBytes + requiredAvailableBytes;
  if (![additionalBytes, requiredAvailableBytes, peakBudgetBytes].every(Number.isSafeInteger)) {
    throw Object.assign(new Error("磁盘容量计算超出安全整数范围"), { code: "RUNTIME_CAPACITY_INVALID" });
  }
  return Object.freeze({ ...values, additionalBytes, requiredAvailableBytes, peakBudgetBytes,
    sufficient: availableBytes >= requiredAvailableBytes,
    deficitBytes: Math.max(0, requiredAvailableBytes - availableBytes), launchAuthorization: "not_issued" });
}
