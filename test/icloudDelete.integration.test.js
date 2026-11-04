import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { IcloudManager } from "../src/icloud/manager.js";
import { initialIcloudData } from "../src/icloud/model.js";

// Requests never leave this local fixture. Selectors and response shapes follow
// the observed iCloud active detail -> confirmation -> inactive detail flow.
for (const language of ["en", "zh"]) {
  test(`Chrome ${language}: deletes active/inactive addresses and rejects mismatched detail`, { skip: process.env.GPT_ACCOUNT_ICLOUD_LAB !== "1", timeout: 90_000 }, async t => {
    const words = language === "en"
      ? { add: "Add", deactivate: "Deactivate email address", deactivatePrompt: "Deactivate email address?", deactivateConfirm: "Deactivate", remove: "Delete address", deletePrompt: "Delete email address?", deleteConfirm: "Delete" }
      : { add: "添加", deactivate: "停用电子邮件地址", deactivatePrompt: "是否要停用此电子邮件地址？", deactivateConfirm: "停用", remove: "删除地址", deletePrompt: "删除电子邮件地址？", deleteConfirm: "刪除" };
    let remote = [
      { anonymousId: "active", hme: "active@example.com", label: "G", note: "inactive@example.com", isActive: true, createTimestamp: 1792600000000 },
      { anonymousId: "inactive", hme: "inactive@example.com", label: "G", note: "", isActive: false, createTimestamp: 1792600000000 },
      { anonymousId: "keep", hme: "keep@example.com", label: "G", note: "", isActive: true, createTimestamp: 1792600000000 },
    ];
    const submitted = []; let mismatchedDetail = false;
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const endpoint = "https://p203-maildomainws.icloud.com.cn/v1/hme/";
    const html = `<meta charset="utf-8"><div id="view"></div><script>
      const api = ${JSON.stringify(endpoint)}, words = ${JSON.stringify(words)};
      let rows;
      async function home() {
        rows = (await (await fetch(api+'list?dsid=123')).json()).result.hmeEmails;
        view.innerHTML = '<button>'+words.add+'</button><div class="active"></div><div class="HomePage-inactiveEmailList" style="margin-top:1200px"></div>';
        for (const row of rows) {
          const button = document.createElement('button');
          button.innerHTML = '<b>G</b><span class="searchable-card-subtitle">'+row.hme+'</span><small>'+row.note+'</small>';
          button.onclick = () => detail(row);
          view.querySelector(row.isActive ? '.active' : '.HomePage-inactiveEmailList').append(button);
        }
      }
      function detail(row) {
        view.innerHTML = '<div class="EmailDetail-hmeField"><p class="LabeledField-value">'+(window.mismatch ? 'wrong@example.com' : row.hme)+'</p></div><button id="action">'+(row.isActive ? words.deactivate : words.remove)+'</button>';
        action.onclick = () => {
          const kind = row.isActive ? 'deactivate' : 'delete';
          const alert = document.createElement('div'); alert.setAttribute('role', 'dialog');
          alert.innerHTML = '<div class="modal-content"><div id="alert-panel"><h2>'+(row.isActive ? words.deactivatePrompt : words.deletePrompt)+'</h2></div></div><footer><button>'+(row.isActive ? words.deactivateConfirm : words.deleteConfirm)+'</button></footer>';
          view.append(alert);
          alert.querySelector('button').onclick = async () => {
            const result = await (await fetch(api+kind+'?dsid=123',{method:'POST',body:JSON.stringify({anonymousId:row.anonymousId})})).json();
            if(result.success) await home();
          };
        };
      }
      home();
    </script>`;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/icloudplus/") return route.fulfill({ contentType: "text/html", body: '<iframe src="/applications/hidemyemail/current/index.html" style="height:700px;width:800px"></iframe>' });
      if (url.pathname.includes("/applications/hidemyemail/")) return route.fulfill({ contentType: "text/html", body: html.replace("home();\n    </script>", `window.mismatch = ${mismatchedDetail}; home();\n    </script>`) });
      const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
      if (url.pathname.endsWith("/list")) return route.fulfill({ headers, body: JSON.stringify({ success: true, result: { hmeEmails: remote } }) });
      if (/\/(deactivate|delete)$/.test(url.pathname)) {
        const id = route.request().postDataJSON().anonymousId;
        const row = remote.find(row => row.anonymousId === id);
        assert.ok(row); submitted.push([url.pathname.split("/").at(-1), id]);
        if (url.pathname.endsWith("/deactivate")) row.isActive = false;
        else { assert.equal(row.isActive, false); remote = remote.filter(row => row.anonymousId !== id); }
        return route.fulfill({ headers, body: '{"success":true,"result":{"message":"ok"}}' });
      }
      return route.abort();
    });
    let saved = initialIcloudData(); saved.config.enabled = false;
    const manager = new IcloudManager({
      store: { load: () => structuredClone(saved), save: value => { saved = structuredClone(value); } },
      dataRoot: process.cwd(), setTimer: () => null, clearTimer() {},
      acquireChrome: async () => ({ context, page: await context.newPage(), release: async () => ({ state: "closed" }) }),
    });
    t.after(() => manager.shutdown());
    assert.deepEqual(await manager.delete({ emails: ["active@example.com", "inactive@example.com", "absent@example.com", "ACTIVE@example.com"] }), { ok: true, count: 2, skipped: 1 });
    assert.deepEqual(submitted, [["deactivate", "active"], ["delete", "active"], ["delete", "inactive"]]);
    assert.deepEqual(manager.state().emails.map(row => row.email), ["keep@example.com"]);
    mismatchedDetail = true;
    await assert.rejects(manager.delete({ emails: ["keep@example.com"] }), /不一致/);
    assert.equal(submitted.length, 3);
  });
}
