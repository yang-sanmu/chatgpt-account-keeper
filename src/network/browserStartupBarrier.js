import { RawCdpConnection, isMissingCdpSessionError } from "../browser.js";
import { validateProxyCredentials } from "./strictConfig.js";
import { validateFixedEnvironment } from "../environmentConfig.js";

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
export async function installBrowserStartupBarrier({ endpoint, proxyOrigin, credentials, onFailure,
  identity = null, environment = null, commandTimeoutMs = 10_000,
  connect = (url) => RawCdpConnection.connect(url) }) {
  validateProxyCredentials(credentials);
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 30_000) throw authError("命令时限无效");
  const region = environment ? validateFixedEnvironment(environment) : null;
  const identitySnapshot = identity ? structuredClone(identity) : null;
  if (identitySnapshot && (typeof identitySnapshot.userAgent !== "string" || !identitySnapshot.userAgent
    || typeof identitySnapshot.platform !== "string")) throw authError("身份快照无效");
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
  // The only raw connection and Target auto-attach owner for this run. An open
  // transport without replies is a control failure, not proof of WFP blocking.
  const send = async (method, params, sessionId) => {
    let timer;
    try {
      return await Promise.race([connection.send(method, params, sessionId), new Promise((_, reject) => {
        timer = setTimeout(() => reject(authError("CDP 命令无响应")), commandTimeoutMs);
      })]);
    } catch (error) { error.method = method; throw error; }
    finally { clearTimeout(timer); }
  };
  const tasks = new Set();
  const sessions = new Map();
  const attempted = new Map();
  const requestNetworks = new Map();
  const networkRequests = new Map();
  const seenTypes = new Set();
  let closed = false;
  let closing = false;
  let closeObserved = false;
  let closeRequest;
  let failure = null;
  let initializing = true;
  let provided = 0;
  let rejected = 0;
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

  const fail = (error) => {
    if (closed || failure || (closing && closeObserved)) return;
    // Do not propagate URLs, protocol payloads, or secrets into logs/Operation errors.
    failure = authError(error?.code === -32601 ? "目标不支持认证拦截" : "初始化或运行连接异常");
    failure.details = Object.freeze({ protocolCode: Number.isInteger(error?.code) ? error.code : null,
      targetType: NETWORK_TARGETS.has(error?.targetType) ? error.targetType : null,
      method: ["Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger", "Emulation.setUserAgentOverride",
        "Emulation.setTimezoneOverride", "Emulation.setLocaleOverride", "Fetch.continueRequest", "Fetch.continueWithAuth", "Network.enable", "Network.loadingFailed", "Network.webSocketFrameError", "Browser.close"].includes(error?.method) ? error.method : null });
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
          await send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }, sessionId);
          state.fetch = true;
        } catch (error) { error.targetType = type; error.method = "Fetch.enable"; throw error; }
      }
      // Install interception before resuming, including recursively created workers/frames.
      await send("Target.setAutoAttach", autoAttach, sessionId);
    }
    if (failure) throw failure;
    // Network.enable on a paused service worker may acknowledge only after it
    // resumes. Fetch is already installed; queue observation before resume but
    // wait for both together to avoid a startup deadlock.
    // Queue emulation before resume on one ordered channel. Some renderer
    // commands acknowledge only after resume; waiting for each would deadlock.
    // Fetch gates document requests until initialization acknowledges; Service
    // Worker requests need the exception below to finish installation.
    const commands = [];
    if (identitySnapshot && NETWORK_TARGETS.has(type)) commands.push(send("Emulation.setUserAgentOverride", {
      userAgent: identitySnapshot.userAgent, platform: identitySnapshot.platform,
      ...(identitySnapshot.metadata ? { userAgentMetadata: identitySnapshot.metadata } : {}),
    }, sessionId));
    if (region && (type === "page" || type === "iframe")) {
      commands.push(send("Emulation.setTimezoneOverride", { timezoneId: region.timezone }, sessionId));
      commands.push(send("Emulation.setLocaleOverride", { locale: region.locale }, sessionId).catch(error => {
        if (error.code === -32000 && error.cdpMessage === "Another locale override is already in effect") return;
        throw error;
      }));
    }
    if (NETWORK_TARGETS.has(type)) commands.push(send("Network.enable", {}, sessionId));
    // Service Worker install/activate handlers can await fetch(). Their CDP
    // acknowledgements may depend on those requests completing. Interception is
    // already acknowledged; queued UA/environment commands precede resume.
    // Don't wait for worker execution/observation acknowledgements to answer its
    // intercepted requests. Main documents still wait for every acknowledgement.
    state.commandsQueued = true;
    if (type === "service_worker") {
      for (const request of state.paused ?? []) continueRequest(request);
      state.paused = [];
    }
    commands.push(send("Runtime.runIfWaitingForDebugger", {}, sessionId));
    const results = await Promise.allSettled(commands);
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) { rejected.reason.targetType = type; throw rejected.reason; }
    state.ready = true;
    for (const request of state.paused ?? []) continueRequest(request);
    state.paused = [];
  }
  async function authenticate(message) {
    const { requestId, authChallenge } = message.params;
    const key = `${message.sessionId}:${requestId}`;
    const decision = proxyAuthResponse(snapshot, authChallenge, attempted.has(key) || attempted.size >= 4096);
    if (decision.response === "ProvideCredentials") {
      attempted.set(key, message.sessionId);
      provided++;
    } else rejected++;
    await send("Fetch.continueWithAuth", { requestId, authChallengeResponse: decision }, message.sessionId);
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
      const keys = [...(networkRequests.get(message.params.requestId) ?? [])];
      // mihomo rejects supplied invalid credentials with 403, not a second 407.
      // Chrome reports a CONNECT failure rather than another authRequired event.
      // Fail only a tunnel/auth error on the request still awaiting the result of
      // our credential response. A site's TLS certificate error is not this case.
      if (message.method === "Network.loadingFailed"
        && ["net::ERR_TUNNEL_CONNECTION_FAILED", "net::ERR_INVALID_AUTH_CREDENTIALS"].includes(message.params.errorText)
        && keys.some(key => attempted.has(key))) {
        fail(Object.assign(authError("提交代理凭据后隧道失败"), { method: "Network.loadingFailed" }));
      }
      for (const key of keys) forgetRequest(key);
    } else if (message.method === "Network.webSocketFrameError" && message.params.errorMessage === "Proxy authentication failed") {
      // Observed Chrome 155 behavior: a cold WSS connection can reject proxy
      // auth without delivering Fetch.authRequired. Do not claim the run remains
      // ready or retry a potentially consequential socket operation. Supporting
      // cold WSS still requires a separate M1 solution; closing is not a fix for it.
      fail(Object.assign(authError("WebSocket 代理认证失败"), { method: "Network.webSocketFrameError" }));
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
      const state = sessions.get(message.sessionId);
      if (!state) { fail(authError("请求缺少已登记目标")); return; }
      if (state.ready || (state.type === "service_worker" && state.commandsQueued)) continueRequest(message);
      else {
        state.paused ??= [];
        if (state.paused.length >= 1024) { fail(authError("初始化请求过多")); return; }
        state.paused.push(message);
      }
    }
  });
  connection.onUnexpectedClose(() => {
    if (closing) { closeObserved = true; return; }
    fail(authError("CDP 断开"));
  });
  function continueRequest(message) {
    if (!closed && !failure) track(send("Fetch.continueRequest", { requestId: message.params.requestId }, message.sessionId));
  }
  function forgetRequest(key) {
    const networkId = requestNetworks.get(key);
    attempted.delete(key); requestNetworks.delete(key);
    const requests = networkRequests.get(networkId);
    requests?.delete(key); if (!requests?.size) networkRequests.delete(networkId);
  }
  try {
    await send("Target.setAutoAttach", autoAttach);
    await send("Target.getTargets");
    while (tasks.size) await Promise.allSettled([...tasks]);
    if (failure) throw failure;
    initializing = false;
    return {
      get state() { return { ready: !closed && !closing && !failure && !initializing, provided, rejected,
        controlState: failure ? "control_error" : closed ? "closed" : closing ? "closing" : initializing ? "initializing" : "ready",
        identityConfigured: !!identitySnapshot, environmentConfigured: !!region,
        targetTypes: [...seenTypes].sort(), activeSessions: sessions.size }; },
      requestBrowserClose() {
        if (closeRequest) return closeRequest;
        if (failure || closed) return Promise.reject(failure ?? authError("屏障已关闭"));
        // Keep authentication installed during graceful shutdown. Its expected
        // transport disconnect must not race Profile flushing with a Job kill.
        // This is only a close request: the caller still needs a bounded wait,
        // terminate fallback and a separate Job-empty proof before any reuse.
        closing = true;
        closeRequest = send("Browser.close").catch(error => {
          if (closeObserved) return;
          fail(error); throw failure ?? error;
        });
        return closeRequest;
      },
      close() { closed = true; attempted.clear(); requestNetworks.clear(); networkRequests.clear(); sessions.clear(); connection.close(); },
    };
  } catch (error) {
    fail(error);
    closed = true;
    connection.close();
    throw failure ?? authError("CDP 初始化异常");
  }
}
