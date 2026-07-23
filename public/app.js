// ==========================================================================
// ChatGPT Keeper - Frontend Logic & Interactive Controller
// ==========================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// State & Caches
let accountsCache = [];
let convCache = {};
let historyCache = [];
let currentDrawerAccountId = null;

// Search & Filter State
let accountSearchQuery = "";
let accountStatusFilter = "all";
let topicSearchQuery = "";
let historySearchQuery = "";
let historyStatusFilter = "all";

// ---------- API Wrapper & Utilities ----------
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
function toast(msg, type = "info") {
  const el = $("#toast");
  const iconEl = el.querySelector(".toast-icon");
  const textEl = el.querySelector(".toast-text");

  if (type === "success") {
    iconEl.textContent = "✓";
    el.className = "toast toast-success";
  } else if (type === "error") {
    iconEl.textContent = "✕";
    el.className = "toast toast-error";
  } else {
    iconEl.textContent = "ℹ";
    el.className = "toast";
  }

  textEl.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

function setBtnLoading(btn, isLoading, loadingText = "") {
  if (!btn) return;
  if (isLoading) {
    btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span>${loadingText ? `<span>${loadingText}</span>` : ""}`;
  } else {
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
    btn.disabled = false;
  }
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function timeAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
  return Math.floor(diff / 86400) + "天前";
}

function fmtLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

// ---------- Tab Switch ----------
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("#tab-" + t.dataset.tab).classList.add("active");
  })
);

// ---------- Global Dashboard Stats ----------
function updateStats() {
  const totalAcc = accountsCache.length;
  const loggedAcc = accountsCache.filter((a) => a.loggedIn === true).length;
  const totalTopics = Object.keys(convCache).length;

  $("#stat-total-accounts").textContent = totalAcc;
  $("#stat-logged-accounts").textContent = loggedAcc;
  $("#stat-total-topics").textContent = totalTopics;
  $("#badge-account-count").textContent = totalAcc;
  $("#badge-topic-count").textContent = totalTopics;
}

// ---------- 账号管理 ----------
async function loadAccounts() {
  try {
    accountsCache = await api("/accounts");
    updateStats();
    renderAccounts();
  } catch (e) {
    toast("加载账号失败: " + e.message, "error");
  }
}

function renderAccounts() {
  const tbody = $("#account-rows");
  tbody.innerHTML = "";

  // 过滤账号
  let filtered = accountsCache.filter((a) => {
    const q = accountSearchQuery.toLowerCase();
    const matchQuery = !q || (a.email && a.email.toLowerCase().includes(q)) || (a.note && a.note.toLowerCase().includes(q)) || a.id.toLowerCase().includes(q);
    
    let matchFilter = true;
    if (accountStatusFilter === "enabled") matchFilter = a.enabled === true;
    else if (accountStatusFilter === "disabled") matchFilter = a.enabled === false;
    else if (accountStatusFilter === "loggedin") matchFilter = a.loggedIn === true;
    else if (accountStatusFilter === "loggedout") matchFilter = a.loggedIn === false;

    return matchQuery && matchFilter;
  });

  $("#account-empty").hidden = filtered.length > 0;

  for (const a of filtered) {
    const tr = document.createElement("tr");
    const rot = a.rotation || {};
    const rule = a.switchRule || "random";
    const topicText = rot.currentSet
      ? convCache[rot.currentSet]?.topic || rot.currentSet
      : null;
    const progress = topicText
      ? `当前：<strong>${escapeHtml(topicText)}</strong> (${rot.windowsDone ?? 0}/${rot.windowsTarget ?? 0})`
      : "<span class='time-ago'>未开始</span>";

    tr.innerHTML = `
      <td>
        <div class="acc-info-cell">
          <div class="acc-email" data-email="${a.id}">${
            a.email ? escapeHtml(a.email) : "<span class='time-ago'>未绑定邮箱</span>"
          }</div>
          <input class="acc-note" data-note="${a.id}" value="${escapeHtml(
            a.note || ""
          )}" placeholder="点击添加备注…" />
        </div>
      </td>
      <td>${statusHtml(a.id, a.loggedIn, a.checkedAt)}</td>
      <td>
        <label class="switch">
          <input type="checkbox" ${a.enabled ? "checked" : ""} data-enable="${a.id}" />
          <span class="slider round"></span>
        </label>
      </td>
      <td>
        <div class="rot-config">
          <div class="rot-windows">
            <select class="rot-select" data-rule="${a.id}">
              <option value="random" ${rule === "random" ? "selected" : ""}>随机切换</option>
              <option value="sequential" ${rule === "sequential" ? "selected" : ""}>顺序切换</option>
            </select>
            <span>窗口</span>
            <input type="number" min="1" class="rot-min" data-minw="${a.id}" value="${a.minWindows ?? 1}" />
            <span>-</span>
            <input type="number" min="1" class="rot-max" data-maxw="${a.id}" value="${a.maxWindows ?? 3}" />
          </div>
          <div class="rot-progress">${progress}</div>
        </div>
      </td>
      <td>
        <div class="actions">
          <button class="btn small" data-login="${a.id}" title="自动登录/刷新 Cookie">登录</button>
          <button class="btn small" data-check="${a.id}" title="检查 Cookie 是否过保">刷新</button>
          <button class="btn small primary" data-run="${a.id}" title="立即执行一轮对话">立即跑</button>
          <button class="btn small" data-history="${a.id}" title="查看对话日志">历史</button>
          <button class="btn small danger" data-del="${a.id}" title="删除此账号配置">删除</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }

  bindAccountActions();
}

function statusHtml(id, loggedIn, checkedAt) {
  let dot = "", text = "未知";
  if (loggedIn === true) { dot = "green"; text = "已登录"; }
  else if (loggedIn === false) { dot = "red"; text = "未登录"; }

  const when = checkedAt
    ? `<span class="time-ago" title="${fmtLocal(checkedAt)}"> · ${timeAgo(checkedAt)}</span>`
    : "";

  return `<span class="status-dot" data-status="${id}">
    <span class="dot ${dot}"></span>
    <span>${text}</span>
    ${when}
  </span>`;
}

function statusInner(loggedIn) {
  if (loggedIn === true) return `<span class="dot green"></span><span>已登录</span>`;
  if (loggedIn === false) return `<span class="dot red"></span><span>未登录</span>`;
  return `<span class="dot"></span><span>未知</span>`;
}

function bindAccountActions() {
  // 启用开关
  $$("[data-enable]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/accounts/${el.dataset.enable}`, {
          method: "PATCH",
          body: { enabled: el.checked },
        });
        const acc = accountsCache.find((x) => x.id === el.dataset.enable);
        if (acc) acc.enabled = el.checked;
        toast(el.checked ? "已启用调度" : "已禁用调度", "success");
      } catch (e) {
        toast("更新失败: " + e.message, "error");
        el.checked = !el.checked;
      }
    })
  );

  // 备注失焦
  $$("[data-note]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/accounts/${el.dataset.note}`, {
          method: "PATCH",
          body: { note: el.value },
        });
        const acc = accountsCache.find((x) => x.id === el.dataset.note);
        if (acc) acc.note = el.value;
        toast("备注已保存", "success");
      } catch (e) {
        toast("保存备注失败: " + e.message, "error");
      }
    })
  );

  // 切换规则
  $$("[data-rule]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/accounts/${el.dataset.rule}`, {
          method: "PATCH",
          body: { switchRule: el.value },
        });
        toast("规则已更新", "success");
      } catch (e) {
        toast("更新规则失败: " + e.message, "error");
      }
    })
  );

  // 窗口范围
  const saveWindows = async (id) => {
    let min = Number($(`[data-minw="${id}"]`).value) || 1;
    let max = Number($(`[data-maxw="${id}"]`).value) || 1;
    if (min < 1) min = 1;
    if (max < min) max = min;
    $(`[data-minw="${id}"]`).value = min;
    $(`[data-maxw="${id}"]`).value = max;
    try {
      await api(`/accounts/${id}`, {
        method: "PATCH",
        body: { minWindows: min, maxWindows: max },
      });
      toast("窗口配置已保存", "success");
    } catch (e) {
      toast("保存失败: " + e.message, "error");
    }
  };
  $$("[data-minw]").forEach((el) =>
    el.addEventListener("change", () => saveWindows(el.dataset.minw))
  );
  $$("[data-maxw]").forEach((el) =>
    el.addEventListener("change", () => saveWindows(el.dataset.maxw))
  );

  // 按钮事件
  $$("[data-login]").forEach((el) =>
    el.addEventListener("click", () => doLogin(el.dataset.login))
  );

  $$("[data-check]").forEach((el) =>
    el.addEventListener("click", async () => {
      setBtnLoading(el, true);
      await checkStatus(el.dataset.check);
      setBtnLoading(el, false);
    })
  );

  $$("[data-run]").forEach((el) =>
    el.addEventListener("click", async () => {
      setBtnLoading(el, true, "运行中");
      await runNow(el.dataset.run);
      setBtnLoading(el, false);
    })
  );

  $$("[data-history]").forEach((el) =>
    el.addEventListener("click", () => openHistory(el.dataset.history))
  );

  $$("[data-del]").forEach((el) =>
    el.addEventListener("click", () => delAccount(el.dataset.del))
  );
}

// 账号搜索与过滤绑定
$("#account-search").addEventListener("input", (e) => {
  accountSearchQuery = e.target.value;
  renderAccounts();
});

$("#account-status-filter").addEventListener("change", (e) => {
  accountStatusFilter = e.target.value;
  renderAccounts();
});

$("#add-account").addEventListener("click", async () => {
  const btn = $("#add-account");
  setBtnLoading(btn, true, "添加中");
  try {
    const acc = await api("/accounts", { method: "POST", body: {} });
    await loadAccounts();
    toast("新账号已建立", "success");
    doLogin(acc.id);
  } catch (e) {
    toast("创建账号失败: " + e.message, "error");
  } finally {
    setBtnLoading(btn, false);
  }
});

async function delAccount(id) {
  if (!confirm(`确定删除账号 [${id}]？登录态数据将保留在 profiles 目录中。`)) return;
  try {
    await api(`/accounts/${id}`, { method: "DELETE" });
    toast("账号已删除", "success");
    loadAccounts();
  } catch (e) {
    toast("删除失败: " + e.message, "error");
  }
}

async function checkStatus(id) {
  const span = $(`[data-status="${id}"]`);
  if (span) span.innerHTML = `<span class="dot"></span><span>检查中…</span>`;
  try {
    const { loggedIn, email } = await api(`/accounts/${id}/status?refresh=1`);
    if (span) span.innerHTML = statusInner(loggedIn);
    updateEmailCell(id, email);
    const acc = accountsCache.find((x) => x.id === id);
    if (acc) { acc.loggedIn = loggedIn; acc.email = email; }
    updateStats();
    toast("状态检测完成", "success");
  } catch (e) {
    if (span) span.innerHTML = `<span class="dot red"></span><span>错误</span>`;
    toast("检查失败: " + e.message, "error");
  }
}

function updateEmailCell(id, email) {
  const emailEl = $(`[data-email="${id}"]`);
  if (!emailEl) return;
  if (email) emailEl.textContent = email;
  else emailEl.innerHTML = "<span class='time-ago'>未绑定账号</span>";
}

async function pollStatus() {
  try {
    const all = await api("/status");
    for (const [id, st] of Object.entries(all)) {
      const span = $(`[data-status="${id}"]`);
      if (span) {
        span.innerHTML = statusInner(st.loggedIn) +
          (st.checkedAt ? `<span class="time-ago" title="${fmtLocal(st.checkedAt)}"> · ${timeAgo(st.checkedAt)}</span>` : "");
      }
      if (st.email) updateEmailCell(id, st.email);

      const acc = accountsCache.find((x) => x.id === id);
      if (acc) {
        acc.loggedIn = st.loggedIn;
        if (st.email) acc.email = st.email;
      }
    }
    updateStats();
  } catch {
    // 轮询静默失败
  }
}

async function runNow(id) {
  try {
    const res = await api(`/accounts/${id}/run`, { method: "POST" });
    if (res.ok) {
      toast("会话已成功完成并记录", "success");
    } else {
      toast("运行失败: " + (res.reason || "未知原因"), "error");
    }
    loadAccounts();
  } catch (e) {
    toast("出错: " + e.message, "error");
  }
}

// ---------- 登录流程与 Step 指示器 ----------
async function doLogin(id) {
  const modalBackdrop = $("#login-backdrop");
  const modal = $("#login-modal");
  const msg = $("#login-msg");
  const closeBtn = $("#login-close");
  const step2 = $("#step-2");
  const step3 = $("#step-3");
  const spinner = $("#login-spinner");

  modalBackdrop.hidden = false;
  modal.hidden = false;
  closeBtn.hidden = true;
  spinner.hidden = false;
  step2.className = "step-dot";
  step3.className = "step-dot";
  msg.textContent = "正在启动浏览器并载入 ChatGPT 登录页…";

  let task;
  try {
    task = await api(`/accounts/${id}/login`, { method: "POST" });
  } catch (e) {
    msg.textContent = "启动登录失败: " + e.message;
    closeBtn.hidden = false;
    spinner.hidden = true;
    return;
  }

  step2.className = "step-dot active";

  const poll = setInterval(async () => {
    try {
      const t = await api(`/login-tasks/${task.taskId}`);
      msg.textContent = t.message || t.status;

      if (["success", "failed", "timeout"].includes(t.status)) {
        clearInterval(poll);
        closeBtn.hidden = false;
        spinner.hidden = true;

        if (t.status === "success") {
          step3.className = "step-dot active";
          checkStatus(id);
          toast("账号登录成功，Session 已保存", "success");
        } else {
          toast("登录未完成: " + t.status, "error");
        }
      }
    } catch (e) {
      clearInterval(poll);
      msg.textContent = "轮询状态失败: " + e.message;
      closeBtn.hidden = false;
      spinner.hidden = true;
    }
  }, 2000);
}

function closeLoginModal() {
  $("#login-backdrop").hidden = true;
  $("#login-modal").hidden = true;
}
$("#login-close").addEventListener("click", closeLoginModal);
$("#login-backdrop").addEventListener("click", closeLoginModal);

// ---------- 历史记录抽屉 (History Drawer) ----------
async function openHistory(id) {
  currentDrawerAccountId = id;
  const drawerBackdrop = $("#drawer-backdrop");
  const drawer = $("#history-drawer");
  const body = $("#history-body");

  $("#history-title").textContent = `对话日志历史`;
  $("#history-acc-tag").textContent = id;
  body.innerHTML = '<div class="empty-state"><div class="spinner-ring"></div><p>正在读取历史记录…</p></div>';

  drawerBackdrop.hidden = false;
  drawer.hidden = false;

  try {
    historyCache = await api(`/accounts/${id}/history?limit=50`);
    renderHistory();
  } catch (e) {
    body.innerHTML = `<div class="empty-state"><h3>加载失败</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderHistory() {
  const body = $("#history-body");
  body.innerHTML = "";

  let filtered = historyCache.filter((item) => {
    let matchFilter = true;
    if (historyStatusFilter === "success") matchFilter = item.ok === true;
    else if (historyStatusFilter === "fail") matchFilter = item.ok === false;

    const q = historySearchQuery.toLowerCase();
    const strContent = JSON.stringify(item).toLowerCase();
    const matchQuery = !q || strContent.includes(q);

    return matchFilter && matchQuery;
  });

  if (filtered.length === 0) {
    body.innerHTML = '<div class="empty-state"><h3>无匹配日志</h3><p>该账号暂无符合条件的对话历史。</p></div>';
    return;
  }

  body.innerHTML = filtered.map(renderHistItem).join("");

  // 绑定复制回答按钮
  body.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const text = e.target.parentElement.textContent.replace("复制", "").trim();
      navigator.clipboard.writeText(text);
      toast("已复制到剪贴板", "success");
    });
  });
}

function renderHistItem(it) {
  const isFail = !it.ok;
  const head = `<div class="hist-meta">
    <span>${fmtLocal(it.time)}</span>
    <span class="hist-topic-badge">${it.topic ? "主题: " + escapeHtml(it.topic) : "自由对话"}</span>
    <span>${it.totalRounds ? it.totalRounds + " 轮对话" : ""}</span>
  </div>`;

  if (isFail) {
    return `<div class="hist-item fail">
      ${head}
      <div class="bubble-q" style="border-color: rgba(239, 68, 68, 0.3); color: #fca5a5;">执行过程出错</div>
      <div class="bubble-a" style="border-color: rgba(239, 68, 68, 0.2); color: #f87171;">${escapeHtml(it.reason || "未知异常原因")}</div>
    </div>`;
  }

  let rounds = null;
  if (Array.isArray(it.rounds)) rounds = it.rounds;
  else if (Array.isArray(it.threads)) rounds = it.threads.flatMap((t) => t.rounds || []);

  if (rounds && rounds.length > 0) {
    const roundsHtml = rounds
      .map(
        (r, i) => `<div class="round-bubble">
          <div class="bubble-q"><strong>Q${i + 1}:</strong> ${escapeHtml(r.q || "")}</div>
          <div class="bubble-a"><button class="copy-btn">复制</button>${escapeHtml(r.a || "")}</div>
        </div>`
      )
      .join("");

    return `<div class="hist-item">
      ${head}
      <div class="hist-rounds">${roundsHtml}</div>
    </div>`;
  }

  // 最早单轮结构兼容
  return `<div class="hist-item">
    ${head}
    <div class="round-bubble">
      <div class="bubble-q">${escapeHtml(it.prompt || "(无 Prompt)")}</div>
      <div class="bubble-a"><button class="copy-btn">复制</button>${escapeHtml(it.reply || "")}</div>
    </div>
  </div>`;
}

function closeDrawer() {
  $("#drawer-backdrop").hidden = true;
  $("#history-drawer").hidden = true;
}
$("#history-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);

// Drawer Search & Filter
$("#history-search").addEventListener("input", (e) => {
  historySearchQuery = e.target.value;
  renderHistory();
});

$$("[data-hist-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("[data-hist-filter]").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    historyStatusFilter = btn.dataset.histFilter;
    renderHistory();
  });
});

// ---------- 对话主题集 (Conversations) ----------
async function loadConversations(topKey = null) {
  try {
    convCache = await api("/conversations");
    updateStats();
    renderConversations(topKey);
  } catch (e) {
    toast("加载主题失败: " + e.message, "error");
  }
}

function renderConversations(topKey = null) {
  const list = $("#conv-list");
  list.innerHTML = "";

  let entries = Object.entries(convCache);

  // Search filter
  if (topicSearchQuery) {
    const q = topicSearchQuery.toLowerCase();
    entries = entries.filter(([k, v]) => (v.topic && v.topic.toLowerCase().includes(q)) || k.toLowerCase().includes(q));
  }

  if (topKey && convCache[topKey]) {
    entries = [
      [topKey, convCache[topKey]],
      ...entries.filter(([k]) => k !== topKey),
    ];
  }

  $("#topic-empty").hidden = entries.length > 0;

  for (const [key, set] of entries) {
    const card = document.createElement("div");
    card.className = "conv-card shadow-card";
    card.innerHTML = `
      <div class="conv-field">
        <label>主题描述名称</label>
        <input class="conv-topic" data-topic="${escapeHtml(key)}"
          value="${escapeHtml(set.topic || "")}"
          placeholder="例如：C# 架构设计 / 英语口语训练 / 每日读书摘要" />
      </div>
      <div class="row">
        <div class="conv-field small-field">
          <label>随机轮数下限</label>
          <input type="number" min="1" class="conv-min" data-min="${escapeHtml(key)}"
            value="${set.minRounds ?? 2}" />
        </div>
        <div class="conv-field small-field">
          <label>随机轮数上限</label>
          <input type="number" min="1" class="conv-max" data-max="${escapeHtml(key)}"
            value="${set.maxRounds ?? 8}" />
        </div>
      </div>
      <div class="row" style="justify-content: flex-end; margin-top: 4px;">
        <button class="btn primary small" data-save-conv="${escapeHtml(key)}">保存主题</button>
        <button class="btn danger small" data-del-conv="${escapeHtml(key)}">删除</button>
      </div>`;
    list.appendChild(card);
  }

  bindConvActions();
}

function bindConvActions() {
  $$("[data-save-conv]").forEach((el) =>
    el.addEventListener("click", async () => {
      const key = el.dataset.saveConv;
      const topic = $(`[data-topic="${key}"]`).value.trim();
      let minRounds = Number($(`[data-min="${key}"]`).value) || 1;
      let maxRounds = Number($(`[data-max="${key}"]`).value) || 1;
      if (minRounds < 1) minRounds = 1;
      if (maxRounds < minRounds) maxRounds = minRounds;

      if (!topic) return toast("请填写主题名称", "error");

      setBtnLoading(el, true);
      try {
        await api(`/conversations/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: { topic, minRounds, maxRounds },
        });
        toast("主题已成功保存", "success");
        loadConversations();
      } catch (e) {
        toast("保存失败: " + e.message, "error");
      } finally {
        setBtnLoading(el, false);
      }
    })
  );

  $$("[data-del-conv]").forEach((el) =>
    el.addEventListener("click", async () => {
      const key = el.dataset.delConv;
      const label = convCache[key]?.topic || "该主题";
      if (!confirm(`确定删除主题「${label}」？`)) return;

      try {
        await api(`/conversations/${encodeURIComponent(key)}`, {
          method: "DELETE",
        });
        toast("主题已删除", "success");
        loadConversations();
      } catch (e) {
        toast("删除失败: " + e.message, "error");
      }
    })
  );
}

$("#topic-search").addEventListener("input", (e) => {
  topicSearchQuery = e.target.value;
  renderConversations();
});

$("#add-set").addEventListener("click", async () => {
  const btn = $("#add-set");
  setBtnLoading(btn, true);
  const key = "topic_" + Date.now().toString(36);
  try {
    await api(`/conversations/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { topic: "", minRounds: 2, maxRounds: 8 },
    });
    await loadConversations(key);
    window.scrollTo({ top: 0, behavior: "smooth" });
    const input = document.querySelector(`[data-topic="${key}"]`);
    if (input) input.focus({ preventScroll: true });
    toast("新建主题卡片", "success");
  } catch (e) {
    toast("创建失败: " + e.message, "error");
  } finally {
    setBtnLoading(btn, false);
  }
});

// ---------- 定时与风控设置 ----------
async function loadSettings() {
  try {
    const s = await api("/settings");
    const f = $("#settings-form");
    f.intervalMinutes.value = s.intervalMinutes;
    f.jitterMinutes.value = s.jitterMinutes;
    f.statusCheckMinutes.value = s.statusCheckMinutes;
    f.headless.checked = !!s.headless;
  } catch (e) {
    toast("加载设置失败: " + e.message, "error");
  }
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type='submit']");
  setBtnLoading(btn, true, "保存中");

  try {
    await api("/settings", {
      method: "PUT",
      body: {
        intervalMinutes: Number(f.intervalMinutes.value),
        jitterMinutes: Number(f.jitterMinutes.value),
        statusCheckMinutes: Number(f.statusCheckMinutes.value),
        headless: f.headless.checked,
      },
    });
    toast("设置参数已成功保存", "success");
  } catch (err) {
    toast("保存出错: " + err.message, "error");
  } finally {
    setBtnLoading(btn, false);
  }
});

// ---------- 调度器控制 ----------
async function loadScheduler() {
  try {
    const s = await api("/scheduler");
    const pill = $("#sched-state");
    const textEl = pill.querySelector(".sched-text");
    const btn = $("#sched-toggle");
    const statText = $("#stat-sched-status");

    if (s.running) {
      textEl.textContent = "调度器: 运行中";
      pill.className = "pill on";
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg><span>停止调度</span>`;
      statText.textContent = "进行中";
      statText.className = "stat-value text-green";
    } else {
      textEl.textContent = "调度器: 已停止";
      pill.className = "pill off";
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>启动调度</span>`;
      statText.textContent = "已停止";
      statText.className = "stat-value text-muted";
    }
  } catch {
    // 静默失败
  }
}

$("#sched-toggle").addEventListener("click", async () => {
  const btn = $("#sched-toggle");
  setBtnLoading(btn, true);
  try {
    const s = await api("/scheduler");
    await api(s.running ? "/scheduler/stop" : "/scheduler/start", { method: "POST" });
    toast(s.running ? "已发送停止请求" : "自动调度器已启动", "success");
    setTimeout(loadScheduler, 400);
  } catch (e) {
    toast("操作失败: " + e.message, "error");
  } finally {
    setBtnLoading(btn, false);
  }
});

// Global Keyboard Shortcut (Esc closes drawer / modal)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDrawer();
    closeLoginModal();
  }
});

// ---------- 初始化 ----------
async function init() {
  await loadConversations();
  await loadAccounts();
  loadSettings();
  loadScheduler();
  pollStatus();
}

init();
setInterval(loadScheduler, 8000);
setInterval(pollStatus, 10000);
