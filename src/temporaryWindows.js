import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApplicationError, ERROR_CODES, assertInput } from "./application/errors.js";
import { lookupThroughProxy } from "./geo.js";

const error = (code, message) => new ApplicationError(ERROR_CODES[code], message);

export function normalizeTemporaryWindow(input) {
  assertInput(input && typeof input === "object", "窗口配置不能为空");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const note = input.note ?? "";
  assertInput(name.length > 0 && name.length <= 100, "名称须为 1–100 个字符");
  assertInput(typeof note === "string" && note.length <= 2000, "备注最多 2000 个字符");
  const homepage = typeof input.homepage === "string" ? input.homepage.trim() : "";
  let url;
  try { url = new URL(homepage || "https://chatgpt.com/"); } catch { /* validated below */ }
  assertInput(url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
    && url.href.length <= 4096, "默认主页须为有效的 HTTP/HTTPS 网址，且不能包含用户名或密码");
  assertInput(typeof input.proxyId === "string" && input.proxyId.length > 0, "请选择出口节点");
  return { name, note, homepage: url.href, proxyId: input.proxyId };
}

export class SqliteTemporaryWindowStore {
  constructor(repository) { this.db = repository.db; }
  list() { return this.db.prepare("SELECT config_json FROM temporary_windows ORDER BY rowid").all().map(row => JSON.parse(row.config_json)); }
  get(id) {
    const row = this.db.prepare("SELECT config_json FROM temporary_windows WHERE id=?").get(id);
    return row ? JSON.parse(row.config_json) : null;
  }
  save(value) {
    this.db.prepare(`INSERT INTO temporary_windows(id, proxy_id, config_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET proxy_id=excluded.proxy_id, config_json=excluded.config_json`)
      .run(value.id, value.proxyId, JSON.stringify(value));
    return value;
  }
  remove(id) { this.db.prepare("DELETE FROM temporary_windows WHERE id=?").run(id); }
}

// Configurations and Chrome profiles survive closing/restarting. Only explicit
// deletion/clearing removes the profile, after the owned Chrome tree is reclaimed.
export class TemporaryWindowManager {
  constructor({ store, dataRoot, proxies, acquireChrome, browserRuns, onChanged = () => {}, probe = lookupThroughProxy }) {
    Object.assign(this, { store, proxies, acquireChrome, browserRuns, onChanged, probe });
    this.profileRoot = path.resolve(dataRoot, "temporary-windows");
    this.sessions = new Map();
    this.pending = new Map();
    this.stopping = false;
    this.abortController = new AbortController();
  }

  require(id) {
    const value = this.store.get(id);
    if (!value) throw error("NOT_FOUND", "临时窗口不存在");
    return value;
  }

  node(id) {
    const node = this.proxies.getNodes().find(value => value.id === id);
    if (!node || node.enabled === false || node.missing) throw error("PROXY_UNAVAILABLE", "所选出口节点不可用，请启用节点或重新选择");
    return node;
  }

  view(value) {
    const node = this.proxies.getNodes().find(node => node.id === value.proxyId);
    const session = this.sessions.get(value.id);
    const run = this.browserRuns?.listActive().find(run => run.accountId === value.id);
    return { ...value, proxyName: node?.name ?? null, proxyUnavailable: !node || node.enabled === false || !!node.missing,
      state: this.pending.has(value.id) ? "busy" : run?.state === "close_failed" ? "close_failed" : session || run ? "open" : "closed",
      openedAt: session?.openedAt ?? null };
  }

  list() { return this.store.list().map(value => this.view(value)); }
  changed() { if (!this.stopping) this.onChanged(this.list()); }
  browserRunChanged(run) {
    if (this.stopping || !run?.accountId?.startsWith("tmp_")) return;
    if (run.state === "closed") this.sessions.delete(run.accountId);
    // Finish broadcasting the source event before publishing its derived state.
    queueMicrotask(() => this.changed());
  }
  proxyIds() { return this.store.list().map(value => value.proxyId); }
  isActive(id) { return this.sessions.has(id) || this.pending.has(id) || this.browserRuns?.listActive().some(run => run.accountId === id); }
  assertIdle(id) {
    if (this.isActive(id)) throw error("RESOURCE_BUSY", "请先关闭此临时窗口并等待任务结束");
  }

  save(input) {
    if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
    const config = normalizeTemporaryWindow(input);
    this.node(config.proxyId);
    const current = input.id ? this.require(input.id) : null;
    if (current) this.assertIdle(current.id);
    const now = new Date().toISOString();
    const changedProxy = current?.proxyId !== config.proxyId;
    const value = { ...current, ...config, id: current?.id ?? `tmp_${randomUUID()}`,
      createdAt: current?.createdAt ?? now, updatedAt: now,
      timezone: changedProxy ? null : current.timezone,
      locale: changedProxy ? null : current.locale,
      exitIp: changedProxy ? null : current.exitIp,
      detectedAt: changedProxy ? null : current.detectedAt };
    this.store.save(value); this.changed();
    return this.view(value);
  }

  async exclusive(id, action) {
    if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
    this.require(id);
    if (this.pending.has(id)) throw error("RESOURCE_BUSY", "此临时窗口正在处理另一项操作");
    // Reserve synchronously, before the first asynchronous probe or launch.
    const task = Promise.resolve().then(action);
    this.pending.set(id, task); this.changed();
    try { return await task; }
    finally { this.pending.delete(id); this.changed(); }
  }

  async detectRegion(id) {
    const value = this.require(id);
    this.node(value.proxyId);
    await this.proxies.ensureRunning();
    if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
    this.node(value.proxyId);
    const proxy = this.proxies.proxyForNode(value.proxyId);
    if (!proxy) throw error("PROXY_UNAVAILABLE", "无法连接所选出口节点");
    const region = await this.probe(proxy.server, { signal: this.abortController.signal });
    if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
    if (!region?.timezone) {
      this.store.save({ ...value, timezone: null, locale: null, exitIp: null, detectedAt: null });
      throw error("PROXY_UNAVAILABLE", "出口 IP 时区探测失败，请检查节点连接后重试");
    }
    const result = { ...value, timezone: region.timezone, locale: region.locale || "en-US",
      exitIp: region.ip ?? null, detectedAt: new Date().toISOString() };
    this.store.save(result); this.changed();
    return result;
  }

  detect(id) {
    this.assertIdle(id);
    return this.exclusive(id, async () => this.view(await this.detectRegion(id)));
  }

  open(id, { operationId = null } = {}) {
    this.assertIdle(id);
    return this.exclusive(id, async () => {
      if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
      const value = await this.detectRegion(id);
      if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
      this.node(value.proxyId);
      await this.profilePath(id); // reject links before Chrome can follow them
      if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
      const controller = new AbortController();
      const session = { controller, openedAt: new Date().toISOString(), launched: null, closing: null };
      this.sessions.set(id, session);
      try {
        session.launched = await this.acquireChrome({ accountId: id, operationId,
          account: { id, profileDir: path.join("temporary-windows", id) },
          purpose: "temporary-window", headless: false, signal: controller.signal,
          launchOptions: { temporaryWindow: value } });
        session.launched.context.once("close", () => {
          // Avoid re-entering the registry's graceful-close callback synchronously.
          setImmediate(() => {
            if (this.sessions.get(id) === session) void this.closeSession(id).catch(() => {});
          });
        });
        if (this.stopping) throw error("AGENT_DRAINING", "Agent 正在退出");
        await session.launched.page.goto(value.homepage, { waitUntil: "domcontentloaded", timeout: 45000 });
        this.changed();
        return { ok: true };
      } catch (cause) {
        await this.closeSession(id).catch(() => {});
        throw cause;
      }
    });
  }

  async closeSession(id) {
    const session = this.sessions.get(id);
    if (session?.closing) return session.closing;
    const close = async () => {
      const run = this.browserRuns?.listActive().find(run => run.accountId === id);
      const result = run?.state === "close_failed" ? await this.browserRuns.recheck(run.browserRunId)
        : session?.launched ? await session.launched.release("temporary-window-close")
          : run ? await this.browserRuns.close(run.browserRunId, "temporary-window-close") : null;
      if ((result && result.state !== "closed") || this.browserRuns?.listActive().some(run => run.accountId === id)) {
        throw error("RESOURCE_BUSY", "Chrome 尚未完全关闭，请重试关闭后再编辑或删除");
      }
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      this.changed();
      return { ok: true };
    };
    const task = close();
    if (session) session.closing = task;
    try { return await task; }
    finally { if (session) session.closing = null; this.changed(); }
  }

  close(id) {
    return this.exclusive(id, () => this.closeSession(id));
  }

  async profilePath(id) {
    assertInput(/^tmp_[0-9a-f-]{36}$/.test(id), "无效的临时窗口标识");
    const target = path.resolve(this.profileRoot, id);
    assertInput(path.dirname(target) === this.profileRoot, "无效的临时窗口目录");
    for (const candidate of [this.profileRoot, target]) {
      try {
        const stat = await fs.lstat(candidate);
        assertInput(stat.isDirectory() && !stat.isSymbolicLink(), "临时窗口目录不能是文件或链接");
      } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
    return target;
  }

  remove(id) {
    this.assertIdle(id);
    return this.exclusive(id, async () => {
      const target = await this.profilePath(id);
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      this.store.remove(id); this.changed();
      return { ok: true };
    });
  }

  clearData(id) {
    this.assertIdle(id);
    return this.exclusive(id, async () => {
      const target = await this.profilePath(id);
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return { ok: true };
    });
  }

  async shutdown() {
    this.stopping = true;
    this.abortController.abort();
    for (const session of this.sessions.values()) session.controller.abort();
    await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id)));
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id)));
  }
}
