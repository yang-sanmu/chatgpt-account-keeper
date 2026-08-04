import { Worker } from "node:worker_threads";
import path from "node:path";
import { getAccount, getAccounts, getSettings } from "./store.js";
import { isHeld, withAccountLock } from "./locks.js";
import { ROOT } from "./paths.js";
import * as log from "./logger.js";

export const PROFILE_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const CLOSE_DELAY_MS = 1000;

function profileKey(profileDir) {
  const resolved = path.resolve(ROOT, String(profileDir ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function runProfileMaintenanceWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./profileMaintenanceWorker.js", import.meta.url), {
      workerData: payload,
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.once("message", (message) => {
      if (message?.ok) finish(resolve, message.result);
      else finish(reject, new Error(message?.error || "Profile 缓存维护失败"));
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(reject, new Error(`Profile 缓存维护工作线程退出：${code}`));
    });
  });
}

export class ProfileMaintenanceService {
  constructor(runtime = {}) {
    this._getAccount = runtime.getAccount ?? getAccount;
    this._getAccounts = runtime.getAccounts ?? getAccounts;
    this._getSettings = runtime.getSettings ?? getSettings;
    this._isHeld = runtime.isHeld ?? isHeld;
    this._withAccountLock = runtime.withAccountLock ?? withAccountLock;
    this._runWorker = runtime.runWorker ?? runProfileMaintenanceWorker;
    this._now = runtime.now ?? (() => Date.now());
    this._setTimeout = runtime.setTimeout ?? setTimeout;
    this._log = runtime.log ?? log;
    this._lastCheckedAt = new Map();
    this._scheduled = new Set();
    this._serial = Promise.resolve();
    this._started = false;
  }

  _recentlyChecked(accountId) {
    const last = this._lastCheckedAt.get(accountId);
    return Number.isFinite(last) && this._now() - last < CHECK_INTERVAL_MS;
  }

  async runNow(accountId, { force = false } = {}) {
    if (this._getSettings().profileAutoCleanEnabled === false && !force) {
      return { status: "disabled" };
    }
    if (!force && this._recentlyChecked(accountId)) {
      return { status: "recently-checked" };
    }
    // 手动窗口可能持锁数小时；直接跳过，关窗事件会再次调度。
    if (this._isHeld(accountId)) {
      return { status: "window-open" };
    }

    return this._withAccountLock(accountId, async () => {
      if (!force && this._recentlyChecked(accountId)) {
        return { status: "recently-checked" };
      }
      const account = this._getAccount(accountId);
      if (!account) return { status: "missing-account" };
      if (this._getSettings().profileAutoCleanEnabled === false && !force) {
        return { status: "disabled" };
      }
      const accountProfile = profileKey(account.profileDir);
      const shared = this._getAccounts().some(
        (other) =>
          other.id !== account.id && profileKey(other.profileDir) === accountProfile
      );
      if (shared) return { status: "shared-profile" };

      let result;
      try {
        result = await this._runWorker({
          account,
          limitBytes: PROFILE_CACHE_LIMIT_BYTES,
        });
      } catch (error) {
        result = { status: "error", detail: String(error?.message || error) };
        this._log.warn(`账号 ${accountId} Profile 自动维护失败：${result.detail}`);
      }
      this._lastCheckedAt.set(accountId, this._now());

      if (result.status === "cleaned") {
        this._log.info(
          `账号 ${accountId} Profile 自动清理完成，释放 ${Math.round(
            (result.freedBytes ?? 0) / 1024 / 1024
          )} MB`
        );
      }
      return result;
    });
  }

  schedule(accountId, { delayMs = CLOSE_DELAY_MS, unref = false } = {}) {
    if (!accountId || this._scheduled.has(accountId)) return false;
    this._scheduled.add(accountId);
    const timer = this._setTimeout(() => {
      this._serial = this._serial
        .then(() => this.runNow(accountId))
        .catch((error) => {
          this._log.warn(
            `账号 ${accountId} Profile 自动维护调度失败：${String(error?.message || error)}`
          );
        })
        .finally(() => this._scheduled.delete(accountId));
    }, Math.max(0, delayMs));
    if (unref) timer?.unref?.();
    return true;
  }

  start() {
    if (this._started) return false;
    this._started = true;
    const timer = this._setTimeout(() => {
      this._getAccounts().forEach((account, index) => {
        this.schedule(account.id, { delayMs: index * 250, unref: true });
      });
    }, STARTUP_DELAY_MS);
    timer?.unref?.();
    return true;
  }
}

export const profileMaintenance = new ProfileMaintenanceService();

export function scheduleProfileCacheMaintenance(accountId) {
  return profileMaintenance.schedule(accountId);
}

export function startProfileMaintenance() {
  return profileMaintenance.start();
}
