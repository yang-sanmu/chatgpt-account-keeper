import { createHash } from "node:crypto";
import { ImapClient } from "./imapClient.js";
import {
  extractOpenAiOtp,
  isOpenAiAuthMessage,
  matchesRecipient,
  normalizeEmailAddress,
  parseRawEmail,
} from "./otpParser.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_IDLE_GRACE_MS = 10_000;
const INITIAL_TAIL_UIDS = 50;
const MAX_CACHED_MESSAGES = 250;
const MAX_CONSUME_KEYS = 1_000;

function configFingerprint(config) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        String(config.host || "").trim().toLowerCase(),
        Number(config.port || 993),
        config.tls !== false,
        String(config.user || "").trim().toLowerCase(),
        String(config.password || ""),
      ])
    )
    .digest("hex");
}

function selectTargetFolders(listedFolders = []) {
  const names = [];
  const seen = new Set();
  const push = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  push("INBOX");
  for (const folder of listedFolders) {
    const attrJunk = folder.attrs?.some((attr) => /^\\(junk|spam)$/i.test(attr));
    const nameMatch = /^(?:junk|spam|bulk|bulk mail|\[gmail\]\/(?:spam|junk)|&v4nxppcutvy-)$/i.test(
      folder.name
    );
    if (attrJunk || nameMatch) {
      push(folder.name);
    }
  }
  return names;
}

/**
 * 探测 IMAP 连接并校验登录凭据。
 */
export async function testImapConnection(config, { createClient = (opts) => new ImapClient(opts), signal = null } = {}) {
  if (!config?.host || !config?.user || !config?.password) {
    return {
      ok: false,
      folders: [],
      inboxMessages: 0,
      message: "请完整填写 IMAP 服务器、端口、邮箱账号与授权码",
    };
  }

  const client = createClient({
    host: config.host,
    port: config.port ?? 993,
    tls: config.tls !== false,
  });

  try {
    await client.connect();
    await client.login(config.user, config.password, { signal });
    let listed = [];
    try {
      listed = await client.listFolders({ signal });
    } catch {
      listed = [{ attrs: [], name: "INBOX" }];
    }
    const examine = await client.examine("INBOX", { signal });
    const targetFolders = selectTargetFolders(listed);
    return {
      ok: true,
      folders: targetFolders,
      inboxMessages: examine.exists,
      message: `连接成功：INBOX 共 ${examine.exists} 封邮件，将监听文件夹：${targetFolders.join(", ")}`,
    };
  } catch (error) {
    return {
      ok: false,
      folders: [],
      inboxMessages: 0,
      message: error?.message || "IMAP 连接失败",
    };
  } finally {
    await client.logout();
  }
}

/**
 * 单飞共享接码邮箱协调器：多个并发重登 Worker 共享一条 IMAP 轮询通道，避免并发登录被邮件服务商限流。
 */
export class SharedInboxCoordinator {
  constructor(config, options = {}) {
    this.config = {
      host: String(config.host || "").trim(),
      port: Number(config.port || 993),
      tls: config.tls !== false,
      user: String(config.user || "").trim(),
      password: String(config.password || ""),
    };
    this.fingerprint = configFingerprint(this.config);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.initialTailUids = options.initialTailUids ?? INITIAL_TAIL_UIDS;
    this.createClient = options.createClient ?? ((opts) => new ImapClient(opts));

    this._client = null;
    this._folders = null;
    this._folderStates = new Map();
    this._recentMessages = [];
    this._consumedKeys = new Set();
    this._waiters = new Set();
    this._pollLoopPromise = null;
    this._idleTimer = null;
    this._disposed = false;
  }

  async _ensureConnected() {
    if (this._client?.isOpen) return this._client;
    const client = this.createClient({
      host: this.config.host,
      port: this.config.port,
      tls: this.config.tls,
    });
    await client.connect();
    await client.login(this.config.user, this.config.password);
    let listed = [];
    try {
      listed = await client.listFolders();
    } catch {
      listed = [{ attrs: [], name: "INBOX" }];
    }
    this._folders = selectTargetFolders(listed);
    this._client = client;
    return client;
  }

  _dropClient() {
    if (!this._client) return;
    try {
      this._client.close();
    } catch {
      // 忽略关闭错误
    }
    this._client = null;
  }

  _scheduleIdleClose() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._waiters.size > 0 || !this._client) return;
    this._idleTimer = setTimeout(() => {
      if (this._waiters.size === 0 && this._client) {
        const closingClient = this._client;
        this._client = null;
        void closingClient.logout();
      }
    }, this.idleGraceMs);
    this._idleTimer.unref?.();
  }

  _recordMessage(entry) {
    this._recentMessages.push(entry);
    if (this._recentMessages.length > MAX_CACHED_MESSAGES) {
      this._recentMessages.splice(0, this._recentMessages.length - MAX_CACHED_MESSAGES);
    }
  }

  _markConsumed(key) {
    this._consumedKeys.add(key);
    if (this._consumedKeys.size > MAX_CONSUME_KEYS) {
      const first = this._consumedKeys.values().next().value;
      if (first) this._consumedKeys.delete(first);
    }
  }

  async pollOnce() {
    let client;
    try {
      client = await this._ensureConnected();
    } catch (error) {
      this._dropClient();
      throw error;
    }

    const folders = this._folders?.length ? this._folders : ["INBOX"];
    for (const folder of folders) {
      let state = this._folderStates.get(folder);
      let info;
      try {
        info = await client.examine(folder);
      } catch (error) {
        if (error?.code === "IMAP_NO") {
          this._folderStates.delete(folder);
          continue;
        }
        this._dropClient();
        throw error;
      }

      if (info.exists === 0) {
        this._folderStates.set(folder, {
          uidValidity: info.uidValidity,
          highestUid: 0,
          tailStartUid: 1,
          fetchedUids: new Set(),
        });
        continue;
      }

      if (state && info.uidValidity && state.uidValidity && state.uidValidity !== info.uidValidity) {
        state = null;
      }

      let targetUids = [];
      let fetched = [];
      try {
        if (!state) {
          const allUids = await client.uidSearch("ALL");
          targetUids = allUids.slice(-this.initialTailUids);
          state = {
            uidValidity: info.uidValidity,
            highestUid: 0,
            tailStartUid: targetUids[0] ?? Math.max(1, info.uidNext || 1),
            fetchedUids: new Set(),
          };
          this._folderStates.set(folder, state);
        } else {
          // 即使 uidNext 未再增长，只要仍有激活 waiter，也回扫最近 40 个 UID 窗口，
          // 避免 QQ 邮箱乱序建索引导致 earlier-UID 晚出现时被永久跳过。
          if (this._waiters.size === 0 && info.uidNext && info.uidNext <= state.highestUid + 1) {
            continue;
          }
          const lookbackStart = Math.max(state.tailStartUid || 1, state.highestUid - 40);
          const candidates = await client.uidSearch(`UID ${lookbackStart}:*`);
          targetUids = candidates.filter((uid) => uid >= lookbackStart && !state.fetchedUids.has(uid));
        }

        if (!targetUids.length) {
          if (state.highestUid === 0 && info.uidNext && info.uidNext > 1) {
            state.highestUid = info.uidNext - 1;
          }
          continue;
        }

        fetched = await client.uidFetchMessages(targetUids);
      } catch (error) {
        this._dropClient();
        throw error;
      }

      if (fetched.length) {
        for (const item of fetched) {
          if (item.uid > 0) {
            state.fetchedUids.add(item.uid);
          }
        }
        if (state.fetchedUids.size > 600) {
          const keep = [...state.fetchedUids].sort((a, b) => a - b).slice(-300);
          state.fetchedUids = new Set(keep);
        }
        const maxFetchedUid = fetched.reduce((acc, item) => Math.max(acc, item.uid || 0), state.highestUid);
        state.highestUid = maxFetchedUid;
      } else if (state.highestUid === 0 && targetUids.length) {
        // 首次全量尾部拉取若返回空且未抛错，仍记录尾部起点以免反复重抓历史邮件
        state.highestUid = targetUids[targetUids.length - 1];
      }

      for (const msg of fetched) {
        const parsed = parseRawEmail(msg.raw);
        if (!isOpenAiAuthMessage(parsed)) continue;
        const code = extractOpenAiOtp(parsed);
        if (!code) continue;
        const timestampMs = msg.internalDateTs ?? parsed.dateTs ?? Date.now();
        const consumeKey = `${folder}:${info.uidValidity ?? 0}:${msg.uid}:${code}`;
        this._recordMessage({
          consumeKey,
          uid: msg.uid,
          folder,
          timestampMs,
          code,
          parsed,
        });
      }
    }
  }

  _tryResolveWaiters(now = Date.now()) {
    for (const waiter of [...this._waiters]) {
      const candidates = this._recentMessages.filter((msg) => {
        if (this._consumedKeys.has(msg.consumeKey)) return false;
        if (waiter.excludeCodes.has(msg.code)) return false;
        if (msg.timestampMs < waiter.afterTs) return false;
        return matchesRecipient(msg.parsed, waiter.email);
      });
      if (!candidates.length) continue;

      candidates.sort((a, b) => b.timestampMs - a.timestampMs || b.uid - a.uid);
      const newest = candidates[0];
      if (!waiter.firstMatchedAt) {
        waiter.firstMatchedAt = now;
      }
      if (now - waiter.firstMatchedAt < waiter.settleMs) {
        continue;
      }

      this._markConsumed(newest.consumeKey);
      this._waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(newest.code);
    }
  }

  _ensurePollLoop() {
    if (this._pollLoopPromise || this._disposed) return;
    this._pollLoopPromise = (async () => {
      let fatalAuthFailures = 0;
      while (this._waiters.size > 0 && !this._disposed) {
        try {
          await this.pollOnce();
          fatalAuthFailures = 0;
          this._tryResolveWaiters(Date.now());
        } catch (error) {
          if (error?.code === "IMAP_AUTH_FAILED" || error?.code === "IMAP_CONFIG_INVALID") {
            fatalAuthFailures += 1;
            if (fatalAuthFailures >= 1) {
              for (const waiter of [...this._waiters]) {
                this._waiters.delete(waiter);
                waiter.cleanup();
                waiter.reject(error);
              }
              break;
            }
          }
        }

        if (this._waiters.size === 0 || this._disposed) break;
        const waitMs = [...this._waiters].some((w) => w.firstMatchedAt != null)
          ? Math.min(this.pollIntervalMs, 500)
          : this.pollIntervalMs;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        });
        this._tryResolveWaiters(Date.now());
      }
    })().finally(() => {
      this._pollLoopPromise = null;
      this._scheduleIdleClose();
    });
  }

  /**
   * 等待指定邮箱收到最新的 OpenAI 6 位验证码。
   */
  waitForOtp({
    email,
    afterTs = Date.now() - 15_000,
    excludeCodes = [],
    timeoutMs = 90_000,
    settleMs = 2_000,
    signal = null,
  }) {
    if (this._disposed) {
      return Promise.reject(new Error("接码协调器已关闭"));
    }
    const normalized = normalizeEmailAddress(email);
    if (!normalized || !normalized.includes("@")) {
      return Promise.reject(new Error("等待验证码需要有效的目标邮箱"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("等待验证码已取消"));
    }
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }

    const excludeSet = excludeCodes instanceof Set ? excludeCodes : new Set(excludeCodes);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        this._waiters.delete(waiter);
        cleanup();
        reject(new Error("等待邮箱验证码已取消"));
      };

      const waiter = {
        email: normalized,
        afterTs,
        excludeCodes: excludeSet,
        settleMs,
        firstMatchedAt: null,
        cleanup,
        resolve: (code) => {
          if (settled) return;
          settled = true;
          resolve(code);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._waiters.delete(waiter);
        cleanup();
        reject(
          Object.assign(
            new Error(`等待邮箱 ${normalized} 验证码超时（${Math.round(timeoutMs / 1000)} 秒内未收到）`),
            { code: "OTP_TIMEOUT" }
          )
        );
      }, timeoutMs);
      timer.unref?.();

      signal?.addEventListener?.("abort", onAbort, { once: true });
      this._waiters.add(waiter);

      // 若缓存里已有一封满足条件的邮件，立即检查。
      this._tryResolveWaiters(Date.now());
      if (settled) return;
      this._ensurePollLoop();
    });
  }

  async dispose() {
    this._disposed = true;
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    for (const waiter of [...this._waiters]) {
      this._waiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(new Error("接码协调器已关闭"));
    }
    await this._client?.logout();
    this._client = null;
  }
}

/**
 * 根据最新 IMAP 配置缓存并复用共享协调器，配置变更时自动重建。
 */
export class SharedInboxRegistry {
  constructor(options = {}) {
    this.options = options;
    this.coordinators = new Map();
  }

  getCoordinator(config) {
    if (!config?.host || !config?.user || !config?.password) return null;
    const key = [
      String(config.host).trim().toLowerCase(),
      Number(config.port || 993),
      config.tls !== false ? "1" : "0",
      String(config.user).trim().toLowerCase(),
    ].join(":");
    const nextFingerprint = configFingerprint(config);
    const existing = this.coordinators.get(key);
    if (existing && existing.fingerprint === nextFingerprint) {
      return existing;
    }
    if (existing) {
      this.coordinators.delete(key);
      void existing.dispose();
    }
    for (const [otherKey, coord] of [...this.coordinators.entries()]) {
      if (coord.fingerprint !== nextFingerprint && coord._waiters?.size === 0) {
        this.coordinators.delete(otherKey);
        void coord.dispose();
      }
    }
    const created = new SharedInboxCoordinator(config, this.options);
    this.coordinators.set(key, created);
    return created;
  }

  async dispose() {
    const all = [...this.coordinators.values()];
    this.coordinators.clear();
    await Promise.allSettled(all.map((coordinator) => coordinator.dispose()));
  }
}
