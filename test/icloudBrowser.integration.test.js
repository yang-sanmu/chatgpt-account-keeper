import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { IcloudBrowser, ICLOUD_PROFILE } from "../src/icloud/browser.js";
import { IcloudManager } from "../src/icloud/manager.js";
import { ICLOUD_DEFAULT_CONFIG, initialIcloudData, HOUR } from "../src/icloud/model.js";

const enabled = process.env.GPT_ACCOUNT_ICLOUD_LAB === "1";
// All requests are intercepted locally. No real iCloud account, cookies or remote mutations.
for (const language of ["zh-CN", "en-US"]) {
test(`real Chrome ${language} exercises landing list, management navigation, fixed fields, commit and 429`, { skip: !enabled, timeout: 90_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keeper-icloud-browser-"));
  const contexts = []; let created = false; let limited = false; let commits = 0; let submitted; let automaticLab = false; let failNextList = false; let malformedLists = 0;
  t.after(async () => { await Promise.allSettled(contexts.map(context => context.close())); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const endpoint = "https://p203-maildomainws.icloud.com.cn/v2/hme/";
  const words = language === "zh-CN" ? { title: "隐藏邮件地址", add: "添加", label: "为电子邮件地址设置标签（例如“购物”）", submit: "创建电子邮件地址", success: "已创建电子邮件地址。你可以拷贝此地址并可随时使用。" }
    : { title: "Hide My Email", add: "Add", label: "Label your email address (for example, Shopping)", submit: "Create email address", success: "Your email address has been created. You can copy it and use it any time." };
  const form = `<html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="view"></main><script>
    const api = ${JSON.stringify(endpoint)};
    async function start() {
      await fetch(api + 'list?dsid=123');
      view.innerHTML = '<h1>${words.title}</h1><button id="add">${words.add}</button>';
      add.onclick = () => {
        view.innerHTML = '<aside>existing@example.com private@example.com quota@example.com 已达上限的旧邮箱备注</aside><div class="AddEmailPage"><h1>New</h1><p class="GeneratedEmail-hme" id="generated"></p><input id="label" ${language === "zh-CN" ? `aria-label="${words.label}"` : ""} placeholder="${words.label}"><textarea id="note"></textarea><button id="submit" disabled>${words.submit}</button></div>';
        setTimeout(() => generated.textContent = 'fixture@example.com', 800);
        label.oninput = () => submit.disabled = !label.value.trim();
        submit.onclick = async () => {
          const result = await fetch(api + 'reserve?dsid=123', {method:'POST', body:JSON.stringify({hme:'fixture@example.com',label:label.value,note:note.value})});
          if (result.ok && (await result.json()).success) view.innerHTML = '<h1>G</h1><p>${words.success}</p><p>fixture@example.com</p><button>返回</button>';
          else view.innerHTML = '<p>请稍后再试</p>';
        };
      };
    }
    start();
  </script></body></html>`;
  const acquireChrome = async request => {
    assert.equal(request.account.profileDir, ICLOUD_PROFILE);
    const context = await chromium.launchPersistentContext(path.join(root, "profile"), { channel: "chrome", headless: true, locale: "zh-CN", args: ["--no-proxy-server"] });
    contexts.push(context);
    context.on("page", page => page.on("pageerror", error => t.diagnostic(error.message)));
    context.pages()[0].on("pageerror", error => t.diagnostic(error.message));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/icloudplus/") return route.fulfill({ contentType: "text/html", body: '<iframe title="iCloud+" src="/applications/settings/index.html"></iframe>' });
      if (url.pathname === "/applications/settings/index.html") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><button>登录</button><script>setTimeout(async () => { await fetch('${endpoint}list?dsid=123'); setTimeout(() => { document.body.innerHTML = '<article aria-label="${words.title}" style="position:relative"><h2>${words.title}</h2><button id="manage" aria-haspopup="dialog" aria-label="Show more options for ${words.title}" style="position:absolute;inset:0;width:100%;height:100%;background:transparent;border:0"></button></article>'; manage.onclick = () => { document.body.innerHTML = '<iframe title="${words.title}" src="/applications/hidemyemail/current/${language}/index.html"></iframe>'; }; }, 600); }, 800);</script>` });
      if (url.pathname.includes("/applications/hidemyemail/")) return route.fulfill({ contentType: "text/html", body: form.replaceAll("fixture@example.com", automaticLab && created ? "rejected@example.com" : "fixture@example.com") });
      const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
      if (url.pathname.endsWith("/hme/list") && failNextList) {
        failNextList = false; malformedLists++;
        return route.fulfill({ headers, body: '{}' });
      }
      if (url.pathname.endsWith("/hme/list")) return route.fulfill({ headers, body: JSON.stringify({ success: true, result: { forwardToEmails: ["private@example.com"], hmeEmails: [{ anonymousId: "existing-id", hme: "existing@example.com", label: "G", note: "", isActive: true, createTimestamp: 1792600000000 }, ...(created ? [{ anonymousId: "fixture-id", hme: "fixture@example.com", label: submitted.label, note: submitted.note, isActive: true, createTimestamp: 1792660000000 }] : [])] } }) });
      if (url.pathname.endsWith("/hme/reserve")) {
        commits++; submitted = JSON.parse(route.request().postData());
        if (limited) return route.fulfill({ status: 429, headers: { ...headers, "retry-after": "3600" }, body: '{"success":false}' });
        if (automaticLab && created) return route.fulfill({ headers, body: JSON.stringify({ success: false, error: { errorCode: "-41015", errorMessage: "You have reached the limit of addresses you can create right now. Please try again later.", retryAfter: 2 } }) });
        created = true; failNextList = automaticLab;
        return route.fulfill({ headers, body: '{"success":true}' });
      }
      return route.abort();
    });
    return { context, page: context.pages()[0], release: async () => { await context.close(); return { state: "closed" }; } };
  };
  const browser = new IcloudBrowser({ acquireChrome });
  await browser.launch(ICLOUD_DEFAULT_CONFIG);
  assert.equal((await browser.sync()).emails.length, 1);
  let intent;
  const config = { ...ICLOUD_DEFAULT_CONFIG, label: "固定标签", note: "固定云端备注" };
  assert.equal(await browser.create(config, email => { intent = email; assert.equal(commits, 0); }), "fixture@example.com");
  assert.equal(intent, "fixture@example.com"); assert.deepEqual(submitted, { hme: intent, label: config.label, note: config.note });
  assert.equal((await browser.sync()).emails.find(row => row.id === "fixture-id").cloudNote, config.note);
  limited = true; created = false;
  await browser.sync();
  await assert.rejects(browser.create(config, () => {}), error => error.kind === "rate_limit" && error.creationRejected === true);
  await browser.close(); assert.equal(commits, 2);
  // Exercise the manager and real page together: success, HTTP 200 rejection,
  // automatic list reconciliation, cooldown, and another scheduled round.
  automaticLab = true; limited = false; created = false;
  let data = initialIcloudData(); let now = Date.now();
  const manager = new IcloudManager({ store: { load: () => structuredClone(data), save: value => { data = structuredClone(value); } },
    dataRoot: root, acquireChrome, now: () => now, setTimer: () => null, clearTimer() {} });
  t.after(() => manager.shutdown());
  await manager.sync();
  manager.saveConfig({ ...config, enabled: true, mode: "until_limit", intervalMinutes: 60 });
  assert.deepEqual(await manager.runNow(), { ok: true, count: 1, limited: true });
  assert.equal(commits, 4);
  assert.equal(malformedLists, 1, "post-create list failure is recovered without another submission");
  assert.ok(data.history.some(row => row.action === "sync" && row.outcome === "retry"));
  assert.equal(data.pendingCreate, null);
  assert.equal(data.config.enabled, true);
  assert.equal(data.status, "cooldown");
  assert.ok(data.nextRunAt >= now + HOUR);
  const previousNextRunAt = data.nextRunAt; const previousCooldown = data.cooldownUntil;
  now += 10 * 60_000;
  assert.deepEqual(await manager.runNow(), { ok: true, count: 0, limited: true });
  assert.equal(commits, 5, "manual retry reaches iCloud during cooldown");
  assert.equal(data.nextRunAt, previousNextRunAt);
  assert.equal(data.cooldownUntil, previousCooldown);
  assert.equal(data.pendingCreate, null);
  now = data.nextRunAt; created = false;
  await manager.tick();
  assert.equal(commits, 7);
  assert.equal(malformedLists, 2);
  assert.equal(data.pendingCreate, null);
  assert.equal(data.config.enabled, true);
  assert.equal(data.status, "cooldown");
});
}
