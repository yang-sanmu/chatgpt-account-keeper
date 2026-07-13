// ---------- 通用 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------- Tab 切换 ----------
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("#tab-" + t.dataset.tab).classList.add("active");
  })
);

// ---------- 账号 ----------
async function loadAccounts() {
  const accounts = await api("/accounts");
  const tbody = $("#account-rows");
  tbody.innerHTML = "";
  $("#account-empty").hidden = accounts.length > 0;

  const convNames = Object.keys(convCache);
  for (const a of accounts) {
    const tr = document.createElement("tr");
    const opts = convNames
      .map(
        (n) =>
          `<option value="${escapeHtml(n)}" ${
            (a.conversationSet || "default") === n ? "selected" : ""
          }>${escapeHtml(n)}</option>`
      )
      .join("");
    tr.innerHTML = `
      <td>
        <div class="acc-email" data-email="${a.id}">${
          a.email ? escapeHtml(a.email) : "<span class='muted'>未绑定账号</span>"
        }</div>
        <input class="acc-note" data-note="${a.id}" value="${escapeHtml(
          a.note || ""
        )}" placeholder="备注（可选）" />
      </td>
      <td>${statusHtml(a.id, a.loggedIn, a.checkedAt)}</td>
      <td>
        <input type="checkbox" ${a.enabled ? "checked" : ""} data-enable="${a.id}" />
      </td>
      <td>
        <select data-conv-set="${a.id}">${opts}</select>
      </td>
      <td class="actions">
        <button class="btn small" data-login="${a.id}">登录</button>
        <button class="btn small" data-check="${a.id}">刷新状态</button>
        <button class="btn small primary" data-run="${a.id}">立即跑</button>
        <button class="btn small" data-history="${a.id}">历史</button>
        <button class="btn small danger" data-del="${a.id}">删除</button>
      </td>`;
    tbody.appendChild(tr);
  }

  bindAccountActions();
}

// 根据登录状态生成状态单元格。loggedIn: true/false/null(未知)
function statusHtml(id, loggedIn, checkedAt) {
  let dot = "", text = "未知";
  if (loggedIn === true) { dot = "green"; text = "已登录"; }
  else if (loggedIn === false) { dot = "red"; text = "未登录"; }
  const when = checkedAt
    ? `<span class="muted" title="${checkedAt}"> · ${timeAgo(checkedAt)}</span>`
    : "";
  return `<span class="status-dot" data-status="${id}">
    <span class="dot ${dot}"></span>${text}${when}</span>`;
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
  return Math.floor(diff / 86400) + "天前";
}

function bindAccountActions() {
  $$("[data-enable]").forEach((el) =>
    el.addEventListener("change", async () => {
      await api(`/accounts/${el.dataset.enable}`, {
        method: "PATCH",
        body: { enabled: el.checked },
      });
      toast("已更新");
    })
  );

  // 备注：失焦时保存
  $$("[data-note]").forEach((el) =>
    el.addEventListener("change", async () => {
      await api(`/accounts/${el.dataset.note}`, {
        method: "PATCH",
        body: { note: el.value },
      });
      toast("备注已保存");
    })
  );

  // 会话集：随时切换即时保存
  $$("[data-conv-set]").forEach((el) =>
    el.addEventListener("change", async () => {
      await api(`/accounts/${el.dataset.convSet}`, {
        method: "PATCH",
        body: { conversationSet: el.value },
      });
      toast("会话集已更新");
    })
  );

  $$("[data-login]").forEach((el) =>
    el.addEventListener("click", () => doLogin(el.dataset.login))
  );
  $$("[data-check]").forEach((el) =>
    el.addEventListener("click", () => checkStatus(el.dataset.check))
  );
  $$("[data-run]").forEach((el) =>
    el.addEventListener("click", () => runNow(el.dataset.run))
  );
  $$("[data-history]").forEach((el) =>
    el.addEventListener("click", () => openHistory(el.dataset.history))
  );
  $$("[data-del]").forEach((el) =>
    el.addEventListener("click", () => delAccount(el.dataset.del))
  );
}

$("#add-account").addEventListener("click", async () => {
  // 新增账号：直接创建并立即弹出浏览器登录，无需先起名字。
  const acc = await api("/accounts", { method: "POST", body: {} });
  await loadAccounts();
  doLogin(acc.id);
});

async function delAccount(id) {
  if (!confirm("确定删除该账号？其登录态目录不会自动删除。")) return;
  await api(`/accounts/${id}`, { method: "DELETE" });
  toast("已删除");
  loadAccounts();
}

// 手动刷新状态：强制现开浏览器检查（refresh=1）
async function checkStatus(id) {
  const span = $(`[data-status="${id}"]`);
  span.innerHTML = `<span class="dot"></span>检查中…`;
  try {
    const { loggedIn, email } = await api(`/accounts/${id}/status?refresh=1`);
    span.innerHTML = statusInner(loggedIn);
    updateEmailCell(id, email);
  } catch (e) {
    span.innerHTML = `<span class="dot red"></span>错误`;
    toast("检查失败: " + e.message);
  }
}

function statusInner(loggedIn) {
  if (loggedIn === true) return `<span class="dot green"></span>已登录`;
  if (loggedIn === false) return `<span class="dot red"></span>未登录`;
  return `<span class="dot"></span>未知`;
}

function updateEmailCell(id, email) {
  const emailEl = $(`[data-email="${id}"]`);
  if (!emailEl) return;
  if (email) emailEl.textContent = email;
  else emailEl.innerHTML = "<span class='muted'>未绑定账号</span>";
}

// 定时轮询所有账号缓存状态，页面实时更新（不现开浏览器，读后端缓存）
async function pollStatus() {
  try {
    const all = await api("/status");
    for (const [id, st] of Object.entries(all)) {
      const span = $(`[data-status="${id}"]`);
      if (span) span.innerHTML = statusInner(st.loggedIn) +
        (st.checkedAt ? `<span class="muted"> · ${timeAgo(st.checkedAt)}</span>` : "");
      if (st.email) updateEmailCell(id, st.email);
    }
  } catch {
    // 静默失败，下次再试
  }
}

async function runNow(id) {
  toast("已触发，正在跑…");
  try {
    const res = await api(`/accounts/${id}/run`, { method: "POST" });
    toast(res.ok ? "完成，回复已记录" : "失败: " + res.reason);
  } catch (e) {
    toast("出错: " + e.message);
  }
}

// ---------- 登录流程（轮询任务状态）----------
async function doLogin(id) {
  const modal = $("#login-modal");
  const msg = $("#login-msg");
  const closeBtn = $("#login-close");
  modal.hidden = false;
  closeBtn.hidden = true;
  msg.textContent = "正在打开浏览器窗口…";

  let task;
  try {
    task = await api(`/accounts/${id}/login`, { method: "POST" });
  } catch (e) {
    msg.textContent = "发起失败: " + e.message;
    closeBtn.hidden = false;
    return;
  }

  const poll = setInterval(async () => {
    try {
      const t = await api(`/login-tasks/${task.taskId}`);
      msg.textContent = t.message || t.status;
      if (["success", "failed", "timeout"].includes(t.status)) {
        clearInterval(poll);
        closeBtn.hidden = false;
        if (t.status === "success") {
          checkStatus(id);
          toast("登录成功");
        }
      }
    } catch (e) {
      clearInterval(poll);
      msg.textContent = "轮询出错: " + e.message;
      closeBtn.hidden = false;
    }
  }, 2000);
}
$("#login-close").addEventListener("click", () => ($("#login-modal").hidden = true));

// ---------- 历史 ----------
async function openHistory(id) {
  const drawer = $("#history-drawer");
  const body = $("#history-body");
  $("#history-title").textContent = `历史记录 - ${id}`;
  body.innerHTML = "加载中…";
  drawer.hidden = false;
  try {
    const items = await api(`/accounts/${id}/history?limit=50`);
    if (items.length === 0) {
      body.innerHTML = '<p class="empty">暂无记录</p>';
      return;
    }
    body.innerHTML = items
      .map((it) => {
        const cls = it.ok ? "" : "fail";
        const ans = it.ok ? escapeHtml(it.reply || "") : "失败: " + escapeHtml(it.reason || "");
        return `<div class="hist-item ${cls}">
          <div class="meta">${it.time}</div>
          <div class="q">${escapeHtml(it.prompt || "(无 prompt)")}</div>
          <div class="a">${ans}</div>
        </div>`;
      })
      .join("");
  } catch (e) {
    body.innerHTML = '<p class="empty">加载失败: ' + escapeHtml(e.message) + "</p>";
  }
}
$("#history-close").addEventListener("click", () => ($("#history-drawer").hidden = true));

// ---------- 会话内容 ----------
let convCache = {}; // 会话集缓存，供账号行的下拉使用

// 一个 prompt 一行输入框。用“添加一行”按钮明确新增，不靠回车。
function promptRow(text = "") {
  const div = document.createElement("div");
  div.className = "prompt-row";
  div.innerHTML = `
    <input class="prompt-input" value="${escapeHtml(text)}" placeholder="输入一条对话内容" />
    <button class="btn small danger row-del" title="删除此行">×</button>`;
  div.querySelector(".row-del").addEventListener("click", () => div.remove());
  return div;
}

async function loadConversations() {
  convCache = await api("/conversations");
  const list = $("#conv-list");
  list.innerHTML = "";
  for (const [name, set] of Object.entries(convCache)) {
    const card = document.createElement("div");
    card.className = "conv-card";
    card.innerHTML = `
      <h3>${escapeHtml(name)}</h3>
      <div class="prompt-list" data-conv="${escapeHtml(name)}"></div>
      <div class="row">
        <button class="btn small add-row">+ 添加一行</button>
        <label>抽取策略：
          <select data-strategy="${escapeHtml(name)}">
            <option value="random" ${set.pickStrategy !== "sequential" ? "selected" : ""}>随机</option>
            <option value="sequential" ${set.pickStrategy === "sequential" ? "selected" : ""}>顺序</option>
          </select>
        </label>
        <button class="btn primary small" data-save-conv="${escapeHtml(name)}">保存</button>
        <button class="btn danger small" data-del-conv="${escapeHtml(name)}">删除会话集</button>
      </div>`;
    const listEl = card.querySelector(".prompt-list");
    const prompts = set.prompts && set.prompts.length ? set.prompts : [""];
    prompts.forEach((p) => listEl.appendChild(promptRow(p)));
    card.querySelector(".add-row").addEventListener("click", () => {
      const row = promptRow("");
      listEl.appendChild(row);
      row.querySelector(".prompt-input").focus();
    });
    list.appendChild(card);
  }

  $$("[data-save-conv]").forEach((el) =>
    el.addEventListener("click", async () => {
      const name = el.dataset.saveConv;
      const prompts = [...$(`[data-conv="${name}"]`).querySelectorAll(".prompt-input")]
        .map((i) => i.value.trim())
        .filter(Boolean);
      const pickStrategy = $(`[data-strategy="${name}"]`).value;
      await api(`/conversations/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: { prompts, pickStrategy },
      });
      toast("已保存");
    })
  );
  $$("[data-del-conv]").forEach((el) =>
    el.addEventListener("click", async () => {
      if (!confirm(`删除会话集 ${el.dataset.delConv}？`)) return;
      await api(`/conversations/${encodeURIComponent(el.dataset.delConv)}`, {
        method: "DELETE",
      });
      toast("已删除");
      loadConversations();
    })
  );
}

$("#add-set").addEventListener("click", async () => {
  const name = prompt("会话集名称（英文/数字，如 default）");
  if (!name) return;
  await api(`/conversations/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: { prompts: [], pickStrategy: "random" },
  });
  loadConversations();
});

// ---------- 设置 ----------
async function loadSettings() {
  const s = await api("/settings");
  const f = $("#settings-form");
  f.intervalMinutes.value = s.intervalMinutes;
  f.jitterMinutes.value = s.jitterMinutes;
  f.statusCheckMinutes.value = s.statusCheckMinutes;
  f.headless.checked = !!s.headless;
}
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  await api("/settings", {
    method: "PUT",
    body: {
      intervalMinutes: Number(f.intervalMinutes.value),
      jitterMinutes: Number(f.jitterMinutes.value),
      statusCheckMinutes: Number(f.statusCheckMinutes.value),
      headless: f.headless.checked,
    },
  });
  toast("设置已保存");
});

// ---------- 调度器 ----------
async function loadScheduler() {
  const s = await api("/scheduler");
  const pill = $("#sched-state");
  const btn = $("#sched-toggle");
  if (s.running) {
    pill.textContent = "调度器: 运行中";
    pill.className = "pill on";
    btn.textContent = "停止调度";
  } else {
    pill.textContent = "调度器: 已停止";
    pill.className = "pill off";
    btn.textContent = "启动调度";
  }
}
$("#sched-toggle").addEventListener("click", async () => {
  const s = await api("/scheduler");
  await api(s.running ? "/scheduler/stop" : "/scheduler/start", { method: "POST" });
  toast(s.running ? "已请求停止" : "已启动");
  setTimeout(loadScheduler, 500);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- 初始化 ----------
// 先加载会话集（账号行的下拉依赖 convCache），再加载账号
async function init() {
  await loadConversations();
  await loadAccounts();
  loadSettings();
  loadScheduler();
  pollStatus();
}
init();
setInterval(loadScheduler, 8000);
setInterval(pollStatus, 10000); // 每 10 秒刷新账号状态显示（读后端缓存）
