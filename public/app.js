// ==========================================================================
// ChatGPT Keeper - Frontend Logic & Interactive Controller
// ==========================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// State & Caches
let accountsCache = [];
let convCache = {};
let historyCache = [];
let groupsCache = [];
let proxyCache = [];
let proxyStatus = {};
let proxyDelays = {}; // nodeId -> 延迟文本
let currentDrawerAccountId = null;
// 新建分组时暂存选中的代理节点（还没有 group id 可挂）
let newGroupProxyId = null;
// 创建请求发出后锁住弹窗，避免用户点“取消”却仍在后台留下账号。
let newAccountSubmitting = false;

// Search & Filter State
let accountSearchQuery = "";
let accountStatusFilter = "all";
let accountGroupFilter = "all";
let topicSearchQuery = "";
let proxySearchQuery = "";
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

  // 过滤账号：搜索 + 状态 + 分组，三者可叠加
  let filtered = accountsCache.filter((a) => {
    const q = accountSearchQuery.toLowerCase();
    const matchQuery = !q || (a.email && a.email.toLowerCase().includes(q)) || (a.note && a.note.toLowerCase().includes(q)) || a.id.toLowerCase().includes(q);

    let matchFilter = true;
    if (accountStatusFilter === "enabled") matchFilter = a.enabled === true;
    else if (accountStatusFilter === "disabled") matchFilter = a.enabled === false;
    else if (accountStatusFilter === "loggedin") matchFilter = a.state === "ok" || (a.state == null && a.loggedIn === true);
    else if (accountStatusFilter === "reauth") matchFilter = a.state === "reauth";
    else if (accountStatusFilter === "loggedout") matchFilter = a.state === "out" || (a.state == null && a.loggedIn === false);

    let matchGroup = true;
    if (accountGroupFilter === "none") matchGroup = !a.groupId;
    else if (accountGroupFilter !== "all") matchGroup = a.groupId === accountGroupFilter;

    return matchQuery && matchFilter && matchGroup;
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
      <td>${statusHtml(a.id, a, a.checkedAt)}</td>
      <td>
        <label class="switch">
          <input type="checkbox" ${a.enabled ? "checked" : ""} data-enable="${a.id}" />
          <span class="slider round"></span>
        </label>
      </td>
      <td>
        <div class="rot-config">
          <select class="rot-select" data-group="${a.id}" title="所属分组（代理由分组决定）">
            <option value="" ${!a.groupId ? "selected" : ""}>未分组</option>
            ${groupsCache
              .map(
                (g) =>
                  `<option value="${g.id}" ${a.groupId === g.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`
              )
              .join("")}
          </select>
          <div class="proxy-inherit" title="代理绑定在分组上，改分组的节点请到「分组管理」">${groupProxyLabel(
            a.groupId
          )}</div>
        </div>
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
          <button class="btn small" data-login="${a.id}" title="打开浏览器登录该账号">登录</button>
          ${
            a.state === "reauth"
              ? `<button class="btn small warn" data-relogin="${a.id}" title="清除失效会话后重新登录，不必删除账号">重新登录</button>`
              : ""
          }
          <button class="btn small" data-open="${a.id}" title="打开网页，窗口不会自动关闭">${
            a.pageOpen ? "已打开" : "打开网页"
          }</button>
          <button class="btn small" data-check="${a.id}" title="立即检查登录状态">刷新</button>
          <button class="btn small primary" data-run="${a.id}" title="立即执行一轮对话">立即跑</button>
          <button class="btn small" data-history="${a.id}" title="查看对话日志">历史</button>
          <button class="btn small danger" data-del="${a.id}" title="删除此账号配置">删除</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }

  bindAccountActions();
}

/**
 * 账号行里展示“该账号实际走哪个出口”。代理绑在分组上，所以这里只读展示，
 * 想改节点要去分组管理——避免同组账号出口不一致。
 */
function groupProxyLabel(groupId) {
  if (!groupId) return `<span class="px-tag muted">出口：跟随系统</span>`;
  const g = groupsCache.find((x) => x.id === groupId);
  if (!g?.proxyId) return `<span class="px-tag muted">出口：跟随系统</span>`;
  const node = proxyCache.find((p) => p.id === g.proxyId);
  if (!node) return `<span class="px-tag warn">出口：节点已失效</span>`;
  return `<span class="px-tag" title="${escapeHtml(node.name)}">出口：${escapeHtml(node.name)}${
    node.missing ? "（已失效）" : ""
  }</span>`;
}

function statusHtml(id, st, checkedAt) {
  const when = checkedAt
    ? `<span class="time-ago" title="${fmtLocal(checkedAt)}"> · ${timeAgo(checkedAt)}</span>`
    : "";
  return `<span class="status-dot" data-status="${id}">${statusInner(st)}${when}</span>`;
}

/**
 * 三态状态显示。reauth 是关键的一类：cookie 还在、看着像已登录，
 * 但令牌已失效（改了密码或加了双重认证），必须重新登录才能跑对话。
 */
function statusInner(st) {
  const state = st && typeof st === "object" ? st.state : null;
  const loggedIn = st && typeof st === "object" ? st.loggedIn : st;
  const detail = st && typeof st === "object" ? st.statusDetail || st.detail : null;

  if (state === "reauth") {
    return `<span class="dot orange"></span><span title="${escapeHtml(
      detail || "令牌已失效"
    )}">需重新登录</span>`;
  }
  // unknown：没能确认（网络抖动/限流）。不显示成“已登录”，避免误导。
  if (state === "unknown") {
    return `<span class="dot"></span><span title="${escapeHtml(
      detail || "未能确认会话状态"
    )}">待确认</span>`;
  }
  if (state === "ok") return `<span class="dot green"></span><span>已登录</span>`;
  if (state === "out") return `<span class="dot red"></span><span>未登录</span>`;
  // 无 state 字段时（旧缓存）退回布尔判断
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

  // 分组选择
  $$("[data-group]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/accounts/${el.dataset.group}`, {
          method: "PATCH",
          body: { groupId: el.value || null },
        });
        const acc = accountsCache.find((x) => x.id === el.dataset.group);
        if (acc) acc.groupId = el.value || null;
        toast("分组已更新", "success");
        // 分组换了，出口也跟着换，整行重画一遍最稳
        renderAccounts();
      } catch (e) {
        toast("更新分组失败: " + e.message, "error");
      }
    })
  );

  // 按钮事件
  $$("[data-login]").forEach((el) =>
    el.addEventListener("click", () => doLogin(el.dataset.login))
  );

  // 强制重新登录：清掉失效会话再登录，不必删账号
  $$("[data-relogin]").forEach((el) =>
    el.addEventListener("click", () => doLogin(el.dataset.relogin, true))
  );

  // 打开网页（不自动关闭）
  $$("[data-open]").forEach((el) =>
    el.addEventListener("click", async () => {
      const id = el.dataset.open;
      setBtnLoading(el, true, "打开中");
      try {
        const res = await api(`/accounts/${id}/open-page`, {
          method: "POST",
          body: {},
        });
        if (res.ok) {
          toast("窗口已打开，用完请手动关闭浏览器窗口", "success");
        } else {
          toast(res.message || "打开失败", "error");
        }
        loadAccounts();
      } catch (e) {
        toast("打开失败: " + e.message, "error");
      } finally {
        setBtnLoading(el, false);
      }
    })
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

$("#account-group-filter").addEventListener("change", (e) => {
  accountGroupFilter = e.target.value;
  renderAccounts();
});

// ---------- 代理节点选择器（可模糊搜索的下拉） ----------
// 原生 <select> 没法搜索，几百个订阅节点靠滚动找根本没法用，
// 所以这里用输入框 + 可过滤菜单自己实现一个。

/**
 * 模糊匹配：先按空格分词做子串匹配（“美国 香港”这类多关键词），
 * 都不中再退化成「按顺序出现」的子序列匹配（输 "usjp" 也能命中 "US-JP"）。
 */
function fuzzyMatch(text, query) {
  const t = (text || "").toLowerCase();
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.every((tok) => t.includes(tok))) return true;

  let i = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

function proxyNodeLabel(id) {
  if (!id) return "跟随系统网络";
  const node = proxyCache.find((p) => p.id === id);
  if (!node) return "节点已失效（请重新选择）";
  return node.name + (node.missing ? "（已不在订阅中）" : "");
}

/**
 * 渲染一个代理选择器。value 为节点 id，空 = 跟随系统网络。
 */
function proxyPickerHtml(key, value) {
  return `<div class="px-picker" data-picker="${key}">
    <input type="text" class="px-picker-input" data-picker-input="${key}"
      value="${escapeHtml(proxyNodeLabel(value))}"
      data-value="${escapeHtml(value || "")}"
      placeholder="跟随系统网络" autocomplete="off" spellcheck="false" />
    <span class="px-picker-caret">▾</span>
    <div class="px-picker-menu" data-picker-menu="${key}" hidden></div>
  </div>`;
}

/**
 * 给页面上所有还没绑定过的选择器挂事件。onChange(key, proxyId) 在用户选中时触发。
 */
function bindProxyPickers(onChange) {
  $$(".px-picker").forEach((box) => {
    if (box.dataset.bound === "1") return;
    box.dataset.bound = "1";

    const key = box.dataset.picker;
    const input = box.querySelector(".px-picker-input");
    const menu = box.querySelector(".px-picker-menu");

    const currentId = () => input.dataset.value || "";
    const choose = (id) => {
      input.dataset.value = id;
      input.value = proxyNodeLabel(id);
      menu.hidden = true;
      box.classList.remove("open");
      input.blur();
      onChange(key, id || null);
    };

    const paint = (query) => {
      const rows = [{ id: "", name: "跟随系统网络" }, ...proxyCache].filter((n) =>
        fuzzyMatch(n.name, query)
      );
      if (rows.length === 0) {
        menu.innerHTML = `<div class="px-opt empty">没有匹配的节点</div>`;
        return;
      }
      menu.innerHTML = rows
        .map((n) => {
          const sel = n.id === currentId() ? " selected" : "";
          const tail = n.missing ? ` <span class="px-opt-tail">已失效</span>` : "";
          return `<div class="px-opt${sel}" data-opt="${escapeHtml(n.id)}">${escapeHtml(
            n.name
          )}${tail}</div>`;
        })
        .join("");
    };

    const open = () => {
      paint("");
      menu.hidden = false;
      box.classList.add("open");
      input.select();
    };
    const close = () => {
      menu.hidden = true;
      box.classList.remove("open");
      // 用户可能打了半截搜索词没选，关闭时还原成当前真实选中项
      input.value = proxyNodeLabel(currentId());
    };

    input.addEventListener("focus", open);
    input.addEventListener("input", () => paint(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.blur();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const first = menu.querySelector(".px-opt[data-opt]");
        if (first) choose(first.dataset.opt || "");
      }
    });

    menu.addEventListener("mousedown", (e) => {
      // 阻止 input 先失焦导致 click 落空
      const opt = e.target.closest(".px-opt[data-opt]");
      if (!opt) return;
      e.preventDefault();
      choose(opt.dataset.opt || "");
    });

    input.addEventListener("blur", () => setTimeout(close, 120));
  });
}

// ---------- 分组管理 ----------
async function loadGroups() {
  try {
    groupsCache = await api("/groups");
    renderGroupFilter();
  } catch (e) {
    toast("加载分组失败: " + e.message, "error");
  }
}

function renderGroupFilter() {
  const sel = $("#account-group-filter");
  const keep = accountGroupFilter;
  sel.innerHTML =
    `<option value="all">全部分组</option><option value="none">未分组</option>` +
    groupsCache.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  // 分组被删掉时回退到“全部分组”
  const exists = keep === "all" || keep === "none" || groupsCache.some((g) => g.id === keep);
  sel.value = exists ? keep : "all";
  accountGroupFilter = sel.value;
}

function renderGroupList() {
  const box = $("#group-list");
  if (groupsCache.length === 0) {
    box.innerHTML = `<p class="hint-text">还没有分组，用上面的输入框新建一个。</p>`;
    return;
  }
  box.innerHTML = groupsCache
    .map((g) => {
      const count = accountsCache.filter((a) => a.groupId === g.id).length;
      return `<div class="group-item">
        <div class="group-item-row">
          <input type="text" class="group-name-input" data-gname="${g.id}" value="${escapeHtml(
            g.name
          )}" placeholder="分组名称" />
          <span class="time-ago">${count} 个账号</span>
          <button class="btn small" data-grename="${g.id}">改名</button>
          <button class="btn small danger" data-gdel="${g.id}">删除</button>
        </div>
        <div class="group-item-row">
          <span class="group-field-label">代理节点</span>
          ${proxyPickerHtml("g:" + g.id, g.proxyId)}
        </div>
      </div>`;
    })
    .join("");

  // 分组的代理选好就立即落盘，组内账号下次启动浏览器即生效。
  bindProxyPickers(async (key, proxyId) => {
    if (!key.startsWith("g:")) return;
    const id = key.slice(2);
    try {
      await api(`/groups/${id}`, { method: "PATCH", body: { proxyId } });
      const g = groupsCache.find((x) => x.id === id);
      if (g) g.proxyId = proxyId;
      toast(proxyId ? "分组代理已更新" : "该分组已改为跟随系统网络", "success");
      renderAccounts();
    } catch (e) {
      toast("更新分组代理失败: " + e.message, "error");
      await loadGroups();
      renderGroupList();
    }
  });

  $$("[data-grename]").forEach((el) =>
    el.addEventListener("click", async () => {
      const id = el.dataset.grename;
      const name = $(`[data-gname="${id}"]`).value.trim();
      try {
        await api(`/groups/${id}`, { method: "PATCH", body: { name } });
        toast("分组已改名", "success");
        await loadGroups();
        renderGroupList();
        renderAccounts();
      } catch (e) {
        toast("改名失败: " + e.message, "error");
      }
    })
  );

  $$("[data-gdel]").forEach((el) =>
    el.addEventListener("click", async () => {
      const id = el.dataset.gdel;
      const g = groupsCache.find((x) => x.id === id);
      const count = accountsCache.filter((a) => a.groupId === id).length;
      if (
        !confirm(
          `确定删除分组「${g?.name ?? id}」？\n组内 ${count} 个账号会变为「未分组」，账号本身不会被删除。`
        )
      )
        return;
      try {
        await api(`/groups/${id}`, { method: "DELETE" });
        toast("分组已删除", "success");
        await loadGroups();
        await loadAccounts();
        renderGroupList();
      } catch (e) {
        toast("删除失败: " + e.message, "error");
      }
    })
  );
}

// 新建分组行里的代理选择器：每次打开弹窗都重建一次，保证节点列表是最新的。
function renderNewGroupPicker() {
  newGroupProxyId = null;
  $("#new-group-proxy").innerHTML = proxyPickerHtml("new", null);
  bindProxyPickers((key, proxyId) => {
    if (key === "new") newGroupProxyId = proxyId;
  });
}

function openGroupModal() {
  $("#group-backdrop").hidden = false;
  $("#group-modal").hidden = false;
  renderNewGroupPicker();
  renderGroupList();
}

function closeGroupModal() {
  $("#group-backdrop").hidden = true;
  $("#group-modal").hidden = true;
}

$("#manage-groups").addEventListener("click", openGroupModal);
$("#group-close").addEventListener("click", closeGroupModal);
$("#group-backdrop").addEventListener("click", closeGroupModal);

$("#create-group").addEventListener("click", async () => {
  const input = $("#new-group-name");
  const name = input.value.trim();
  if (!name) return toast("请填写分组名称", "error");
  try {
    await api("/groups", { method: "POST", body: { name, proxyId: newGroupProxyId } });
    input.value = "";
    toast("分组已创建", "success");
    await loadGroups();
    renderNewGroupPicker();
    renderGroupList();
    renderAccounts();
  } catch (e) {
    toast("创建失败: " + e.message, "error");
  }
});

$("#new-group-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#create-group").click();
});

// ---------- 添加账号：先选分组，再开浏览器登录 ----------
// 分组决定出口，而首次登录是最敏感的一次会话。若先建账号再选分组，
// 登录会走系统 IP、之后的调度又换成节点 IP，同一账号出现 IP 跳变。

function renderNewAccountExit() {
  const groupId = $("#newacc-group").value;
  $("#newacc-exit").innerHTML = groupProxyLabel(groupId || null);
}

function openNewAccountModal() {
  if (newAccountSubmitting) return;
  const sel = $("#newacc-group");
  sel.innerHTML =
    `<option value="">未分组（跟随系统网络）</option>` +
    groupsCache
      .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
      .join("");
  sel.value = "";
  renderNewAccountExit();
  $("#newacc-backdrop").hidden = false;
  $("#newacc-modal").hidden = false;
}

function closeNewAccountModal() {
  if (newAccountSubmitting) return;
  $("#newacc-backdrop").hidden = true;
  $("#newacc-modal").hidden = true;
}

function setNewAccountSubmitting(submitting) {
  newAccountSubmitting = submitting;
  $("#newacc-group").disabled = submitting;
  $("#newacc-cancel").disabled = submitting;
  $("#newacc-modal").setAttribute("aria-busy", String(submitting));
}

$("#add-account").addEventListener("click", openNewAccountModal);
$("#newacc-cancel").addEventListener("click", closeNewAccountModal);
$("#newacc-backdrop").addEventListener("click", closeNewAccountModal);
$("#newacc-group").addEventListener("change", renderNewAccountExit);

$("#newacc-confirm").addEventListener("click", async () => {
  if (newAccountSubmitting) return;
  const btn = $("#newacc-confirm");
  const groupId = $("#newacc-group").value || null;
  setNewAccountSubmitting(true);
  setBtnLoading(btn, true, "创建中");
  try {
    const acc = await api("/accounts", { method: "POST", body: { groupId } });
    await loadAccounts();
    // 只有创建完成后才解锁并关闭；提交期间取消/背景/Esc 都会被忽略。
    setNewAccountSubmitting(false);
    closeNewAccountModal();
    toast("新账号已建立", "success");
    void doLogin(acc.id, false, acc.groupId ?? null);
  } catch (e) {
    toast("创建账号失败: " + e.message, "error");
  } finally {
    setNewAccountSubmitting(false);
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
    const res = await api(`/accounts/${id}/status?refresh=1`);
    if (span) span.innerHTML = statusInner(res);
    updateEmailCell(id, res.email);
    const acc = accountsCache.find((x) => x.id === id);
    if (acc) {
      acc.loggedIn = res.loggedIn;
      acc.state = res.state;
      acc.statusDetail = res.detail ?? null;
      acc.email = res.email;
    }
    updateStats();
    if (res.skipped) {
      toast("账号窗口正在使用，当前状态由该窗口自动更新");
    } else if (res.state === "reauth") {
      toast("该账号会话已失效，请点「重新登录」", "error");
      renderAccounts(); // 让“重新登录”按钮出现
    } else {
      toast("状态检测完成", "success");
    }
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
    let stateChanged = false;
    for (const [id, st] of Object.entries(all)) {
      const span = $(`[data-status="${id}"]`);
      if (span) {
        span.innerHTML = statusInner(st) +
          (st.checkedAt ? `<span class="time-ago" title="${fmtLocal(st.checkedAt)}"> · ${timeAgo(st.checkedAt)}</span>` : "");
      }
      if (st.email) updateEmailCell(id, st.email);

      const acc = accountsCache.find((x) => x.id === id);
      if (acc) {
        if (acc.state !== st.state) stateChanged = true;
        acc.loggedIn = st.loggedIn;
        acc.state = st.state;
        acc.statusDetail = st.detail ?? null;
        if (st.email) acc.email = st.email;
      }
    }
    updateStats();
    // 有账号刚变成/脱离“需重新登录”，重画一次让按钮同步。
    if (stateChanged) renderAccounts();
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
async function doLogin(id, force = false, groupIdOverride = undefined) {
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
  msg.textContent = force
    ? "正在清除失效的登录态并载入登录页…"
    : "正在启动浏览器并载入 ChatGPT 登录页…";
  // 明确告知这次登录走哪个出口，避免以为在走节点其实是系统网络
  const acc = accountsCache.find((x) => x.id === id);
  const groupId = groupIdOverride === undefined ? acc?.groupId ?? null : groupIdOverride;
  $("#login-exit").innerHTML = groupProxyLabel(groupId);

  let task;
  try {
    task = await api(`/accounts/${id}/login${force ? "?force=1" : ""}`, { method: "POST" });
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

// ---------- 代理节点 ----------
async function loadProxies() {
  try {
    const data = await api("/proxies");
    proxyCache = data.nodes ?? [];
    proxyStatus = data.status ?? {};
    $("#badge-proxy-count").textContent = proxyCache.filter((p) => !p.missing).length;
    // 订阅 URL 含令牌，后端不回传原文。已配置时只把输入框标注为“已保存”，
    // 留空即表示沿用已保存的地址（点“手动刷新订阅”会用它）。
    const sub = proxyStatus.subscription;
    const input = $("#proxy-sub-url");
    if (sub?.configured) {
      input.placeholder = `已保存（${sub.host}）· 留空刷新即沿用，填新地址则覆盖`;
    } else {
      input.placeholder = "https://example.com/subscribe?token=…";
    }
    renderProxyStatusLine();
    renderProxies();
  } catch (e) {
    toast("加载代理节点失败: " + e.message, "error");
  }
}

function renderProxyStatusLine() {
  const el = $("#proxy-status-line");
  const parts = [];
  const sub = proxyStatus.subscription;
  parts.push(
    sub?.updatedAt
      ? `订阅（${sub.host}）上次更新：${fmtLocal(sub.updatedAt)}`
      : "尚未导入订阅"
  );
  parts.push(`启用节点：${proxyStatus.nodeCount ?? 0}`);
  parts.push(`代理进程：${proxyStatus.running ? "运行中" : "未运行（有账号绑定时自动启动）"}`);
  if (proxyStatus.mihomo && !proxyStatus.mihomo.found) {
    parts.push("⚠ 未找到 mihomo 内核，请安装 Clash Verge 或放置 bin/mihomo.exe");
  }
  el.textContent = parts.join(" · ");
}

function renderProxies() {
  const tbody = $("#proxy-rows");
  tbody.innerHTML = "";

  let list = proxyCache;
  if (proxySearchQuery) {
    const q = proxySearchQuery.toLowerCase();
    list = list.filter((p) => (p.name || "").toLowerCase().includes(q));
  }
  $("#proxy-empty").hidden = list.length > 0;

  for (const p of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="acc-info-cell">
          <div class="acc-email">${escapeHtml(p.name)}${
            p.missing ? ' <span class="time-ago">(已不在订阅中)</span>' : ""
          }</div>
        </div>
      </td>
      <td><span class="hist-topic-badge">${escapeHtml(p.type || "-")}</span></td>
      <td><span class="time-ago">${escapeHtml(p.server || "-")}${
        p.port ? ":" + escapeHtml(p.port) : ""
      }</span></td>
      <td><span class="time-ago">${p.localPort ?? "-"}</span></td>
      <td>
        <label class="switch">
          <input type="checkbox" ${p.enabled ? "checked" : ""} data-pxen="${p.id}" />
          <span class="slider round"></span>
        </label>
      </td>
      <td style="text-align:right;">
        <span data-delay="${p.id}" class="time-ago">${proxyDelays[p.id] ?? ""}</span>
        <button class="btn small" data-pxtest="${p.id}">测速</button>
      </td>`;
    tbody.appendChild(tr);
  }

  $$("[data-pxen]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/proxies/${el.dataset.pxen}`, {
          method: "PATCH",
          body: { enabled: el.checked },
        });
        toast(el.checked ? "节点已启用" : "节点已停用", "success");
        loadProxies();
      } catch (e) {
        toast("更新失败: " + e.message, "error");
        el.checked = !el.checked;
      }
    })
  );

  $$("[data-pxtest]").forEach((el) =>
    el.addEventListener("click", () => testProxy(el.dataset.pxtest, el))
  );
}

async function testProxy(id, btn) {
  const cell = $(`[data-delay="${id}"]`);
  if (cell) cell.textContent = "测试中…";
  if (btn) setBtnLoading(btn, true);
  try {
    const res = await api(`/proxies/${id}/test`, { method: "POST" });
    const text = res.ok ? `${res.delay ?? "?"} ms` : "失败";
    proxyDelays[id] = text;
    if (cell) {
      cell.textContent = text;
      cell.title = res.ok ? "" : res.message || "";
    }
  } catch (e) {
    proxyDelays[id] = "错误";
    if (cell) {
      cell.textContent = "错误";
      cell.title = e.message;
    }
  } finally {
    if (btn) setBtnLoading(btn, false);
  }
}

$("#proxy-search").addEventListener("input", (e) => {
  proxySearchQuery = e.target.value;
  renderProxies();
});

$("#proxy-import").addEventListener("click", async () => {
  const btn = $("#proxy-import");
  const url = $("#proxy-sub-url").value.trim();
  // 已保存过订阅时允许留空 => 走 refresh 沿用已存地址
  if (!url) {
    if (proxyStatus.subscription?.configured) return $("#proxy-refresh").click();
    return toast("请填写订阅地址", "error");
  }
  setBtnLoading(btn, true, "导入中");
  try {
    const res = await api("/proxies/import", { method: "POST", body: { url } });
    toast(`导入完成：${res.count} 个节点`, "success");
    await loadProxies();
    renderAccounts();
  } catch (e) {
    toast("导入失败: " + e.message, "error");
  } finally {
    setBtnLoading(btn, false);
  }
});

$("#proxy-refresh").addEventListener("click", async () => {
  const btn = $("#proxy-refresh");
  setBtnLoading(btn, true, "刷新中");
  try {
    const res = await api("/proxies/refresh", { method: "POST" });
    toast(`刷新完成：${res.count} 个节点`, "success");
    await loadProxies();
    renderAccounts();
  } catch (e) {
    toast("刷新失败: " + e.message, "error");
  } finally {
    setBtnLoading(btn, false);
  }
});

// 逐个测速，避免一次性把所有节点全打一遍造成瞬时压力。
$("#proxy-test-all").addEventListener("click", async () => {
  const btn = $("#proxy-test-all");
  const targets = proxyCache.filter((p) => p.enabled && !p.missing);
  if (targets.length === 0) return toast("没有可测试的启用节点", "error");
  setBtnLoading(btn, true, "测试中");
  try {
    for (const p of targets) {
      await testProxy(p.id, null);
    }
    toast("全部测试完成", "success");
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
    f.openPageTimeoutMinutes.value = s.openPageTimeoutMinutes ?? 0;
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
        openPageTimeoutMinutes: Number(f.openPageTimeoutMinutes.value) || 0,
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
    closeGroupModal();
    closeNewAccountModal();
  }
});

// ---------- 初始化 ----------
async function init() {
  await loadConversations();
  await loadGroups();
  await loadProxies();
  await loadAccounts();
  loadSettings();
  loadScheduler();
  pollStatus();
}

init();
setInterval(loadScheduler, 8000);
setInterval(pollStatus, 10000);
