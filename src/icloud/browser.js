import { createHash } from "node:crypto";
import { IcloudError, parseIcloudList, classifyIcloudFailure } from "./model.js";

export const ICLOUD_HOME = "https://www.icloud.com.cn/icloudplus/";
export const ICLOUD_RESOURCE = "icloud_primary";
export const ICLOUD_PROFILE = "icloud-profiles/primary";

export function hmeEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^(?:p\d+-)?maildomainws\.icloud\.com(?:\.cn)?$/.test(url.hostname) || !/^\/v\d+\/hme\//.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export class IcloudBrowser {
  constructor({ acquireChrome, onList = () => {}, onClosed = () => {}, signal }) {
    Object.assign(this, { acquireChrome, onList, onClosed, signal });
    this.launched = null; this.sequence = 0; this.syncSince = 0; this.latest = null; this.failure = null; this.responseTasks = new Set(); this.closing = false;
  }
  async launch(config, { headed = false, operationId = null } = {}) {
    this.launched = await this.acquireChrome({ accountId: ICLOUD_RESOURCE, account: { id: ICLOUD_RESOURCE, profileDir: ICLOUD_PROFILE },
      purpose: "icloud", operationId, headless: !headed, signal: this.signal,
      launchOptions: { icloud: { networkMode: config.networkMode }, manual: false } });
    this.page = this.launched.page;
    this.page.on("response", this.responseListener = response => {
      const url = hmeEndpoint(response.url());
      if (!url) return;
      const sequence = ++this.sequence;
      const task = this.readResponse(response, url, sequence).catch(() => {
        this.failure = new IcloudError("service", "读取 iCloud 响应失败，已保留已有数据");
      }).finally(() => this.responseTasks.delete(task));
      this.responseTasks.add(task);
    });
    this.launched.context.once("close", () => this.onClosed());
    return this;
  }
  rejectResponse(response, failure) {
    // Only a rejection of this exact submitted address can clear durable intent.
    // A concurrent list request failing does not prove creation was rejected.
    try {
      const request = response.request();
      if (this.submittedCandidate && request.method() === "POST" && request.postDataJSON()?.hme === this.submittedCandidate) failure.creationRejected = true;
    } catch { /* Unknown request shape keeps the result uncertain. */ }
    this.failure = failure;
  }
  async readResponse(response, url, sequence) {
    if (this.closing) return;
    const isList = /\/hme\/list\/?$/.test(url.pathname);
    const status = response.status(); const retryAfter = response.headers()["retry-after"];
    // Set explicit status failures before awaiting the body. Otherwise the UI's
    // generic error can win the race and hide a verified rejection of the POST.
    if ([401, 403, 421, 429, 450].includes(status)) {
      this.rejectResponse(response, classifyIcloudFailure({ status, retryAfter })); return;
    }
    let body = null;
    try { body = await response.json(); } catch { /* status still detects auth/rate limiting */ }
    if (this.closing) return;
    // Navigating for a new sync can abort a previous list's body. That old
    // response must not fail the fresh sync or replace a newer list snapshot.
    if (isList && (sequence <= this.syncSince || sequence < (this.latest?.sequence ?? 0))) return;
    const failure = classifyIcloudFailure({ status, body, retryAfter });
    if (failure) {
      this.rejectResponse(response, failure); return;
    }
    if (!isList) return;
    const dsid = url.searchParams.get("dsid");
    if (!dsid || !/^\d+$/.test(dsid)) { this.failure = new IcloudError("format", "无法确认 iCloud 账号标识，已停止同步"); return; }
    try {
      const emails = parseIcloudList(body);
      const accountKey = createHash("sha256").update(`${url.hostname.endsWith(".cn") ? "cn" : "global"}:${dsid}`).digest("hex");
      this.latest = { accountKey, emails, sequence };
      this.onList(this.latest);
    } catch (error) { this.failure = error instanceof IcloudError ? error : new IcloudError("format", "iCloud 列表读取失败"); }
  }
  async waitFor(probe, timeout = 30_000, timeoutMessage = "等待 iCloud 页面超时，请检查网络和登录状态") {
    const deadline = Date.now() + timeout;
    do {
      if (this.signal?.aborted || this.closing || this.page.isClosed()) throw new IcloudError("cancelled", "iCloud 操作已停止");
      if (this.failure) throw this.failure;
      let value;
      try { value = await probe(); }
      catch (error) { throw this.failure ?? error; }
      if (this.failure) throw this.failure;
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new IcloudError("timeout", timeoutMessage);
  }
  frame() { return this.page.frames().find(frame => /\/applications\/hidemyemail\//.test(frame.url())); }
  async managementEntry() {
    const visible = [];
    // The title and its full-card overlay button are siblings. Clicking the
    // title is intercepted; use the dialog button inside the named article.
    for (const frame of this.page.frames()) {
      const entries = frame.getByRole("article", { name: /^(隐藏邮件地址|Hide My Email)$/i }).locator('button[aria-haspopup="dialog"]');
      for (let i = 0, count = await entries.count(); i < count; i++) {
        const entry = entries.nth(i);
        if (await entry.isVisible()) visible.push(entry);
      }
    }
    return visible.length === 1 ? visible[0] : null;
  }
  async openManagement() {
    let opened = false;
    return this.waitFor(async () => {
      const frame = this.frame();
      const add = frame?.getByRole("button", { name: /^(添加|设置新的电子邮件地址|Add|Set Up New Email Address)$/i });
      if (add && await add.count() === 1 && await add.isVisible()) return frame;
      if (!opened) {
        const entry = await this.managementEntry();
        if (entry) {
          await this.clickManagement(entry);
          opened = true;
        }
      }
      return null;
    }, 30_000, "未能打开隐藏邮件地址管理窗口，请打开 iCloud 检查页面");
  }
  async clickManagement(entry) {
    try { await entry.click({ timeout: 10_000 }); }
    catch (error) {
      const reason = /detached/.test(error.message) ? "页面正在切换" : "入口无法点击";
      throw new IcloudError("format", `未能打开隐藏邮件地址：${reason}，未提交操作`);
    }
  }
  async openLogin() {
    try { await this.page.goto(ICLOUD_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 }); }
    catch (error) {
      if (this.signal?.aborted || this.closing || this.page.isClosed()) throw new IcloudError("cancelled", "iCloud 操作已停止");
      if (this.failure) throw this.failure;
      const timedOut = error.name === "TimeoutError";
      throw new IcloudError(timedOut ? "timeout" : "service", timedOut ? "打开 iCloud 页面超时，请检查网络后重试" : "打开 iCloud 页面失败，请检查网络后重试");
    }
  }
  async sync() {
    this.failure = null;
    this.submittedCandidate = null;
    const since = this.syncSince = this.sequence;
    await this.openLogin();
    let opened = false; let loginVisibleSince = null;
    const list = await this.waitFor(async () => {
      if (this.latest && this.latest.sequence > since) return this.latest;
      // The public landing page can flash while iCloud restores its session.
      // Require a stable signed-out view instead of cancelling that restoration.
      if (await this.page.getByRole("button", { name: /^(登录|Sign In)$/ }).isVisible().catch(() => false)) {
        loginVisibleSince ??= Date.now();
        if (Date.now() - loginVisibleSince >= 5000) throw new IcloudError("auth", "请打开 iCloud 浏览器手动登录，选择保持登录后同步列表");
      } else loginVisibleSince = null;
      if (!this.frame() && !opened) {
        const entry = await this.managementEntry();
        if (entry) { opened = true; await this.clickManagement(entry); }
      }
      return null;
    }, 45_000);
    return this.latest ?? list;
  }
  async create(config, beforeSubmit) {
    this.failure = null;
    // The iCloud+ landing card also fetches the list, so sync can finish before
    // the management iframe opens. Always enter management explicitly for create.
    const frame = await this.openManagement();
    const add = frame.getByRole("button", { name: /^(添加|设置新的电子邮件地址|Add|Set Up New Email Address)$/i });
    // The list response can finish before the iframe has rendered its controls.
    await this.waitFor(async () => await add.count() === 1 && await add.isVisible(), 30_000, "未找到新增邮箱按钮，请打开 iCloud 检查页面");
    await add.click({ timeout: 10_000 });
    // Limit errors come from HME responses. Page text also contains addresses,
    // labels and notes, which must not be interpreted as service errors.
    await this.waitFor(() => frame.getByRole("button", { name: /^(创建电子邮件地址|Create email address)$/i }).isVisible(),
      30_000, "新增邮箱表单未就绪，请打开 iCloud 检查页面");
    // The form renders before its generated address arrives. Read the dedicated
    // address element, not the underlying list, and wait until generation ends.
    const candidate = await this.waitFor(async () => {
      const address = frame.locator(".AddEmailPage .GeneratedEmail-hme");
      const count = await address.count();
      if (count > 1) throw new IcloudError("format", "出现多个候选邮箱控件，未提交创建");
      if (!count || !await address.isVisible()) return null;
      const email = (await address.innerText()).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
      if (this.latest?.emails.some(row => row.email.toLowerCase() === email.toLowerCase())) throw new IcloudError("format", "候选邮箱已在列表中，未重复提交");
      return email;
    }, 30_000, "等待候选邮箱生成超时，未提交创建");
    const labelText = /为电子邮件地址设置标签|Label your email address/i;
    const label = frame.getByRole("textbox", { name: labelText }).or(frame.getByPlaceholder(labelText));
    const note = frame.locator("textarea");
    try { await label.fill(config.label, { timeout: 5000 }); }
    catch { throw new IcloudError("format", "无法填写固定标签，未提交创建，请检查 iCloud 表单"); }
    try { await note.fill(config.note, { timeout: 5000 }); }
    catch { throw new IcloudError("format", "无法填写固定备注，未提交创建，请检查 iCloud 表单"); }
    if (await label.inputValue() !== config.label || await note.inputValue() !== config.note) {
      throw new IcloudError("format", "页面未完整保留固定标签或备注，未提交创建，请检查长度限制");
    }
    const submit = frame.getByRole("button", { name: /^(创建电子邮件地址|Create email address)$/i });
    if (!await submit.isEnabled()) throw new IcloudError("format", "创建按钮不可用，请检查标签配置");
    // Durable intent BEFORE submission; a lost acknowledgement must never cause another create.
    beforeSubmit(candidate);
    this.submittedCandidate = candidate;
    await submit.click({ timeout: 10_000 });
    await this.waitFor(async () => {
      const body = await frame.locator("body").innerText({ timeout: 5000 });
      if (/已创建电子邮件地址|(?:email address|address).{0,80}(?:created|ready to use)|created.{0,80}(?:email address|address)/i.test(body) && body.includes(candidate)) return true;
      return false;
    }, 30_000, "未收到创建完成提示，请同步列表核对结果");
    return candidate;
  }
  async assertDetailEmail(frame, email) {
    await this.waitFor(async () => {
      const address = frame.locator(".EmailDetail-hmeField .LabeledField-value");
      if (await address.count() !== 1 || !await address.isVisible()) return false;
      if ((await address.innerText()).trim().toLowerCase() !== email.toLowerCase()) {
        throw new IcloudError("format", "邮箱详情与待删除地址不一致，未提交操作");
      }
      return true;
    }, 20_000, "未找到待删除邮箱的详情，未提交操作");
  }
  async confirmEmailAction(frame, row, action, beforeSubmit = () => {}) {
    const alert = frame.getByRole("dialog").filter({ has: frame.locator("#alert-panel") });
    const prompt = action === "deactivate" ? /^(?:是否要停用此电子邮件地址[？?]|停用电子邮件地址[？?]|Deactivate email address\?)$/i : /^(?:是否要删除此电子邮件地址[？?]|删除电子邮件地址[？?]|Delete email address\?)$/i;
    const name = action === "deactivate" ? /^(停用|Deactivate)$/i : /^(删除|刪除|Delete)$/i;
    await this.waitFor(async () => await alert.count() === 1 && await alert.isVisible() && await alert.getByText(prompt).count() === 1,
      15_000, "未找到邮箱操作确认窗口，未提交操作");
    await this.assertDetailEmail(frame, row.email);
    beforeSubmit();
    const [response] = await Promise.all([
      this.page.waitForResponse(response => {
        const url = hmeEndpoint(response.url());
        if (!url || !url.pathname.endsWith(`/hme/${action}`) || response.request().method() !== "POST") return false;
        try { return response.request().postDataJSON()?.anonymousId === row.id; } catch { return false; }
      }, { timeout: 30_000 }),
      alert.getByRole("button", { name }).click({ timeout: 10_000 }),
    ]);
    const body = await response.json().catch(() => null);
    const failure = classifyIcloudFailure({ status: response.status(), body, retryAfter: response.headers()["retry-after"] });
    if (failure) throw failure;
    if (body?.success !== true) throw new IcloudError("uncertain", "未收到明确的操作结果，请同步列表核对");
  }
  async delete(row, beforeDelete) {
    this.failure = null;
    const current = this.latest?.emails.find(item => item.id === row.id && item.email === row.email);
    if (!current || !["active", "inactive"].includes(current.remoteState)) throw new IcloudError("format", "待删除邮箱不在最新云端列表中，未提交操作");
    const frame = await this.openManagement();
    // Match the dedicated address field, never labels or notes containing an address.
    const findButton = scope => scope.getByRole("button").filter({ has: frame.locator(".searchable-card-subtitle").filter({ hasText: new RegExp(`^${row.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }) });
    if (current.remoteState === "active") {
      const active = findButton(frame);
      await this.waitFor(async () => await active.count() === 1, 20_000, "未找到唯一的待停用邮箱，未提交操作");
      await active.click({ timeout: 10_000 });
      await this.assertDetailEmail(frame, row.email);
      await frame.getByRole("button", { name: /^(停用电子邮件地址|Deactivate email address)$/i }).click({ timeout: 10_000 });
      await this.confirmEmailAction(frame, row, "deactivate");
    }
    const inactive = findButton(frame.locator(".HomePage-inactiveEmailList"));
    await this.waitFor(async () => await inactive.count() === 1, 20_000, "停用列表中未找到此邮箱，已停止删除，请同步核对");
    await inactive.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await inactive.click({ timeout: 10_000 });
    await this.assertDetailEmail(frame, row.email);
    await frame.getByRole("button", { name: /^(删除地址|删除电子邮件地址|Delete address)$/i }).click({ timeout: 10_000 });
    await this.confirmEmailAction(frame, row, "delete", beforeDelete);
    await this.waitFor(async () => !await frame.locator("#alert-panel").isVisible(), 20_000, "删除已提交，等待页面更新超时，请同步核对");
  }
  async close() {
    this.closing = true;
    if (this.page && this.responseListener) this.page.off("response", this.responseListener);
    const result = await this.launched?.release("icloud-close");
    await Promise.allSettled([...this.responseTasks]);
    if (result && result.state !== "closed") throw new IcloudError("close", "iCloud 浏览器尚未完全关闭，请重试关闭");
  }
}
