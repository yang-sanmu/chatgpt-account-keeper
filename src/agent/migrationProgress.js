import fs from "node:fs";

const RETRYABLE_WRITE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function pause(milliseconds) {
  if (milliseconds > 0) Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

/**
 * Progress is an append-only JSONL diagnostic channel. Replacing one JSON file
 * races with Windows readers because a rename needs delete sharing; appending a
 * complete newline-terminated record needs only read/write sharing. The Desktop
 * ignores an incomplete final line and consumes the last complete record.
 */
export function writeMigrationProgress(
  file,
  payload,
  {
    fsImpl = fs,
    attempts = 20,
    retryDelayMs = 25,
  } = {}
) {
  if (!file) return Object.freeze({ written: false, mode: "disabled" });
  const body = `${JSON.stringify({
    ...payload,
    occurredAt: new Date().toISOString(),
  })}\n`;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fsImpl.appendFileSync(file, body, { encoding: "utf8", mode: 0o600 });
      return Object.freeze({ written: true, mode: "jsonl-append" });
    } catch (error) {
      lastError = error;
      const retryable = RETRYABLE_WRITE_CODES.has(error?.code) && attempt + 1 < attempts;
      if (!retryable) break;
      pause(retryDelayMs);
    }
  }
  throw lastError ?? new Error("无法写入迁移进度");
}

export function createMigrationProgressReporter(
  file,
  {
    logger = console,
    minimumIntervalMs = 250,
    clock = Date.now,
    ...writeOptions
  } = {}
) {
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let lastMilestone = null;
  return (payload) => {
    const now = Number(clock());
    const milestone = [
      payload?.state,
      payload?.stage,
      payload?.profileName,
      payload?.error?.code,
    ].join(":");
    const terminal = payload?.state === "succeeded" || payload?.state === "failed";
    if (!terminal && milestone === lastMilestone && now - lastWriteAt < minimumIntervalMs) {
      return true;
    }
    try {
      const written = writeMigrationProgress(file, payload, writeOptions).written;
      if (written) {
        lastWriteAt = now;
        lastMilestone = milestone;
      }
      return written;
    } catch (error) {
      try {
        logger?.warn?.(`迁移进度写入失败（迁移继续）：${String(error?.message || error)}`);
      } catch {
        // Neither a progress file nor its logger may terminate verified work.
      }
      return false;
    }
  };
}
