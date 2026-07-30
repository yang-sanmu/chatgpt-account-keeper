import express from "express";
import { fromRoot } from "./paths.js";
import * as store from "./store.js";
import { runOnce, scheduler } from "./scheduler.js";
import { startLogin, getLoginTask } from "./loginProvider.js";
import { openPageForAccount, closePageForAccount, getOpenPages } from "./openPage.js";
import * as proxies from "./proxyManager.js";
import {
  getAllCachedStatus,
  getCachedStatus,
  refreshAccount,
  startStatusMonitor,
  restartStatusMonitor,
} from "./statusMonitor.js";
import { recordConversation, readHistory } from "./logger.js";
import * as log from "./logger.js";

const app = express();
app.use(express.json());
app.use(express.static(fromRoot("public")));

// 校验类错误（用户输入不合法）应答 400 且不打堆栈，避免日志被正常的表单校验刷满。
class BadRequest extends Error {}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const msg = String(e.message || e);
    if (e instanceof BadRequest || e?.badRequest) {
      log.warn(msg);
      return res.status(400).json({ error: msg });
    }
    log.error(String(e.stack || e));
    res.status(500).json({ error: msg });
  });

// ---------- 账号 ----------
function getLoginGroupOrThrow(groupId) {
  if (!groupId) return null;
  const group = store.getGroup(groupId);
  if (!group) throw new BadRequest("分组不存在，请重新选择");
  if (!group.proxyId) return group;

  const node = proxies.getNodes().find((n) => n.id === group.proxyId);
  if (!node) throw new BadRequest("分组绑定的代理节点不存在，请到分组管理中重新选择");
  if (node.missing) throw new BadRequest("分组绑定的代理节点已失效，请到分组管理中重新选择");
  if (!node.enabled) throw new BadRequest("分组绑定的代理节点已停用，请先启用或重新选择");
  return group;
}

// 账号列表附带缓存的登录状态，前端刷新即可显示实时状态。
app.get("/api/accounts", wrap(async (req, res) => {
  const open = getOpenPages();
  const accounts = store.getAccounts().map((a) => {
    const st = getCachedStatus(a.id);
    return {
      ...a,
      state: st.state,
      loggedIn: st.loggedIn,
      statusDetail: st.detail ?? null,
      checkedAt: st.checkedAt,
      pageOpen: !!open[a.id],
    };
  });
  res.json(accounts);
}));

app.post("/api/accounts", wrap(async (req, res) => {
  const { note, groupId } = req.body ?? {};
  const normalizedGroupId = groupId || null;
  const selectedGroup = getLoginGroupOrThrow(normalizedGroupId);
  const selectedProxyId = selectedGroup?.proxyId ?? null;

  // 有分组代理时先把边车真正启动起来，再落账号。这样节点失效、停用、
  // mihomo 缺失或端口起不来都不会留下一个无法登录的半成品账号。
  if (selectedProxyId) {
    let ready;
    try {
      ready = await proxies.ensureRunning();
    } catch (e) {
      throw new BadRequest(`分组代理无法启动：${String(e.message || e)}`);
    }
    if (!ready?.running) throw new BadRequest("分组代理未能启动，请检查代理节点配置");

    // ensureRunning 有 await；期间分组可能被另一个请求修改，落盘前必须再确认。
    const latestGroup = getLoginGroupOrThrow(normalizedGroupId);
    if (latestGroup.proxyId !== selectedProxyId) {
      throw new BadRequest("分组代理已发生变化，请重新确认登录出口");
    }
  }

  const acc = store.addAccount({ note, groupId: normalizedGroupId });
  res.json(acc);
}));

app.patch("/api/accounts/:id", wrap(async (req, res) => {
  const updated = store.updateAccount(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: "账号不存在" });
  res.json(updated);
}));

app.delete("/api/accounts/:id", wrap(async (req, res) => {
  const ok = store.removeAccount(req.params.id);
  if (!ok) return res.status(404).json({ error: "账号不存在" });
  res.json({ ok: true });
}));

// 账号登录状态。默认读缓存（秒回）；?refresh=1 强制现开浏览器检查。
app.get("/api/accounts/:id/status", wrap(async (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "账号不存在" });
  if (req.query.refresh === "1") {
    const result = await refreshAccount(acc);
    return res.json({
      id: acc.id,
      state: result.state,
      loggedIn: result.loggedIn,
      email: result.email ?? null,
      detail: result.detail ?? null,
      skipped: !!result.skipped,
    });
  }
  const st = getCachedStatus(acc.id);
  res.json({
    id: acc.id,
    state: st.state,
    loggedIn: st.loggedIn,
    email: st.email,
    detail: st.detail ?? null,
    checkedAt: st.checkedAt,
  });
}));

// 所有账号的缓存状态（前端轮询用）。
app.get("/api/status", wrap(async (req, res) => {
  res.json(getAllCachedStatus());
}));

// ---------- 登录 ----------
// force=1 时先清掉旧会话再登录。用于改过密码/加过双重认证的账号：
// 旧 cookie 会让程序误判“已登录”并秒关窗口，清掉才能真正看到登录页。
app.post("/api/accounts/:id/login", wrap(async (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "账号不存在" });
  const force = req.query.force === "1" || req.body?.force === true;
  const task = await startLogin(acc, { force });
  res.json(task);
}));

// ---------- 打开网页（不自动关闭，由用户手动关） ----------
app.post("/api/accounts/:id/open-page", wrap(async (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "账号不存在" });
  const result = await openPageForAccount(acc, req.body?.url);
  res.json(result);
}));

app.post("/api/accounts/:id/close-page", wrap(async (req, res) => {
  const ok = await closePageForAccount(req.params.id);
  res.json({ ok });
}));

app.get("/api/open-pages", wrap(async (req, res) => {
  res.json(getOpenPages());
}));

// ---------- 分组 ----------
app.get("/api/groups", wrap(async (req, res) => {
  res.json(store.getGroups());
}));

app.post("/api/groups", wrap(async (req, res) => {
  res.json(store.addGroup(req.body?.name, req.body?.proxyId));
}));

// 分组的 name / proxyId 都可单独更新。代理绑在分组上，组内账号统一走该节点。
app.patch("/api/groups/:id", wrap(async (req, res) => {
  const { name, proxyId } = req.body ?? {};
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (proxyId !== undefined) patch.proxyId = proxyId;
  const g = store.updateGroup(req.params.id, patch);
  if (!g) return res.status(404).json({ error: "分组不存在" });
  res.json(g);
}));

app.delete("/api/groups/:id", wrap(async (req, res) => {
  const ok = store.removeGroup(req.params.id);
  if (!ok) return res.status(404).json({ error: "分组不存在" });
  res.json({ ok: true });
}));

// ---------- 代理节点 ----------
app.get("/api/proxies", wrap(async (req, res) => {
  res.json({ nodes: proxies.getNodes(), status: proxies.status() });
}));

// 只有这里和 /refresh 会真的去拉订阅，不存在自动刷新。
app.post("/api/proxies/import", wrap(async (req, res) => {
  res.json(await proxies.importSubscription(req.body?.url));
}));

app.post("/api/proxies/refresh", wrap(async (req, res) => {
  res.json(await proxies.refreshSubscription());
}));

app.patch("/api/proxies/:id", wrap(async (req, res) => {
  const n = await proxies.setNodeEnabled(req.params.id, req.body?.enabled);
  if (!n) return res.status(404).json({ error: "节点不存在" });
  res.json(n);
}));

app.post("/api/proxies/:id/test", wrap(async (req, res) => {
  res.json(await proxies.testNode(req.params.id));
}));

app.get("/api/login-tasks/:taskId", wrap(async (req, res) => {
  const task = getLoginTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  res.json(task);
}));

// ---------- 立即跑一次 ----------
app.post("/api/accounts/:id/run", wrap(async (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "账号不存在" });
  const headless = store.getSettings().headless;
  const result = await runOnce(acc, { headless });
  recordConversation(acc.id, result);
  res.json(result);
}));

// ---------- 会话内容 ----------
app.get("/api/conversations", wrap(async (req, res) => {
  res.json(store.getConversations());
}));

app.put("/api/conversations/:name", wrap(async (req, res) => {
  const set = store.saveConversationSet(req.params.name, req.body ?? {});
  res.json(set);
}));

app.delete("/api/conversations/:name", wrap(async (req, res) => {
  const ok = store.removeConversationSet(req.params.name);
  if (!ok) return res.status(404).json({ error: "会话集不存在" });
  res.json({ ok: true });
}));

// ---------- 调度器 ----------
app.get("/api/scheduler", wrap(async (req, res) => {
  res.json(scheduler.status());
}));

app.post("/api/scheduler/start", wrap(async (req, res) => {
  res.json(scheduler.start());
}));

app.post("/api/scheduler/stop", wrap(async (req, res) => {
  res.json(await scheduler.stop());
}));

// ---------- 设置 ----------
app.get("/api/settings", wrap(async (req, res) => {
  res.json(store.getSettings());
}));

app.put("/api/settings", wrap(async (req, res) => {
  const saved = store.saveSettings(req.body ?? {});
  restartStatusMonitor(); // 间隔可能改了，重置定时器
  res.json(saved);
}));

// ---------- 历史 ----------
app.get("/api/accounts/:id/history", wrap(async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(readHistory(req.params.id, limit));
}));

// 旧版本把代理存在账号上，启动时安全迁移到分组，避免出口变化。
store.migrateAccountProxyToGroup();

const PORT = process.env.PORT || 5173;
// 只监听本机回环地址：面板没有任何鉴权，且能操作已登录的 ChatGPT 会话、
// 读写代理节点配置。绑 0.0.0.0 会让同网段的人直接接管这些账号。
// 确实要在别的机器访问，请自行加鉴权后再改 HOST。
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  log.info(`GPT 账号管理面板已启动: http://${HOST}:${PORT}`);
  startStatusMonitor(); // 后台定时检查各账号登录状态
});
