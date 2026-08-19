import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { fromRoot, ensureDir } from "./paths.js";
import { proxyForAccount, ensureRunning } from "./proxyManager.js";
import { getAccount, effectiveProxyId } from "./store.js";
import { resolveRegionForAccount } from "./geo.js";
import { scheduleProfileCacheMaintenance } from "./profileMaintenance.js";
import * as log from "./logger.js";

/**
 * 用本机安装的真实 Google Chrome，而不是 Playwright 自带的 Chromium。
 *
 * 为什么必须这样：Chromium 的 userAgentData.brands 只有 "Chromium"，
 * 真实 Chrome 会多一项 "Google Chrome"。Cloudflare 会交叉校验这个列表；
 * 虽然 CDP 能覆盖该值，但伪造品牌或写死版本会制造更明显的矛盾。实测同一节点、同一时间窗口下，
 * 真实 Chrome/Edge（即使开无痕）都不弹验证，自带 Chromium 会弹。
 *
 * 同时不再硬编码 UA：过去写死 Chrome/131 而内核实际是 149，
 * UA 与 userAgentData 自相矛盾，反倒是比不改更强的自动化特征。
 * Headless 唯一需要处理的是 Chrome 自己暴露的 "HeadlessChrome" 产品名；
 * 下面会从当前实际浏览器读取完整 UA，只替换该产品名，版本始终保持一致。
 */
const BROWSER_CHANNEL = "chrome";
const HEADLESS_IDENTITY_CACHE_MS = 5 * 60 * 1000;
const DEVTOOLS_ENDPOINT_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const IDENTITY_TARGET_TYPES = new Set([
  "page",
  "iframe",
  "worker",
  "shared_worker",
  "service_worker",
]);
const HEADLESS_UA_HIGH_ENTROPY_HINTS = [
  "architecture",
  "bitness",
  "model",
  "platformVersion",
  "fullVersionList",
  "wow64",
  "formFactors",
];
// BrowserContext -> { accountId, headless }
//
// 账号锁只能阻止第二个 Profile 实例启动，不能让“打开网页”抢占一个已经在跑的
// Headless 任务。记录归属后，明确的用户交互可以只关闭同账号的后台 Context，
// 不影响其它账号，也不会误关登录/手动打开的有头窗口。
const activeBrowserContexts = new Map();
let browserShutdownRequested = false;

/**
 * Agent 退出后不允许排队中的账号任务再启动 Chrome。已启动的持久化上下文
 * 统一在这里登记，这样调度、巡检、登录和“打开网页”都能由同一条退出链释放。
 */
function beginBrowserShutdown() {
  browserShutdownRequested = true;
}

export async function closeAllBrowserContexts({ timeoutMs = 3_000 } = {}) {
  beginBrowserShutdown();
  const contexts = [...activeBrowserContexts.keys()];
  await Promise.all(contexts.map(async (context) => {
    let timer;
    const closing = Promise.resolve().then(() => context.close()).catch((error) => {
      log.warn(`关闭 Chrome 上下文失败：${String(error?.message || error)}`);
    });
    await Promise.race([
      closing,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }));
  return contexts.length;
}

export async function closeHeadlessBrowserContextsForAccount(
  accountId,
  { timeoutMs = 3_000 } = {}
) {
  const contexts = [...activeBrowserContexts.entries()]
    .filter(([, metadata]) =>
      metadata.accountId === accountId && metadata.headless === true
    )
    .map(([context]) => context);

  await Promise.all(contexts.map(async (context) => {
    let timer;
    const closing = Promise.resolve().then(() => context.close()).catch((error) => {
      log.warn(
        `关闭账号 ${accountId} 的后台 Chrome 失败：${String(error?.message || error)}`
      );
    });
    await Promise.race([
      closing,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }));
  return contexts.length;
}

export function normalizeHeadlessUserAgent(userAgent) {
  return String(userAgent ?? "").replace(/\bHeadlessChrome\//g, "Chrome/");
}

function normalizeHeadlessBrandList(brands) {
  if (!Array.isArray(brands)) return brands;
  const hasChromium = brands.some((item) => item?.brand === "Chromium");
  const seen = new Set();
  const normalized = [];

  for (const item of brands) {
    if (!item || typeof item !== "object") continue;
    if (item.brand === "HeadlessChrome" && hasChromium) continue;
    const next =
      item.brand === "HeadlessChrome"
        ? { ...item, brand: "Chromium" }
        : { ...item };
    const key = `${next.brand}\0${next.version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

/**
 * 还原同一浏览器的有头身份，只移除 Headless 专属产品名。
 *
 * 品牌 Chrome 当前只在 legacy UA 中暴露 HeadlessChrome；bundled Chromium
 * 还会在 UA-CH brands/fullVersionList 中多放一个 HeadlessChrome 条目。
 * 后者必须删除，否则“找不到 Chrome”的降级路径仍会被验证页直接识别。
 */
export function normalizeHeadlessIdentity(native = {}) {
  const metadata = native.metadata
    ? {
        ...native.metadata,
        brands: normalizeHeadlessBrandList(native.metadata.brands),
        fullVersionList: normalizeHeadlessBrandList(
          native.metadata.fullVersionList
        ),
      }
    : null;
  return {
    ...native,
    userAgent: normalizeHeadlessUserAgent(native.userAgent),
    metadata,
  };
}

const headlessIdentityCache = new Map();

export class ChromeNotFoundError extends Error {
  constructor(cause) {
    super("未找到可用的 Google Chrome。请先安装 Google Chrome 后重试。", {
      cause,
    });
    this.name = "ChromeNotFoundError";
    this.code = "CHROME_NOT_FOUND";
    this.retryable = false;
  }
}

export function normalizeChromeLaunchError(error) {
  return isMissingChannelError(error) ? new ChromeNotFoundError(error) : error;
}

/**
 * Headless Chrome 会把自身暴露为 HeadlessChrome，ChatGPT/Cloudflare 会据此
 * 直接让 session 接口返回 403。不能用硬编码 UA，也不能只改字符串后丢掉
 * UA Client Hints：两者都会制造新的版本/平台矛盾。
 *
 * 先用同一浏览器渠道启动一个不访问外网的临时实例，读取当前真实 UA 与高熵
 * UA-CH。启动参数先确保所有首包的 legacy UA 不暴露 HeadlessChrome；随后
 * 通过浏览器级 CDP 为每个 Target 带回完整原值，使 JavaScript、后续请求头、
 * 平台和架构一致。branded Chrome 的原生 UA-CH 不含 HeadlessChrome；
 * 生产路径只允许 branded Chrome。channel 参数保留在探测函数上，仅用于
 * 隔离测试；账号启动始终传入 chrome 渠道，绝不降级到 bundled Chromium。
 */
export async function probeHeadlessIdentity(channel) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(channel ? { channel } : {}),
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const page = await browser.newPage();
    // bundled Chromium 不允许 page.goto("chrome://version/")。拦截保留域名并
    // 本地返回空页面，既适用于 Chrome/Chromium，又不会真的访问外部网络。
    await page.route("https://identity.invalid/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>identity probe</title>",
      })
    );
    await page.goto("https://identity.invalid/", {
      waitUntil: "domcontentloaded",
    });
    const native = await page.evaluate(async (highEntropyHints) => {
      const uaData = navigator.userAgentData;
      const rawMetadata = uaData
        ? await uaData.getHighEntropyValues(highEntropyHints)
        : null;
      const metadata = rawMetadata
        ? {
            brands: rawMetadata.brands,
            fullVersionList: rawMetadata.fullVersionList,
            platform: rawMetadata.platform,
            platformVersion: rawMetadata.platformVersion,
            architecture: rawMetadata.architecture,
            model: rawMetadata.model,
            mobile: rawMetadata.mobile,
            bitness: rawMetadata.bitness,
            wow64: rawMetadata.wow64,
            formFactors: rawMetadata.formFactors,
          }
        : null;
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        metadata,
      };
    }, HEADLESS_UA_HIGH_ENTROPY_HINTS);

    const identity = normalizeHeadlessIdentity(native);
    if (!identity.userAgent) throw new Error("无法读取浏览器 User-Agent");
    return identity;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function getHeadlessIdentity(channel) {
  const key = channel || "__test_browser__";
  const now = Date.now();
  let entry = headlessIdentityCache.get(key);
  if (!entry || entry.expiresAt <= now) {
    entry = {
      expiresAt: now + HEADLESS_IDENTITY_CACHE_MS,
      promise: probeHeadlessIdentity(channel),
    };
    headlessIdentityCache.set(key, entry);
  }
  try {
    return await entry.promise;
  } catch (error) {
    // “没有安装 Chrome”在缓存期内无需每个账号都重新探测；
    // 其它临时错误下次立即重试。
    if (!isMissingChannelError(error) && headlessIdentityCache.get(key) === entry) {
      headlessIdentityCache.delete(key);
    }
    throw error;
  }
}

async function configureHeadlessLaunch(launchArgs) {
  try {
    const identity = await getHeadlessIdentity(BROWSER_CHANNEL);
    configureHeadlessLaunchArgs(launchArgs, identity);
    return identity;
  } catch (error) {
    throw normalizeChromeLaunchError(error);
  }
}

function configureHeadlessLaunchArgs(launchArgs, identity) {
  // --user-agent 是 Target 初始化前的第一层兜底，尤其覆盖 Service Worker
  // 脚本请求；完整 UA-CH 会在下面通过浏览器级 CDP 自动附加恢复。
  launchArgs.args = launchArgs.args.filter(
    (arg) =>
      !arg.startsWith("--user-agent=") &&
      !arg.startsWith("--remote-debugging-port=") &&
      !arg.startsWith("--remote-debugging-address=")
  );
  launchArgs.args.push(
    `--user-agent=${identity.userAgent}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0"
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevToolsEndpoint(userDataDir, notBefore) {
  const endpointFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + DEVTOOLS_ENDPOINT_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(endpointFile, "utf8"),
        fs.stat(endpointFile),
      ]);
      // 避免异常退出遗留的旧端口文件被误读。Windows 文件时间粒度保留 2 秒余量。
      if (stats.mtimeMs + 2_000 < notBefore) {
        await delay(50);
        continue;
      }
      const [portLine, pathLine] = content.trim().split(/\r?\n/);
      const port = Number(portLine);
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        !pathLine?.startsWith("/devtools/browser/")
      ) {
        throw new Error("DevToolsActivePort 内容无效");
      }
      return `ws://127.0.0.1:${port}${pathLine}`;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }

  throw new Error(
    `无法连接 Headless Chrome 的本地调试端口：${String(
      lastError?.message || lastError || "等待超时"
    )}`
  );
}

class RawCdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.closeHandlers = new Set();
    this.closed = false;
    this.intentionalClose = false;

    socket.on("message", (data) => this.#handleMessage(data));
    // ws 的 error 若没有监听器会成为未捕获异常；真正的失败由 close/send 统一处理。
    socket.on("error", () => {});
    socket.on("close", (code, reason) => {
      this.closed = true;
      const detail = `CDP WebSocket 已关闭（${code}${
        reason?.length ? `: ${reason.toString()}` : ""
      }）`;
      const error = new Error(detail);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      if (!this.intentionalClose) {
        for (const handler of this.closeHandlers) handler(error);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("连接 Chrome CDP WebSocket 超时"));
      }, DEVTOOLS_ENDPOINT_TIMEOUT_MS);
      const onOpen = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    return new RawCdpConnection(socket);
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
  }

  onUnexpectedClose(handler) {
    this.closeHandlers.add(handler);
  }

  async send(method, params = {}, sessionId = null) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome CDP WebSocket 当前不可用");
    }

    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP 命令超时：${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  close() {
    if (this.closed) return;
    this.intentionalClose = true;
    this.socket.close();
  }

  #handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          `Chrome CDP 错误 ${message.error.code}: ${message.error.message}`
        );
        error.code = message.error.code;
        error.cdpMessage = message.error.message;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const handler of this.eventHandlers) handler(message);
  }
}

/**
 * Target 在初始化命令处理前已经结束时，Chrome 会返回这个精确错误。
 * 此时该 session 已不存在，不可能继续以未覆盖身份运行；替代 Target 仍会被
 * browser 级 auto-attach 捕获。其它 CDP 错误一律不能放行。
 */
export function isMissingCdpSessionError(error) {
  return (
    error?.code === -32001 &&
    error?.cdpMessage === "Session with given id not found."
  );
}

async function installHeadlessTargetIdentity(
  context,
  {
    userDataDir,
    notBefore,
    identity,
    accountId,
  }
) {
  const endpoint = await waitForDevToolsEndpoint(userDataDir, notBefore);
  const connection = await RawCdpConnection.connect(endpoint);
  const activeJobs = new Set();
  let installing = true;
  let installError = null;
  let contextClosed = false;
  let shutdownTimer = null;

  const scheduleIdentityShutdown = (message) => {
    if (contextClosed || shutdownTimer) return;
    // Playwright 正常关闭 Context 时，原始 CDP socket 往往先于 context 的
    // close 事件断开。短暂等待事件归位，避免把正常退出误报成保护失效。
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (contextClosed) return;
      log.error(message);
      context.close().catch(() => {});
    }, 500);
  };

  context.once("close", () => {
    contextClosed = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    connection.close();
  });

  const autoAttach = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  };
  const override = {
    userAgent: identity.userAgent,
    platform: identity.platform,
    ...(identity.metadata ? { userAgentMetadata: identity.metadata } : {}),
  };

  const prepareTarget = async ({ sessionId, targetInfo }) => {
    // 两条消息按 WebSocket 顺序发出，但一起等待：部分新 renderer 只有恢复
    // Runtime 后才回送 Emulation 响应。Playwright/启动参数已先保证首包 UA，
    // 这里在页面脚本执行前把高熵 UA-CH 恢复为探测到的完整原值。
    //
    // OOPIF、验证框和页面创建的 Worker 是 page/iframe Target 的子层 Target，
    // 根 browser session 看不到它们。因此必须先在这两类 session 上继续
    // auto-attach；消息按序发出，可确保父 Target 恢复前屏障已经安装。
    const nestedAutoAttachCommand =
      targetInfo.type === "page" || targetInfo.type === "iframe"
        ? connection.send(
            "Target.setAutoAttach",
            autoAttach,
            sessionId
          )
        : Promise.resolve();
    const identityCommand = IDENTITY_TARGET_TYPES.has(targetInfo.type)
      ? connection.send(
          "Emulation.setUserAgentOverride",
          override,
          sessionId
        )
      : Promise.resolve();
    const resumeCommand = connection.send(
      "Runtime.runIfWaitingForDebugger",
      {},
      sessionId
    );
    const [nestedAutoAttachResult, identityResult, resumeResult] =
      await Promise.allSettled([
        nestedAutoAttachCommand,
        identityCommand,
        resumeCommand,
      ]);
    if (
      nestedAutoAttachResult.status === "rejected" &&
      !isMissingCdpSessionError(nestedAutoAttachResult.reason)
    ) {
      throw new Error(
        `Target ${targetInfo.type} 子层身份屏障安装失败：${String(
          nestedAutoAttachResult.reason?.message || nestedAutoAttachResult.reason
        )}`
      );
    }
    if (
      identityResult.status === "rejected" &&
      !isMissingCdpSessionError(identityResult.reason)
    ) {
      throw new Error(
        `Target ${targetInfo.type} UA-CH 初始化失败：${String(
          identityResult.reason?.message || identityResult.reason
        )}`
      );
    }
    if (
      resumeResult.status === "rejected" &&
      !isMissingCdpSessionError(resumeResult.reason)
    ) {
      throw new Error(
        `Target ${targetInfo.type} 恢复运行失败：${String(
          resumeResult.reason?.message || resumeResult.reason
        )}`
      );
    }
  };

  const startJob = (event) => {
    const job = prepareTarget(event);
    activeJobs.add(job);
    job
      .catch((error) => {
        installError ??= error;
        if (!installing && !contextClosed) {
          const message =
            `账号 ${accountId} 浏览器身份保护失效，关闭本次浏览器：${error.message}`;
          if (/CDP WebSocket (?:已关闭|当前不可用)/.test(error.message)) {
            scheduleIdentityShutdown(message);
          } else {
            // 明确的协议/参数错误不是正常关闭竞争，立即 fail-closed。
            log.error(message);
            context.close().catch(() => {});
          }
        }
      })
      .finally(() => activeJobs.delete(job));
  };

  connection.onEvent((message) => {
    if (message.method === "Target.attachedToTarget") {
      startJob(message.params);
    }
  });
  connection.onUnexpectedClose((error) => {
    // 正常 context.close 时两条连接的关闭事件可能有几十毫秒先后，稍等后再判定。
    scheduleIdentityShutdown(
      `账号 ${accountId} 浏览器身份保护连接中断，关闭本次浏览器：${error.message}`
    );
  });

  try {
    await connection.send("Target.setAutoAttach", autoAttach);
    // getTargets 是安装屏障：其响应返回前，已有 Target 的 attached 事件已进入队列。
    await connection.send("Target.getTargets");
    do {
      const snapshot = [...activeJobs];
      if (!snapshot.length) {
        await Promise.resolve();
        if (!activeJobs.size) break;
      } else {
        await Promise.allSettled(snapshot);
      }
    } while (activeJobs.size);

    if (installError) throw installError;
    installing = false;
    return connection;
  } catch (error) {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    connection.close();
    throw error;
  }
}

/**
 * WebRTC 的 UDP 不受 --proxy-server 约束，会绕过代理直接走系统网络。
 * 实测走节点的浏览器里，WebRTC 漏出的是系统 Clash 的出口 IP，与该浏览器
 * 的 HTTP 出口分属两个国家——同一会话出现两个国家的 IP 是明确的代理特征。
 *
 * 注意：品牌版 Chrome 会忽略 --force-webrtc-ip-handling-policy
 * （该策略只认企业策略配置），自带 Chromium 才吃这个开关。所以保留开关做兜底，
 * 真正生效的是下面在页面层清空 iceServers 的做法。
 */
export const WEBRTC_NO_LEAK_FLAG =
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

/**
 * 页面层堵 WebRTC：保留 RTCPeerConnection 本身，只把 iceServers 清空。
 *
 * 不直接删掉这个 API——真实 Chrome 一定有它，删了反而是更明显的特征。
 * 清空 STUN 服务器后页面仍能正常构造连接对象，但收集不到公网候选地址，
 * 也就漏不出出口 IP。ChatGPT 不使用 WebRTC，无功能影响。
 */
export function webrtcGuardScript() {
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  const Patched = function (config, ...rest) {
    return new Native({ ...(config || {}), iceServers: [] }, ...rest);
  };
  Patched.prototype = Native.prototype;
  // 保持 name / toString 与原生一致，避免被指纹脚本看出是包装过的
  Object.defineProperty(Patched, "name", { value: "RTCPeerConnection" });
  Patched.toString = () => Native.toString();
  window.RTCPeerConnection = Patched;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
}

/**
 * 构造启动参数。
 *
 * 后台任务使用真正的 Headless，不创建可见窗口或任务栏图标。
 * 登录和“打开网页”会传入 false，仍然使用有头 Chrome 供用户操作。
 */
export function baseLaunchArgs(headless) {
  return {
    headless: !!headless,
    channel: BROWSER_CHANNEL,
    // Headless 的 UA 会在首次外部导航前从同一浏览器运行时读取并规范化。
    // 有头模式不设 userAgent，完全沿用 Chrome 原生值。
    // 有头窗口使用 Chrome 原生窗口尺寸并强制从最大化状态启动，避免 Profile 中
    // 由 Headless/远程桌面留下的窗口位置让窗口落到屏幕外或保持最小化。
    viewport: headless ? { width: 1280, height: 900 } : null,
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      ...(!headless ? ["--start-maximized"] : []),
      `--disk-cache-size=${64 * 1024 * 1024}`,
      `--media-cache-size=${16 * 1024 * 1024}`,
    ],
  };
}

/**
 * 只有走代理的浏览器才需要堵 WebRTC：未绑节点的账号 HTTP 本来就走系统网络，
 * 与 WebRTC 出口一致，没有可暴露的矛盾，不必改动其行为。
 */
export function applyWebrtcPolicy(launchArgs, usingProxy) {
  if (usingProxy && !launchArgs.args.includes(WEBRTC_NO_LEAK_FLAG)) {
    launchArgs.args.push(WEBRTC_NO_LEAK_FLAG);
  }
  return launchArgs;
}

/**
 * 给 Playwright 的代理配置追加直连域名。
 *
 * bypass 是逗号分隔字符串；这里保留调用方已有规则并去重，避免后续新增兼容域名时
 * 覆盖节点自身的配置。域名列表只来自程序内常量，不接收页面或用户输入。
 */
export function applyProxyBypass(proxy, domains = []) {
  if (!proxy) return proxy;

  const entries = [
    ...String(proxy.bypass ?? "").split(","),
    ...(Array.isArray(domains) ? domains : []),
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);

  if (!entries.length) return proxy;
  return { ...proxy, bypass: [...new Set(entries)].join(",") };
}

/**
 * 判断启动失败是否因为本机没装对应的浏览器渠道。
 * Playwright 找不到 channel 时报的是 "Chromium distribution 'chrome' is not found"。
 */
export function isMissingChannelError(err) {
  const msg = String(err?.message || err);
  return (
    /Chromium distribution ['"]?chrome['"]? is not found/i.test(msg) ||
    /channel ['"]?chrome['"]? is not installed/i.test(msg) ||
    (/executable doesn't exist/i.test(msg) &&
      /(?:Google[\\/ ]Chrome|chrome(?:\.exe)?)/i.test(msg))
  );
}

/**
 * 完成已启动 Context 的页面初始化。
 *
 * 该函数拥有初始化阶段的 Context：在它把 Context 交给调用方之前，任何一步失败
 * 都必须先关闭浏览器。否则调用方拿不到 Context，Chrome 进程和 Profile 文件锁
 * 会一直遗留到进程退出。
 */
export async function initializeLaunchedContext(context, options = {}) {
  const {
    headless = false,
    headlessIdentity = null,
    usingProxy = false,
    accountId = "unknown",
    userDataDir = null,
    debugPortNotBefore = 0,
    targetIdentityInstaller = installHeadlessTargetIdentity,
  } = options;

  try {
    // 抹掉最明显的自动化痕迹。
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // 走代理时才需要堵 WebRTC：未走代理的浏览器 HTTP 与 WebRTC 同源。
    if (usingProxy) await context.addInitScript(webrtcGuardScript);

    if (headless) {
      if (!headlessIdentity) throw new Error("缺少 Headless 浏览器身份信息");
      if (!userDataDir) throw new Error("缺少 Headless Profile 路径");

      // 浏览器级自动附加会暂停每个新 Target，在其运行和首个页面请求前恢复
      // 完整 UA-CH。启动参数中的 --user-agent 则覆盖更早的 SW 脚本请求。
      await targetIdentityInstaller(context, {
        userDataDir,
        notBefore: debugPortNotBefore,
        identity: headlessIdentity,
        accountId,
      });
    }

    const existingPages = context.pages();
    const page = existingPages[0] ?? (await context.newPage());
    return { context, page };
  } catch (error) {
    // 清理错误不能掩盖真正的初始化失败原因。
    await context.close().catch((closeError) => {
      log.warn(
        `浏览器初始化失败后的清理也失败：${String(
          closeError?.message || closeError
        )}`
      );
    });
    throw error;
  }
}

/**
 * 为某个账号启动持久化浏览器上下文。
 * 关键点：userDataDir 落盘，登录态（cookies/localStorage）随之持久化，
 * 手动登录一次后，后续任务复用同一目录即免登录。
 *
 * @param {object} account accounts.json 里的单个账号对象
 * @param {object} opts { headless: boolean }
 * @returns {Promise<{context, page}>}
 */
export async function launchForAccount(account, opts = {}) {
  if (browserShutdownRequested) throw new Error("Agent 正在退出，已取消启动 Chrome");

  // 调用可能在账号锁后排队很久（例如用户一直开着“打开网页”窗口）。
  // 真正启动时重新读取，避免期间改过的分组/分组代理没生效、任务走了旧出口。
  const liveAccount = getAccount(account?.id) ?? account;
  const headless = opts.headless ?? true;
  const userDataDir = ensureDir(fromRoot(liveAccount.profileDir));

  const launchArgs = baseLaunchArgs(headless);
  let headlessIdentity = null;

  // 定向代理：账号所属分组绑了节点就走该节点的本地端口，否则走系统默认网络。
  if (effectiveProxyId(liveAccount)) {
    // 边车必须先就绪，否则 Chromium 会连到一个还没监听的端口。
    await ensureRunning();
    const p = proxyForAccount(liveAccount);
    if (p) {
      launchArgs.proxy = applyProxyBypass(p, opts.proxyBypass);
      log.info(`账号 ${liveAccount.id} 使用代理节点 -> ${p.server}`);
    } else {
      // 绑了节点却拿不到端口（节点被停用/已从订阅移除）。宁可报错也不静默裸奔，
      // 否则账号会用错误的出口 IP 访问，风险更高。
      throw new Error(
        `账号所属分组绑定的代理节点不可用（可能已停用或不在订阅中），请到分组管理里重新选择节点`
      );
    }

    // 时区/语言跟着出口走：境外 IP 配本机东八区时区是明显的不一致信号。
    // 探测失败就沿用默认，不阻断登录。
    const region = await resolveRegionForAccount(liveAccount);
    if (region.timezoneId) launchArgs.timezoneId = region.timezoneId;
    if (region.locale) launchArgs.locale = region.locale;

    applyWebrtcPolicy(launchArgs, true);
  }

  if (headless) {
    headlessIdentity = await configureHeadlessLaunch(launchArgs);
  }

  if (browserShutdownRequested) throw new Error("Agent 正在退出，已取消启动 Chrome");

  let context;
  const debugPortNotBefore = Date.now();
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchArgs);
  } catch (e) {
    throw normalizeChromeLaunchError(e);
  }

  activeBrowserContexts.set(context, {
    accountId: liveAccount.id,
    headless: !!headless,
  });
  context.once("close", () => {
    activeBrowserContexts.delete(context);
    if (!browserShutdownRequested) scheduleProfileCacheMaintenance(liveAccount.id);
  });
  if (browserShutdownRequested) {
    await context.close().catch(() => {});
    throw new Error("Agent 正在退出，已取消启动 Chrome");
  }

  return initializeLaunchedContext(context, {
    headless,
    headlessIdentity,
    usingProxy: !!launchArgs.proxy,
    accountId: liveAccount.id,
    userDataDir,
    debugPortNotBefore,
  });
}
