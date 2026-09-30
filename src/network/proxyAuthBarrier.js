import { RawCdpConnection, isMissingCdpSessionError } from "../browser.js";
import { validateProxyCredentials } from "./strictConfig.js";

const NETWORK_TARGETS = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

function authError(reason) {
  return Object.assign(new Error(`代理认证屏障失败：${reason}`), { code: "PROXY_AUTH_BARRIER_FAILED" });
}

export function proxyAuthResponse(snapshot, challenge, attempted = false) {
  let origin;
  try { origin = new URL(challenge?.origin).origin; } catch { /* refuse malformed challenge */ }
  if (challenge?.source !== "Proxy" || origin !== snapshot.origin || attempted) {
    return { response: "CancelAuth" };
  }
  return { response: "ProvideCredentials", username: snapshot.username, password: snapshot.password };
}

/** M1 building block; intentionally not wired into production until WFP acceptance. */
export async function installProxyAuthBarrier({ endpoint, proxyOrigin, credentials, onFailure,
  connect = (url) => RawCdpConnection.connect(url) }) {
  validateProxyCredentials(credentials);
  const expected = new URL(proxyOrigin);
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || !expected.port
    || expected.username || expected.password || expected.pathname !== "/" || expected.search || expected.hash) {
    throw authError("入口必须是数值回环 HTTP 地址");
  }
  if (typeof onFailure !== "function") throw authError("必须提供关闭本次运行的失败处理器");
  const snapshot = Object.freeze({ origin: expected.origin, username: credentials.username, password: credentials.password });
  let wsEndpoint = endpoint;
  if (/^http:/u.test(endpoint)) {
    const address = new URL(endpoint);
    if (address.hostname !== "127.0.0.1") throw authError("CDP 必须使用回环端点");
    const response = await fetch(new URL("/json/version", address), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw authError("无法读取 CDP 端点");
    wsEndpoint = (await response.json()).webSocketDebuggerUrl;
  }
  const debuggerAddress = new URL(wsEndpoint);
  if (debuggerAddress.protocol !== "ws:" || debuggerAddress.hostname !== "127.0.0.1") throw authError("无效 CDP 端点");
  const connection = await connect(wsEndpoint);
  const tasks = new Set();
  const sessions = new Map();
  const attempted = new Map();
  const requestNetworks = new Map();
  const networkRequests = new Map();
  const seenTypes = new Set();
  let closed = false;
  let failure = null;
  let initializing = true;
  let provided = 0;
  let rejected = 0;
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

  const fail = (error) => {
    if (closed || failure) return;
    // Do not propagate URLs, protocol payloads, or secrets into logs/Operation errors.
    failure = authError(error?.code === -32601 ? "目标不支持认证拦截" : "初始化或运行连接异常");
    failure.details = Object.freeze({ protocolCode: Number.isInteger(error?.code) ? error.code : null,
      targetType: NETWORK_TARGETS.has(error?.targetType) ? error.targetType : null,
      method: ["Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"].includes(error?.method) ? error.method : null });
    Promise.resolve().then(() => onFailure(failure)).catch(() => {});
  };
  const track = (task) => {
    tasks.add(task);
    task.catch((error) => { if (!isMissingCdpSessionError(error)) fail(error); })
      .finally(() => tasks.delete(task));
  };
  async function prepare({ sessionId, targetInfo }, parentSessionId) {
    const type = targetInfo.type;
    seenTypes.add(type);
    const state = { type, fetch: false, owner: null };
    sessions.set(sessionId, state);
    if (NETWORK_TARGETS.has(type)) {
      if (type === "worker") {
        // Chromium routes dedicated-worker Fetch events through its owning frame.
        // Never resume an orphan worker just because Fetch is absent on its target.
        const parent = sessions.get(parentSessionId);
        const owner = parent?.fetch ? parentSessionId : parent?.owner;
        if (!sessions.get(owner)?.fetch) throw authError("Worker 缺少已安装认证处理的父目标");
        state.owner = owner;
      } else {
        try {
          await connection.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }, sessionId);
          state.fetch = true;
        } catch (error) { error.targetType = type; error.method = "Fetch.enable"; throw error; }
      }
      // Install interception before resuming, including recursively created workers/frames.
      await connection.send("Target.setAutoAttach", autoAttach, sessionId);
    }
    if (failure) throw failure;
    // Network.enable on a paused service worker may acknowledge only after it
    // resumes. Fetch is already installed; queue observation before resume but
    // wait for both together to avoid a startup deadlock.
    const observe = NETWORK_TARGETS.has(type) ? connection.send("Network.enable", {}, sessionId) : Promise.resolve();
    const resume = connection.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    await Promise.all([observe, resume]);
  }
  async function authenticate(message) {
    const { requestId, authChallenge } = message.params;
    const key = `${message.sessionId}:${requestId}`;
    const decision = proxyAuthResponse(snapshot, authChallenge, attempted.has(key) || attempted.size >= 4096);
    if (decision.response === "ProvideCredentials") {
      attempted.set(key, message.sessionId);
      provided++;
    } else rejected++;
    await connection.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: decision }, message.sessionId);
    if (authChallenge.source === "Proxy" && decision.response === "CancelAuth") {
      fail(authError("未知代理入口或重复认证失败"));
    }
  }
  connection.onEvent((message) => {
    if (closed || failure) return;
    if (message.method === "Target.attachedToTarget") track(prepare(message.params, message.sessionId));
    else if (message.method === "Target.detachedFromTarget") {
      sessions.delete(message.params.sessionId);
      for (const [key, session] of attempted) if (session === message.params.sessionId) attempted.delete(key);
      for (const key of requestNetworks.keys()) if (key.startsWith(`${message.params.sessionId}:`)) forgetRequest(key);
    } else if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") {
      // Worker Network events can arrive on a different session than its owner's
      // Fetch events; networkId correlates them without retaining request URLs.
      for (const key of [...(networkRequests.get(message.params.requestId) ?? [])]) forgetRequest(key);
    } else if (message.method === "Fetch.authRequired") track(authenticate(message));
    else if (message.method === "Fetch.requestPaused") {
      const { requestId, networkId } = message.params;
      if (networkId) {
        const key = `${message.sessionId}:${requestId}`;
        if (!requestNetworks.has(key) && requestNetworks.size >= 16384) { fail(authError("认证请求跟踪超限")); return; }
        requestNetworks.set(key, networkId);
        if (!networkRequests.has(networkId)) networkRequests.set(networkId, new Set());
        networkRequests.get(networkId).add(key);
      }
      track(connection.send("Fetch.continueRequest", { requestId }, message.sessionId));
    }
  });
  connection.onUnexpectedClose(() => fail(authError("CDP 断开")));
  function forgetRequest(key) {
    const networkId = requestNetworks.get(key);
    attempted.delete(key); requestNetworks.delete(key);
    const requests = networkRequests.get(networkId);
    requests?.delete(key); if (!requests?.size) networkRequests.delete(networkId);
  }
  try {
    await connection.send("Target.setAutoAttach", autoAttach);
    await connection.send("Target.getTargets");
    while (tasks.size) await Promise.allSettled([...tasks]);
    if (failure) throw failure;
    initializing = false;
    return {
      get state() { return { ready: !closed && !failure && !initializing, provided, rejected,
        targetTypes: [...seenTypes].sort(), activeSessions: sessions.size }; },
      close() { closed = true; attempted.clear(); requestNetworks.clear(); networkRequests.clear(); sessions.clear(); connection.close(); },
    };
  } catch (error) {
    closed = true;
    connection.close();
    throw failure ?? authError("CDP 初始化异常");
  }
}
