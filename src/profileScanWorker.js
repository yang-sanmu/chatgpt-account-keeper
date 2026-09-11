import { parentPort, workerData } from "node:worker_threads";
import { createProfileManager } from "./profileManager.js";

try {
  const { accounts, busyIds, ...paths } = workerData;
  const busy = new Set(busyIds);
  const manager = createProfileManager({ ...paths, accountBusy: (id) => busy.has(id) });
  parentPort.postMessage({ result: manager.scan(accounts) });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
}
