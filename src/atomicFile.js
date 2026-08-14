import fs from "node:fs";

const RETRYABLE_REPLACE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function pause(milliseconds) {
  if (milliseconds > 0) Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

/**
 * Windows can transiently reject replacement while antivirus/indexing software
 * opens the destination. Retry only sharing/access failures; structural errors
 * (for example, a directory destination) still fail immediately.
 */
export function renamePathSync(
  source,
  destination,
  {
    fsImpl = fs,
    attempts = 20,
    retryDelayMs = 25,
  } = {}
) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fsImpl.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const retryable = RETRYABLE_REPLACE_CODES.has(error?.code) && attempt + 1 < attempts;
      if (!retryable) break;
      pause(retryDelayMs);
    }
  }
  throw lastError ?? new Error("无法原子重命名路径");
}

export function replaceFileSync(source, destination, options) {
  renamePathSync(source, destination, options);
}
