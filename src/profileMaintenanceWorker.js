import { parentPort, workerData } from "node:worker_threads";
import { profileManager } from "./profileManager.js";

try {
  const { account, limitBytes } = workerData;
  const inspected = profileManager.inspectAccountCache(account);
  let result;

  if (inspected.missing) {
    result = { status: "missing", cacheBytes: 0, freedBytes: 0 };
  } else if (inspected.cacheBytes <= limitBytes) {
    result = {
      status: "under-limit",
      cacheBytes: inspected.cacheBytes,
      freedBytes: 0,
    };
  } else {
    const cleaned = profileManager.cleanAccountCache(account);
    result = {
      status: "cleaned",
      cacheBytes: Math.max(0, inspected.cacheBytes - cleaned.freedBytes),
      freedBytes: cleaned.freedBytes,
      freedFiles: cleaned.freedFiles,
    };
  }

  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error) });
}
