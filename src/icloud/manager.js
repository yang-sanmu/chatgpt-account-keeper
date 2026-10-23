import fs from "node:fs/promises";
import path from "node:path";
import { ApplicationError, ERROR_CODES } from "../application/errors.js";
import { IcloudBrowser, ICLOUD_PROFILE, ICLOUD_RESOURCE } from "./browser.js";
import { HOUR, IcloudError, validateIcloudConfig, mergeIcloudEmails, nextAllowedCreate } from "./model.js";

const iso = value => value == null ? null : new Date(value).toISOString();
const busyError = () => new ApplicationError(ERROR_CODES.RESOURCE_BUSY, "iCloud 正在处理另一项操作，请稍后重试");

export class IcloudManager {
  constructor({ store, dataRoot, acquireChrome, browserRuns, onChanged = () => {}, canRun = () => true,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, browserFactory = options => new IcloudBrowser(options) }) {
    Object.assign(this, { store, dataRoot, acquireChrome, browserRuns, onChanged, canRun, now, setTimer, clearTimer, browserFactory });
    this.data = store.load(); this.manual = null; this.worker = null; this.pending = null; this.timer = null; this.stopping = false;
    // Existing settings retain the original one-address-per-interval behavior.
    this.data.config = validateIcloudConfig(this.data.config);
    this.controller = new AbortController();
    if (this.data.pendingCreate) {
      this.data.status = "uncertain"; this.data.config.enabled = false;
      this.data.lastMessage = "上次创建结果待核对，请先同步列表";
    } else if (this.data.status === "running") {
      this.data.status = "idle";
    }
    if (this.data.config.enabled && (this.data.nextRunAt ?? 0) <= now()) this.data.nextRunAt = Math.max(now() + this.data.config.intervalMinutes * 60_000, this.data.cooldownUntil ?? 0);
    this.store.save(this.data);
  }
  state() {
    const d = this.data;
    return { config: { ...d.config }, status: d.status, busy: !!this.pending,
      browserOpen: !!this.manual || !!this.browserRuns?.listActive().some(run => run.accountId === ICLOUD_RESOURCE),
      bound: !!d.accountKey, nextRunAt: d.config.enabled ? iso(d.nextRunAt) : null,
      cooldownUntil: iso(d.cooldownUntil), lastSyncAt: iso(d.lastSyncAt), lastMessage: d.lastMessage,
      pendingEmail: d.pendingCreate?.email ?? null, emails: d.emails, history: d.history };
  }
  persist() { this.store.save(this.data); this.onChanged(this.state()); }
  record(action, outcome, message) {
    this.data.history = [{ at: iso(this.now()), action, outcome, message }, ...this.data.history].slice(0, 50);
    this.data.lastMessage = message;
  }
  active() { return !!this.pending || !!this.manual || !!this.browserRuns?.listActive().some(run => run.accountId === ICLOUD_RESOURCE); }
  schedule() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.stopping || !this.data.config.enabled) return;
    const delay = Math.max(1000, (this.data.nextRunAt ?? this.now() + 60_000) - this.now());
    this.timer = this.setTimer(() => { this.timer = null; void this.tick().catch(() => {}); }, Math.min(delay, 2_147_483_647));
    this.timer?.unref?.();
  }
  async tick() {
    if (this.stopping || !this.data.config.enabled) return;
    if (this.pending || this.manual || !this.canRun()) {
      this.data.nextRunAt = this.now() + 60_000;
      this.persist(); this.schedule(); return;
    }
    try { await this.create({ automatic: true }); } catch { /* outcome is persisted by exclusive */ }
    this.schedule();
  }
  saveConfig(input) {
    if (this.stopping) throw busyError();
    const config = validateIcloudConfig(input);
    if (this.pending) throw busyError();
    if (config.networkMode !== this.data.config.networkMode && this.active()) throw new IcloudError("validation", "请先关闭 iCloud 浏览器，再修改网络模式");
    if (config.enabled && (!this.data.accountKey || this.data.pendingCreate || ["needs_login", "not_logged_in"].includes(this.data.status))) {
      throw new IcloudError("validation", "请先登录并同步列表，完成待核对结果后再启用自动申请");
    }
    const wasEnabled = this.data.config.enabled;
    this.data.config = config;
    this.data.nextRunAt = config.enabled ? Math.max(this.now() + config.intervalMinutes * 60_000, nextAllowedCreate(this.data, this.now())) : null;
    if (config.enabled) this.data.status = this.data.cooldownUntil > this.now() ? "cooldown" : "idle";
    if (wasEnabled !== config.enabled) this.record("settings", "ok", config.enabled ? "已开启持续申请" : "已停止自动申请");
    this.persist(); this.schedule(); return this.state();
  }
  stop() {
    this.data.config.enabled = false; this.data.nextRunAt = null;
    this.record("settings", "ok", this.pending ? "已停止后续自动申请，当前操作正在收尾" : "已停止自动申请");
    this.persist(); this.schedule(); return this.state();
  }
  updateLocal({ ids, usage, localNote }) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || new Set(ids).size !== ids.length ||
      (usage !== undefined && !["unknown", "unused", "used"].includes(usage)) ||
      (localNote !== undefined && (typeof localNote !== "string" || localNote.length > 2000)) || (usage === undefined && localNote === undefined)) {
      throw new IcloudError("validation", "无效的邮箱属性更新");
    }
    const selected = new Set(ids);
    if (this.data.emails.filter(row => selected.has(row.id)).length !== selected.size) throw new IcloudError("validation", "所选邮箱已变化，请刷新列表");
    this.data.emails = this.data.emails.map(row => selected.has(row.id) ? { ...row,
      ...(usage === undefined ? {} : { usage }), ...(localNote === undefined ? {} : { localNote }) } : row);
    this.persist(); return this.state();
  }
  acknowledge() {
    if (this.pending) throw busyError();
    this.data.pendingCreate = null; this.data.config.enabled = false; this.data.status = this.data.accountKey ? "idle" : "not_logged_in";
    this.record("reconcile", "ok", "已手动确认待核对结果，自动申请保持关闭"); this.persist(); return this.state();
  }
  acceptList({ accountKey, emails }) {
    if (this.stopping) return;
    if (this.data.accountKey && this.data.accountKey !== accountKey) throw new IcloudError("account", "此 Profile 登录了不同的 Apple 账号，请登录原账号后再同步");
    const pending = this.data.pendingCreate;
    const created = pending && emails.some(row => row.email.toLowerCase() === pending.email.toLowerCase());
    const merged = mergeIcloudEmails(this.data.emails, emails, created ? pending.email : null);
    this.data.accountKey = accountKey; this.data.emails = merged; this.data.lastSyncAt = this.now();
    if (created) {
      this.data.pendingCreate = null;
      this.record("create", "ok", `创建成功：${pending.email}`);
    }
    if (!this.data.pendingCreate && ["needs_login", "not_logged_in", "uncertain"].includes(this.data.status)) this.data.status = "idle";
    this.persist();
  }
  async ensureProfile() {
    const root = path.resolve(this.dataRoot);
    const parent = path.resolve(root, "icloud-profiles"); const target = path.resolve(root, ICLOUD_PROFILE);
    if (path.dirname(target) !== parent) throw new IcloudError("validation", "无效的 iCloud Profile 目录");
    for (const item of [parent, target]) {
      try { const stat = await fs.lstat(item); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IcloudError("validation", "iCloud Profile 目录不能是链接或文件"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  async newBrowser(config, options) {
    await this.ensureProfile();
    if (this.browserRuns?.listActive().some(run => run.accountId === ICLOUD_RESOURCE)) throw new IcloudError("close", "iCloud 浏览器仍在运行或等待回收，请先关闭");
    const browser = this.browserFactory({ acquireChrome: this.acquireChrome, signal: this.controller.signal,
      onList: list => {
        try { this.acceptList(list); }
        catch (error) { if (!this.pending && !this.stopping) { this.failed("sync", error); this.persist(); this.schedule(); } throw error; }
      }, onClosed: () => {
        if (this.manual === browser && !this.stopping) setImmediate(() => {
          void (async () => {
            // A user may close Chrome while sync/create is finishing. Release the
            // manual owner afterwards so automatic work does not wait forever.
            while (this.pending && !this.stopping) await this.pending.catch(() => {});
            if (this.manual === browser && !this.stopping) await this.close();
          })().catch(() => {});
        });
      } });
    this.worker = browser;
    try { await browser.launch(config, options); }
    catch (error) { await this.closeBrowser(browser); throw error; }
    return browser;
  }
  async exclusive(action, work) {
    if (this.stopping || !this.canRun() && action !== "close") throw new ApplicationError(ERROR_CODES.AGENT_DRAINING, "Agent 正在退出或准备更新");
    if (this.pending) throw busyError();
    const task = Promise.resolve().then(work);
    this.pending = task; this.persist();
    try { return await task; }
    catch (error) {
      if (!this.stopping) this.failed(action, error);
      if (error instanceof IcloudError || error instanceof ApplicationError || error.code === "CHROME_NOT_FOUND") throw error;
      throw new ApplicationError(ERROR_CODES.INTERNAL, "iCloud 操作失败，请检查网络或打开官方页面确认");
    }
    finally {
      this.pending = null;
      if (!this.stopping) { this.persist(); this.schedule(); }
    }
  }
  failed(action, error) {
    const d = this.data; const now = this.now();
    const kind = error.kind ?? "service";
    if (["rate_limit", "limit"].includes(kind) && error.creationRejected === true && !d.pendingCreate?.confirmed) d.pendingCreate = null;
    // Reconciliation must not discard a server cooldown received after submit.
    if (kind === "rate_limit") d.cooldownUntil = Math.max(d.cooldownUntil ?? 0, error.retryAt ?? now + HOUR);
    if (d.pendingCreate) {
      d.status = "uncertain"; d.config.enabled = false; d.nextRunAt = null;
      this.record(action, "uncertain", "创建结果待核对，已暂停；请同步列表确认后再继续"); return;
    }
    d.failures += 1;
    if (kind === "rate_limit") {
      d.status = "cooldown";
      d.nextRunAt = Math.max(d.cooldownUntil, now + d.config.intervalMinutes * 60_000);
    } else if (["auth", "account"].includes(kind)) {
      d.status = "needs_login"; d.config.enabled = false; d.nextRunAt = null;
    } else if (["limit", "format", "close"].includes(kind) || d.failures >= 3) {
      d.status = "paused"; d.config.enabled = false; d.nextRunAt = null;
    } else {
      d.status = "idle"; d.nextRunAt = now + Math.max(d.config.intervalMinutes, Math.min(60, 5 * 2 ** (d.failures - 1))) * 60_000;
    }
    // Do not expose Playwright's raw call logs (which may contain URLs/identifiers).
    this.record(action, kind, error instanceof IcloudError ? error.message : "iCloud 操作失败，请检查网络或打开官方页面确认");
  }
  open({ operationId = null } = {}) {
    return this.exclusive("open", async () => {
      if (this.manual) return { ok: true };
      const browser = await this.newBrowser(this.data.config, { headed: true, operationId });
      this.manual = browser; this.worker = null;
      try { await browser.openLogin(); }
      catch (error) { await this.closeBrowser(browser); throw error; }
      this.record("open", "ok", "请在专用浏览器中手动登录并进入隐藏邮件地址；完成后同步列表");
      return { ok: true };
    });
  }
  async closeBrowser(browser) {
    await browser.close();
    if (this.manual === browser) this.manual = null;
    if (this.worker === browser) this.worker = null;
  }
  close() {
    return this.exclusive("close", async () => {
      const browser = this.manual ?? this.worker;
      if (browser) await this.closeBrowser(browser);
      else {
        const run = this.browserRuns?.listActive().find(run => run.accountId === ICLOUD_RESOURCE);
        if (run) {
          const result = await this.browserRuns.close(run.browserRunId, "icloud-close");
          if (result.state !== "closed") throw new IcloudError("close", "iCloud 浏览器尚未完全关闭，请重试");
        }
      }
      return { ok: true };
    });
  }
  async usingBrowser(operationId, work) {
    if (this.manual) return work(this.manual);
    let browser;
    try { browser = await this.newBrowser(this.data.config, { operationId }); return await work(browser); }
    finally { if (browser ?? this.worker) await this.closeBrowser(browser ?? this.worker); }
  }
  sync({ operationId = null } = {}) {
    return this.exclusive("sync", () => this.usingBrowser(operationId, async browser => {
      const list = await browser.sync(); this.acceptList(list);
      this.data.failures = 0;
      if (!this.data.pendingCreate) this.record("sync", "ok", `已同步 ${list.emails.length} 个 iCloud 邮箱`);
      return { ok: true };
    }));
  }
  create({ operationId = null, automatic = false } = {}) {
    return this.exclusive("create", async () => {
      if (automatic && !this.data.config.enabled) return { ok: true };
      if (this.data.pendingCreate) throw new IcloudError("uncertain", "请先核对上次创建结果");
      const allowedAt = nextAllowedCreate(this.data, this.now());
      if (allowedAt > this.now()) throw new IcloudError("rate_limit", "申请仍在冷却中，等待后再试", allowedAt);
      return this.usingBrowser(operationId, async browser => {
        const config = { ...this.data.config };
        const target = !automatic || config.mode === "single" ? 1 : config.mode === "batch" ? config.batchSize : Infinity;
        let list = await browser.sync(); this.acceptList(list);
        let count = 0; let email;
        while (count < target) {
          if (this.stopping || automatic && (!this.data.config.enabled || !this.canRun())) break;
          const allowedAt = nextAllowedCreate(this.data, this.now());
          if (allowedAt > this.now()) throw new IcloudError("rate_limit", "已达到本地滚动一小时申请限制，等待冷却", allowedAt);
          // Until-limit mode relies on Apple's response, including creations elsewhere.
          const recent = list.emails.map(row => Date.parse(row.createdAt)).filter(at => at > this.now() - HOUR).sort((a, b) => a - b);
          if (config.mode !== "until_limit" && recent.length >= 5) throw new IcloudError("rate_limit", "iCloud 列表显示最近一小时已创建至少 5 个地址，等待冷却", recent[recent.length - 5] + HOUR + 1000);
          this.data.attempts = [...this.data.attempts.filter(at => at > this.now() - HOUR), this.now()];
          this.data.status = "running"; this.persist();
          email = await browser.create(config, candidate => {
            if (this.stopping || automatic && !this.data.config.enabled) throw new IcloudError("cancelled", "自动申请已停止");
            this.data.pendingCreate = { email: candidate, at: this.now(), confirmed: false }; this.persist();
          });
          if (this.data.pendingCreate) this.data.pendingCreate.confirmed = true;
          this.persist();
          list = await browser.sync(); this.acceptList(list);
          if (this.data.pendingCreate || !this.data.emails.some(row => row.email === email)) throw new IcloudError("uncertain", "创建后尚未在列表中确认，请稍后同步核对");
          count++;
          this.data.failures = 0; this.data.cooldownUntil = null;
          if (automatic && config.mode !== "single") this.record("round", "ok", `本轮已申请 ${count}${Number.isFinite(target) ? ` / ${target}` : ""} 个邮箱`);
          this.persist();
        }
        this.data.status = "idle"; this.data.failures = 0; this.data.cooldownUntil = null;
        this.data.nextRunAt = this.data.config.enabled ? this.now() + config.intervalMinutes * 60_000 : null;
        if (automatic && config.mode !== "single") this.record("round", "ok", `本轮结束，已申请 ${count} 个邮箱${this.data.config.enabled ? "" : "，自动申请已停止"}`);
        return { ok: true, email, count };
      });
    });
  }
  async shutdown() {
    this.stopping = true; this.controller.abort();
    if (this.timer) this.clearTimer(this.timer);
    await Promise.allSettled([this.manual, this.worker].filter(Boolean).map(browser => this.closeBrowser(browser)));
    if (this.pending) await this.pending.catch(() => {});
    await Promise.allSettled([this.manual, this.worker].filter(Boolean).map(browser => this.closeBrowser(browser)));
  }
}
