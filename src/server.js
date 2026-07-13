import express from "express";
import { fromRoot } from "./paths.js";
import * as store from "./store.js";
import { runOnce, scheduler } from "./scheduler.js";
import { startLogin, getLoginTask } from "./loginProvider.js";
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

// 统一包裹异步处理，把异常转成 500 JSON。
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log.error(String(e.stack || e));
    res.status(500).json({ error: String(e.message || e) });
  });

// ---------- 账号 ----------
// 账号列表附带缓存的登录状态，前端刷新即可显示实时状态。
app.get("/api/accounts", wrap(async (req, res) => {
  const accounts = store.getAccounts().map((a) => {
    const st = getCachedStatus(a.id);
    return { ...a, loggedIn: st.loggedIn, checkedAt: st.checkedAt };
  });
  res.json(accounts);
}));

app.post("/api/accounts", wrap(async (req, res) => {
  const { note, proxy, conversationSet } = req.body ?? {};
  const acc = store.addAccount({ note, proxy, conversationSet });
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
      loggedIn: result.loggedIn,
      email: result.email ?? null,
    });
  }
  const st = getCachedStatus(acc.id);
  res.json({ id: acc.id, loggedIn: st.loggedIn, email: st.email, checkedAt: st.checkedAt });
}));

// 所有账号的缓存状态（前端轮询用）。
app.get("/api/status", wrap(async (req, res) => {
  res.json(getAllCachedStatus());
}));

// ---------- 登录 ----------
app.post("/api/accounts/:id/login", wrap(async (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "账号不存在" });
  const task = await startLogin(acc);
  res.json(task);
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

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => {
  log.info(`GPT 账号管理面板已启动: http://localhost:${PORT}`);
  startStatusMonitor(); // 后台定时检查各账号登录状态
});
