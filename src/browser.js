import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import { fromRoot, ensureDir } from "./paths.js";
import { proxyForAccount, ensureRunning } from "./proxyManager.js";
import { getAccount, effectiveProxyId } from "./store.js";
import { resolveRegionForAccount } from "./geo.js";
import { scheduleProfileCacheMaintenance } from "./profileMaintenance.js";
import { replaceFileSync } from "./atomicFile.js";
import { throwIfCancelled } from "./cancellation.js";
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
const DEVTOOLS_ENDPOINT_TIMEOUT_MS = 30_000;
const CDP_CONNECTION_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const INTERACTIVE_CDP_TIMEOUT_MS = 15_000;
const INTERACTIVE_CDP_POLL_TIMEOUT_MS = 750;
const INTERACTIVE_PROCESS_EXIT_TIMEOUT_MS = 2_000;
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

const delay = (ms, signal = null) => new Promise((resolve, reject) => {
  throwIfCancelled(signal);
  const finish = () => {
    signal?.removeEventListener("abort", abort);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    try {
      throwIfCancelled(signal);
    } catch (error) {
      reject(error);
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
});

export async function waitForDevToolsEndpoint(
  userDataDir,
  notBefore,
  { timeoutMs = DEVTOOLS_ENDPOINT_TIMEOUT_MS, signal = null } = {}
) {
  throwIfCancelled(signal);
  const endpointFile = path.join(userDataDir, "DevToolsActivePort");
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastState = "尚未读取 DevToolsActivePort";

  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(endpointFile, { encoding: "utf8", signal: signal ?? undefined }),
        fs.stat(endpointFile),
      ]);
      throwIfCancelled(signal);
      // 避免异常退出遗留的旧端口文件被误读。Windows 文件时间粒度保留 2 秒余量。
      // 慢启动时旧文件会一直存在，不能删 Profile/放宽新鲜度检查来掩盖它。
      if (stats.mtimeMs + 2_000 < notBefore) {
        lastState = `DevToolsActivePort 仍是旧文件（早于本次启动 ${Math.round(notBefore - stats.mtimeMs)}ms）`;
      } else {
        const [portLine, pathLine] = content.trim().split(/\r?\n/);
        const port = Number(portLine);
        if (
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65_535 ||
          !pathLine?.startsWith("/devtools/browser/")
        ) {
          lastState = "DevToolsActivePort 内容无效或尚未写完";
        } else {
          return `ws://127.0.0.1:${port}${pathLine}`;
        }
      }
    } catch (error) {
      throwIfCancelled(signal);
      // 文件系统原始 message 含账号 Profile 路径，诊断只保留状态/错误码。
      lastState = error?.code === "ENOENT"
        ? "DevToolsActivePort 尚未生成"
        : `DevToolsActivePort 读取失败（${error?.code || "未知文件错误"}）`;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(50, remaining), signal);
  }

  throwIfCancelled(signal);
  const elapsedMs = Date.now() - started;
  const error = new Error(
    `无法连接 Headless Chrome 的本地调试端口：等待超时（已等待 ${elapsedMs}ms，限时 ${timeoutMs}ms；${lastState}）`
  );
  error.code = "CHROME_DEVTOOLS_TIMEOUT";
  error.elapsedMs = elapsedMs;
  error.timeoutMs = timeoutMs;
  throw error;
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
      }, CDP_CONNECTION_TIMEOUT_MS);
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
 * 在 Playwright 接管**之前**安装身份屏障（计划 §9.1 步骤 3 早于步骤 4）。
 *
 * 与 installHeadlessTargetIdentity 的区别：那个版本先有 Context 再装屏障，只适用于
 * launchPersistentContext。broker 路径下 Chrome 由创建时纳管方式启动，必须在
 * connectOverCDP 之前就把 auto-attach 屏障装好并处理完既有 Target，否则 Playwright
 * 自己的 attach 可能让 Target 先跑起来，页面脚本会在完整 UA-CH 恢复前执行。
 *
 * 返回 barrier：attachContext(context) 用于接上 fail-closed 关闭路径，close() 释放连接。
 */
export async function installIdentityBarrierOnEndpoint({ endpoint, identity, accountId }) {
  const connection = await RawCdpConnection.connect(endpoint);
  const activeJobs = new Set();
  let installing = true;
  let installError = null;
  let closed = false;
  let shutdownTimer = null;
  let context = null;

  const closeBrowser = () => {
    if (context) context.close().catch(() => {});
  };

  const scheduleIdentityShutdown = (message) => {
    if (closed || shutdownTimer) return;
    // 正常关闭时原始 CDP socket 往往先于 context 的 close 事件断开；短暂等待事件
    // 归位，避免把正常退出误报成保护失效。
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (closed) return;
      log.error(message);
      closeBrowser();
    }, 500);
    shutdownTimer.unref?.();
  };

  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  const override = {
    userAgent: identity.userAgent,
    platform: identity.platform,
    ...(identity.metadata ? { userAgentMetadata: identity.metadata } : {}),
  };

  const prepareTarget = async ({ sessionId, targetInfo }) => {
    const nestedAutoAttachCommand =
      targetInfo.type === "page" || targetInfo.type === "iframe"
        ? connection.send("Target.setAutoAttach", autoAttach, sessionId)
        : Promise.resolve();
    const identityCommand = IDENTITY_TARGET_TYPES.has(targetInfo.type)
      ? connection.send("Emulation.setUserAgentOverride", override, sessionId)
      : Promise.resolve();
    const resumeCommand = connection.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    const [nested, identityResult, resumeResult] = await Promise.allSettled([
      nestedAutoAttachCommand,
      identityCommand,
      resumeCommand,
    ]);
    for (const [result, label] of [
      [nested, "子层身份屏障安装"],
      [identityResult, "UA-CH 初始化"],
      [resumeResult, "恢复运行"],
    ]) {
      if (result.status === "rejected" && !isMissingCdpSessionError(result.reason)) {
        throw new Error(
          `Target ${targetInfo.type} ${label}失败：${String(result.reason?.message || result.reason)}`
        );
      }
    }
  };

  const startJob = (event) => {
    const job = prepareTarget(event);
    activeJobs.add(job);
    job
      .catch((error) => {
        installError ??= error;
        if (!installing && !closed) {
          const message = `账号 ${accountId} 浏览器身份保护失效，关闭本次浏览器：${error.message}`;
          if (/CDP WebSocket (?:已关闭|当前不可用)/.test(error.message)) {
            scheduleIdentityShutdown(message);
          } else {
            log.error(message);
            closeBrowser();
          }
        }
      })
      .finally(() => activeJobs.delete(job));
  };

  connection.onEvent((message) => {
    if (message.method === "Target.attachedToTarget") startJob(message.params);
  });
  connection.onUnexpectedClose((error) => {
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
  } catch (error) {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    connection.close();
    throw error;
  }

  return {
    attachContext(target) {
      context = target;
      target.once("close", () => {
        closed = true;
        if (shutdownTimer) clearTimeout(shutdownTimer);
        shutdownTimer = null;
        connection.close();
      });
    },
    close() {
      closed = true;
      if (shutdownTimer) clearTimeout(shutdownTimer);
      shutdownTimer = null;
      connection.close();
    },
  };
}

/**
 * WebRTC 的 UDP 不受 --proxy-server 约束，会绕过代理直接走系统网络。
 * 实测走节点的浏览器里，WebRTC 会漏出系统 Clash 的出口 IP，与该浏览器
 * 的 HTTP 出口分属两个国家——同一会话出现两个国家的 IP 是明确的代理特征。
 *
 * 品牌 Chrome 会忽略 content shell 的 --force-webrtc-ip-handling-policy 开关；
 * 页面层包装 RTCPeerConnection 又会进入 hCaptcha 的 hsw 证明，表现为图片题
 * 做对但 Stripe 服务端仍返回 `Captcha challenge failed`。因此在 Profile 启动前
 * 写入 Chrome 正式偏好 webrtc.ip_handling_policy，页面对象始终保持原生。
 */
const WEBRTC_IP_HANDLING_POLICY = "disable_non_proxied_udp";
let preferencesTempCounter = 0;

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
      // 有头窗口由 Chrome 原生进程启动；不要给验证脚本留下这个反自动化开关。
      // Headless 后台任务仍需要它配合浏览器级身份恢复。
      ...(headless ? ["--disable-blink-features=AutomationControlled"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      ...(!headless ? ["--start-maximized"] : []),
      `--disk-cache-size=${64 * 1024 * 1024}`,
      `--media-cache-size=${16 * 1024 * 1024}`,
    ],
  };
}

/**
 * 私有节点和“跟随系统代理”都可能让 HTTP 与直出 UDP 使用不同出口，因此所有
 * 隔离账号 Profile 都启用同一原生偏好。该策略仍允许代理支持的 UDP 或 TCP
 * 回退，不替换/删除网页 API。
 */
export function applyWebrtcProfilePolicy(
  userDataDir,
  { fsImpl = fsSync, replaceFile = replaceFileSync } = {}
) {
  const profileDir = path.join(path.resolve(userDataDir), "Default");
  const preferencesFile = path.join(profileDir, "Preferences");
  fsImpl.mkdirSync(profileDir, { recursive: true });

  let preferences = {};
  try {
    preferences = JSON.parse(fsImpl.readFileSync(preferencesFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Chrome Preferences 无法解析，拒绝覆盖：${preferencesFile}`, {
        cause: error,
      });
    }
  }
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new Error(`Chrome Preferences 根节点无效，拒绝覆盖：${preferencesFile}`);
  }
  if (preferences.webrtc?.ip_handling_policy === WEBRTC_IP_HANDLING_POLICY) {
    return false;
  }

  const existingWebrtc =
    preferences.webrtc &&
    typeof preferences.webrtc === "object" &&
    !Array.isArray(preferences.webrtc)
      ? preferences.webrtc
      : {};
  const next = {
    ...preferences,
    webrtc: {
      ...existingWebrtc,
      ip_handling_policy: WEBRTC_IP_HANDLING_POLICY,
    },
  };
  const tempFile = path.join(
    profileDir,
    `.Preferences.${process.pid}.${++preferencesTempCounter}.tmp`
  );
  let operationError = null;
  try {
    fsImpl.writeFileSync(tempFile, JSON.stringify(next), "utf8");
    replaceFile(tempFile, preferencesFile, { fsImpl });
  } catch (error) {
    operationError = error;
  }
  try {
    fsImpl.unlinkSync(tempFile);
  } catch (error) {
    if (error?.code !== "ENOENT" && !operationError) operationError = error;
  }
  if (operationError) throw operationError;
  return true;
}

/**
 * Playwright 的 launchPersistentContext 会自动追加一整套自动化启动参数。
 * Stripe/hCaptcha 会把这些浏览器进程级特征纳入证明：页面图片题虽然通过，
 * 服务端仍可能拒绝 verify_challenge。交互窗口因此由本机 Chrome 原生启动，
 * Playwright 只在启动完成后通过本地 CDP 接管页面和生命周期。
 */
export function chromeExecutableCandidates(
  environment = process.env,
  platform = process.platform
) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const pathEntries = String(environment.PATH ?? environment.Path ?? "")
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = (entries) => [...new Set(entries.filter(Boolean))];

  if (platform === "win32") {
    const programFiles = environment.ProgramFiles ?? environment.PROGRAMFILES;
    const programFilesX86 =
      environment["ProgramFiles(x86)"] ?? environment["PROGRAMFILES(X86)"];
    const localAppData = environment.LOCALAPPDATA;
    return unique([
      programFiles &&
        path.win32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      programFilesX86 &&
        path.win32.join(
          programFilesX86,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        ),
      localAppData &&
        path.win32.join(
          localAppData,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        ),
      ...pathEntries.map((entry) => platformPath.join(entry, "chrome.exe")),
    ]);
  }
  if (platform === "darwin") {
    return unique([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      environment.HOME &&
        path.posix.join(
          environment.HOME,
          "Applications",
          "Google Chrome.app",
          "Contents",
          "MacOS",
          "Google Chrome"
        ),
      ...pathEntries.flatMap((entry) => [
        platformPath.join(entry, "google-chrome-stable"),
        platformPath.join(entry, "google-chrome"),
      ]),
    ]);
  }
  return unique([
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/opt/google/chrome/chrome",
    ...pathEntries.flatMap((entry) => [
      platformPath.join(entry, "google-chrome-stable"),
      platformPath.join(entry, "google-chrome"),
    ]),
  ]);
}

export function findChromeExecutable(
  candidates = chromeExecutableCandidates(),
  exists = fsSync.existsSync
) {
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/**
 * 只把业务确实需要的参数交给交互式 Chrome。这里刻意使用允许列表，防止未来
 * 给 Playwright Headless 新增的反自动化/沙箱参数意外进入付款窗口。
 */
export function buildInteractiveChromeArgs({
  userDataDir,
  launchArgs,
  debugPort,
}) {
  const args = [
    `--user-data-dir=${path.resolve(userDataDir)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${debugPort}`,
  ];

  for (const arg of launchArgs.args ?? []) {
    if (
      arg.startsWith("--disk-cache-size=") ||
      arg.startsWith("--media-cache-size=")
    ) {
      if (!args.includes(arg)) args.push(arg);
    }
  }

  if (launchArgs.locale) {
    args.push(
      `--lang=${launchArgs.locale}`,
      // --lang 只控制 Chrome UI；既有 Profile 的 intl.accept_languages 会继续
      // 覆盖 navigator.language 与请求头。Chromium 的原生 --accept-lang 同时
      // 覆盖两者，不需要修改 Profile 或注入页面脚本。
      `--accept-lang=${launchArgs.locale}`
    );
  }
  if (launchArgs.proxy?.server) {
    args.push(`--proxy-server=${launchArgs.proxy.server}`);
    const bypass = String(launchArgs.proxy.bypass ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(";");
    if (bypass) args.push(`--proxy-bypass-list=${bypass}`);
  }

  args.push("about:blank");
  return args;
}

export async function reserveLocalDebugPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("无法分配 Chrome 本地调试端口"));
        else resolve(port);
      });
    });
  });
}

export async function waitForInteractiveCdp(
  port,
  child = null,
  getSpawnError = () => null
) {
  const deadline = Date.now() + INTERACTIVE_CDP_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child && (child.exitCode != null || child.signalCode != null)) {
      throw new Error(
        `Chrome 在调试端口就绪前退出（exit=${child.exitCode}, signal=${child.signalCode}）`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(INTERACTIVE_CDP_POLL_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Chrome DevTools 探测返回 HTTP ${response.status}`);
      }
      const metadata = await response.json();
      const webSocketUrl = new URL(metadata?.webSocketDebuggerUrl);
      if (
        webSocketUrl.protocol === "ws:" &&
        Number(webSocketUrl.port) === port &&
        webSocketUrl.pathname.startsWith("/devtools/browser/")
      ) {
        return;
      }
      throw new Error("Chrome DevTools 探测响应无效");
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `等待交互式 Chrome 本地调试端口超时：${String(
      lastError?.message || lastError || "unknown"
    )}`
  );
}

function childHasExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

async function stopChromeChild(
  child,
  { timeoutMs = INTERACTIVE_PROCESS_EXIT_TIMEOUT_MS } = {}
) {
  if (childHasExited(child)) return;

  let onExit;
  let exited = null;
  if (typeof child.once === "function") {
    exited = new Promise((resolve) => {
      onExit = resolve;
      child.once("exit", onExit);
    });
  }

  if (!child.killed) child.kill();
  if (!exited) return;

  await Promise.race([exited, delay(timeoutMs)]);
  if (!childHasExited(child)) {
    // SIGTERM 在 Unix 上可能被忽略；Windows 的 kill 也可能只表示信号已发出。
    // 最后一层兜底确保 Profile 锁在 close() 返回前真正释放。
    child.kill("SIGKILL");
    await Promise.race([exited, delay(500)]);
  }
  child.off?.("exit", onExit);
}

/**
 * CDP 接入的默认持久 Context 不能用 Playwright 的普通 context.close 负责进程
 * 生命周期。把同一公开方法收口到 browser.close，保持 login/openPage/退出清理
 * 的既有调用约定不变。
 */
export function installInteractiveContextClose(context, browser, child) {
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = Promise.resolve()
        .then(() => browser.close())
        .finally(() => stopChromeChild(child));
    }
    return closing;
  };
  Object.defineProperty(context, "close", {
    configurable: true,
    value: close,
  });
  return context;
}

export async function applyInteractiveTimezone(context, page, timezoneId) {
  if (!timezoneId) return;
  const sessions = new Map();
  const configure = async (targetPage) => {
    if (!targetPage || sessions.has(targetPage)) return;
    const session = await context.newCDPSession(targetPage);
    try {
      await session.send("Emulation.setTimezoneOverride", { timezoneId });
      sessions.set(targetPage, session);
      targetPage.once("close", () => {
        if (sessions.get(targetPage) !== session) return;
        sessions.delete(targetPage);
        session.detach().catch(() => {});
      });
    } catch (error) {
      await session.detach().catch(() => {});
      throw error;
    }
  };
  // Chrome 可能按 Profile 启动设置恢复多个既有标签页。它们与业务页共享同一
  // 浏览器出口，必须使用同一时区，不能只覆盖最终选中的 about:blank。
  for (const targetPage of new Set([...(context.pages?.() ?? []), page])) {
    await configure(targetPage);
  }
  const onPage = (targetPage) => {
    configure(targetPage).catch((error) => {
      log.warn(`新窗口设置时区失败：${String(error?.message || error)}`);
    });
  };
  context.on("page", onPage);
  context.once("close", () => {
    context.off("page", onPage);
    const active = [...sessions.values()];
    sessions.clear();
    for (const session of active) session.detach().catch(() => {});
  });
}

export async function launchInteractivePersistentContext(
  userDataDir,
  launchArgs,
  dependencies = {}
) {
  const executable =
    dependencies.executable ?? findChromeExecutable(dependencies.candidates);
  if (!executable) {
    throw new ChromeNotFoundError(new Error("Google Chrome executable not found"));
  }

  const port = dependencies.port ?? (await reserveLocalDebugPort());
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const connectOverCDP =
    dependencies.connectOverCDP ??
    ((endpoint) => chromium.connectOverCDP(endpoint));
  const child = spawnProcess(
    executable,
    buildInteractiveChromeArgs({ userDataDir, launchArgs, debugPort: port }),
    {
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    }
  );
  let spawnError = null;
  child.on?.("error", (error) => {
    spawnError = error;
  });

  let browser = null;
  try {
    await (dependencies.waitForCdp ?? waitForInteractiveCdp)(
      port,
      child,
      () => spawnError
    );
    browser = await connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("交互式 Chrome 没有默认浏览器上下文");
    installInteractiveContextClose(context, browser, child);

    const pages = context.pages();
    const page =
      pages.find((candidate) => candidate.url() === "about:blank") ??
      pages[0] ??
      (await context.newPage());
    await (dependencies.applyTimezone ?? applyInteractiveTimezone)(
      context,
      page,
      launchArgs.timezoneId
    );
    return { context, page };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await stopChromeChild(child);
    throw normalizeChromeLaunchError(error);
  }
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
    (err?.code === "ENOENT" &&
      /(?:chrome(?:\.exe)?|google-chrome-stable|Google Chrome)$/i.test(
        String(err?.path ?? "")
      )) ||
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
// 组合根注入的 Chrome 创建器。存在时所有账号启动都必须经它（broker 创建时纳管），
// 不再走 launchPersistentContext / 自建 spawn。为 null 时保留旧路径，供 CLI 与
// 现有单元测试使用；Windows Agent 在 broker 不可用时会 fail-closed，不会落到这里。
let injectedLauncher = null;

export function configureChromeLauncher(launcher) {
  injectedLauncher = launcher ?? null;
  return injectedLauncher;
}

export function getChromeLauncher() {
  return injectedLauncher;
}

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
  }

  // 即使没有绑定私有节点，Chrome 也可能跟随系统 HTTP 代理；WebRTC UDP 不会
  // 自动跟随该代理，因此账号 Profile 必须统一使用原生防漏偏好。
  applyWebrtcProfilePolicy(userDataDir);

  if (headless) {
    headlessIdentity = await configureHeadlessLaunch(launchArgs);
  }

  if (browserShutdownRequested) throw new Error("Agent 正在退出，已取消启动 Chrome");

  let context;
  let interactiveLaunch = null;
  const debugPortNotBefore = Date.now();

  // 注入了 broker 启动器时，有头与无头共用同一条创建时纳管路径，并在
  // connectOverCDP 之前装好身份屏障。
  if (injectedLauncher) {
    // 调用方必须提供已登记到 BrowserRun 的 runToken。自造 token 会让这次启动的
    // Job 无人 dispose，同时把 BrowserRun 关联到一个从未启动进程的 token 上——
    // 关闭序列于是对着空 token 收敛，真实 Chrome 残留且不可见。fail-closed。
    const runToken = opts.runToken;
    if (!runToken) {
      throw new Error(
        "启动 Chrome 缺少已登记的 runToken：必须经 BrowserRun 登记后再启动，不能自行创建"
      );
    }
    const launched = await injectedLauncher.launch({
      userDataDir,
      launchArgs,
      headless,
      accountId: liveAccount.id,
      headlessIdentity,
      runToken,
      signal: opts.signal ?? null,
    });
    activeBrowserContexts.set(launched.context, {
      accountId: liveAccount.id,
      headless: !!headless,
    });
    launched.context.once("close", () => {
      activeBrowserContexts.delete(launched.context);
      if (!browserShutdownRequested) scheduleProfileCacheMaintenance(liveAccount.id);
    });
    if (!headless && launchArgs.timezoneId) {
      await applyInteractiveTimezone(launched.context, launched.page, launchArgs.timezoneId);
    }
    return launched;
  }

  try {
    if (headless) {
      context = await chromium.launchPersistentContext(userDataDir, launchArgs);
    } else {
      interactiveLaunch = await launchInteractivePersistentContext(
        userDataDir,
        launchArgs
      );
      context = interactiveLaunch.context;
    }
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

  if (!headless) return interactiveLaunch;

  return initializeLaunchedContext(context, {
    headless: true,
    headlessIdentity,
    accountId: liveAccount.id,
    userDataDir,
    debugPortNotBefore,
  });
}
