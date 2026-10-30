// Registration-only CDP initialization. Keep upstream browser.js unchanged.
import { RawCdpConnection, isMissingCdpSessionError } from "../src/browser.js";

const TARGET_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);
const TARGET_FILTER = [...TARGET_TYPES].map(type => ({ type }));
TARGET_FILTER.push({ exclude: true });

export async function installRegistrationTargetBarrier(
  { endpoint, identity, accountId, timezoneId, locale },
  { connect = url => RawCdpConnection.connect(url), log = console } = {},
) {
  const address = new URL(endpoint);
  if (!["http:", "ws:"].includes(address.protocol) || address.hostname !== "127.0.0.1") {
    throw new Error("Registration CDP must use a local endpoint");
  }
  if (address.protocol === "http:") {
    const response = await fetch(new URL("/json/version", address), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("无法读取注册浏览器 CDP 端点");
    endpoint = (await response.json()).webSocketDebuggerUrl;
  }
  const websocket = new URL(endpoint);
  if (websocket.protocol !== "ws:" || websocket.hostname !== "127.0.0.1") {
    throw new Error("Registration CDP must use a local WebSocket endpoint");
  }
  const connection = await connect(endpoint);
  // Without a filter Chrome also attaches browser_ui. It is not a web page
  // and must not hold up readiness on Runtime/Emulation commands.
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: TARGET_FILTER };
  const activeJobs = new Set();
  let failure = null;
  let context = null;
  let installing = true;
  let closed = false;
  let shutdownTimer = null;
  const close = () => {
    closed = true;
    clearTimeout(shutdownTimer);
    connection.close();
  };
  const fail = error => {
    if (closed) return;
    failure ??= error;
    if (!installing && context && shutdownTimer === null) {
      log.error(`注册浏览器 ${accountId} 初始化保护失效：${error.message}`);
      Promise.resolve().then(() => context.close()).catch(() => {});
    }
  };
  const prepare = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    const isFrame = targetInfo.type === "page" || targetInfo.type === "iframe";
    const commands = [];
    if (isFrame) commands.push(["子层初始化", "Target.setAutoAttach", autoAttach]);
    if (identity) commands.push(["UA-CH 初始化", "Emulation.setUserAgentOverride", {
      userAgent: identity.userAgent, platform: identity.platform,
      ...(identity.metadata ? { userAgentMetadata: identity.metadata } : {}),
    }]);
    if (isFrame && timezoneId) commands.push(["时区初始化", "Emulation.setTimezoneOverride", { timezoneId }]);
    if (isFrame && locale) commands.push(["语言初始化", "Emulation.setLocaleOverride", { locale }]);
    if (waitingForDebugger) commands.push(["恢复运行", "Runtime.runIfWaitingForDebugger", {}]);
    // Send the initialization and resume commands together, as the launcher
    // does upstream, then require every result before declaring readiness.
    const results = await Promise.allSettled(commands.map(async ([, method, params]) => {
      try {
        return await connection.send(method, params, sessionId);
      } catch (error) {
        if (isMissingCdpSessionError(error)) return;
        if (method === "Emulation.setLocaleOverride" && error.code === -32000
          && error.cdpMessage === "Another locale override is already in effect") return;
        throw error;
      }
    }));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        throw new Error(`Target ${targetInfo.type} ${commands[i][0]}失败：${results[i].reason?.message || results[i].reason}`);
      }
    }
  };
  connection.onEvent(message => {
    if (closed || message.method !== "Target.attachedToTarget") return;
    const params = message.params;
    if (!TARGET_TYPES.has(params.targetInfo.type)) {
      // Defensive fallback if a Chromium build reports an excluded target.
      // Detaching releases this client's debugger wait without sending Runtime
      // commands to an internal target. A detach error is still a real failure.
      const job = connection.send("Target.detachFromTarget", { sessionId: params.sessionId }, message.sessionId)
        .catch(error => { if (!isMissingCdpSessionError(error)) throw error; });
      activeJobs.add(job);
      job.catch(fail).finally(() => activeJobs.delete(job));
      return;
    }
    const job = prepare(params);
    activeJobs.add(job);
    job.catch(fail).finally(() => activeJobs.delete(job));
  });
  connection.onUnexpectedClose(error => {
    if (closed) return;
    failure ??= error;
    // A normal browser shutdown can close CDP before the context close event.
    shutdownTimer ??= setTimeout(() => {
      shutdownTimer = null;
      fail(error);
    }, 500);
    shutdownTimer.unref?.();
  });
  try {
    await connection.send("Target.setAutoAttach", autoAttach);
    await connection.send("Target.getTargets", { filter: TARGET_FILTER });
    while (activeJobs.size) await Promise.allSettled([...activeJobs]);
    if (failure) throw failure;
    installing = false;
  } catch (error) {
    close();
    throw error;
  }
  return {
    attachContext(target) {
      context = target;
      if (failure || closed) {
        Promise.resolve().then(() => target.close()).catch(() => {});
        throw failure ?? new Error("注册浏览器初始化连接已关闭");
      }
      target.once("close", close);
    },
    close,
  };
}
