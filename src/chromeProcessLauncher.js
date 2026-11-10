import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  ChromeNotFoundError,
  findChromeExecutable,
  installIdentityBarrierOnEndpoint,
  normalizeChromeLaunchError,
  chromeNotStartedError,
  reserveLocalDebugPort,
  waitForDevToolsEndpoint,
  waitForInteractiveCdp,
  RawCdpConnection,
} from "./browser.js";
import { connectManualBrowser } from "./manualBrowser.js";
import * as defaultLog from "./logger.js";
import { throwIfCancelled } from "./cancellation.js";
import { STRICT_RESOLVER_ARGUMENT } from "./network/strictConfig.js";

/**
 * 统一的 Chrome 创建入口（计划 §9.1）。有头与无头共用同一条路径：同样的进程登记、
 * 启动错峰与关闭代码。
 *
 * 顺序是硬约束，不可交换：
 *   1. 经 broker 以创建时纳管方式启动 Chrome（唯一初始页 about:blank）
 *   2. 读 DevToolsActivePort 拿到调试端点
 *   3. Raw CDP 先装 Target.setAutoAttach 屏障并处理完既有 Target
 *   4. 之后才 connectOverCDP
 *   5. 最后才业务导航
 *
 * 第 3 步必须早于第 4 步：屏障要在任何页面脚本运行前把完整 UA-CH 恢复到位，
 * 否则 connectOverCDP 自身的 attach 可能让 Target 先跑起来。
 */

export class ChromeProcessLauncher {
  constructor(options = {}) {
    this._broker = options.broker ?? null;
    this._log = options.log ?? defaultLog;
    this._connectOverCDP = options.connectOverCDP ?? ((endpoint, connectOptions) => chromium.connectOverCDP(endpoint, connectOptions));
    this._connectManual = options.connectManualBrowser ?? (endpoint => connectManualBrowser(endpoint, { connect: RawCdpConnection.connect }));
    this._waitForDevTools = options.waitForDevToolsEndpoint ?? waitForDevToolsEndpoint;
    this._reserveDebugPort = options.reserveLocalDebugPort ?? reserveLocalDebugPort;
    this._waitForInteractiveCdp =
      options.waitForInteractiveCdp ?? waitForInteractiveCdp;
    this._findChrome = options.findChromeExecutable ?? findChromeExecutable;
    this._installBarrier = options.installIdentityBarrier ?? installIdentityBarrierOnEndpoint;
    this._awaitLaunchPermit = options.awaitLaunchPermit ?? null;
  }

  configureBroker(broker) {
    this._broker = broker;
    return this;
  }

  get hasBroker() {
    return !!this._broker?.running;
  }

  /** runToken 由 Agent 侧单调生成并单次使用；broker 对已 dispose 的 token 永不复用。 */
  newRunToken() {
    if (!this._broker) throw new Error("chrome-launcher 未配置");
    return this._broker.newRunToken();
  }

  /**
   * 启动一个 Chrome 并接管。返回 { context, page, rootPid, rootStartTime, runToken,
   * brokerGenerationId, endpoint, closeBrowser }。
   *
   * 调用方负责把这些登记进 BrowserRun；本函数不持有任何 Job 句柄——那是 broker 的
   * 独占资源，Agent 持有副本会让 broker 崩溃时 KILL_ON_JOB_CLOSE 不触发。
   */
  async launch({
    userDataDir,
    launchArgs,
    headless,
    accountId,
    headlessIdentity = null,
    manual = false,
    environmentMode = "inherit",
    runToken,
    signal = null,
  }) {
    let executable, resolvedUserDataDir, debugPort, args, notBefore;
    let previousPortFile = null;
    try {
      throwIfCancelled(signal);
      if (!this._broker?.running) {
        const error = new Error("chrome-launcher 不可用，无法启动 Chrome");
        error.code = "CHROME_BROKER_UNAVAILABLE";
        throw error;
      }
      executable = this._findChrome();
      if (!executable) throw new ChromeNotFoundError(new Error("Google Chrome executable not found"));

      resolvedUserDataDir = path.resolve(userDataDir);
      if (headless) {
        try {
          previousPortFile = await fs.readFile(path.join(resolvedUserDataDir, "DevToolsActivePort"), {
            encoding: "utf8", signal: signal ?? undefined,
          });
        } catch (error) {
          throwIfCancelled(signal);
          if (error.code !== "ENOENT") {
            throw new Error(`无法读取启动前的 DevToolsActivePort（${error.code}）`);
          }
        }
      }
      // 账号准备可能同时结束。把错峰放到 broker 创建进程前，避免积攒许可后扎堆启动。
      if (this._awaitLaunchPermit) await this._awaitLaunchPermit(signal);
      throwIfCancelled(signal);
      // 交互窗口在许可到手后才预留非零端口；Headless 仍由 Chrome 分配端口。
      debugPort = headless ? 0 : await this._reserveDebugPort();
      args = buildLaunchArgs({ userDataDir: resolvedUserDataDir, launchArgs, headless, debugPort });
      notBefore = Date.now();
      throwIfCancelled(signal);
    } catch (error) {
      // 所有启动前失败都无 Job，包括 Chrome 缺失、调试端口分配失败和取消。
      throw chromeNotStartedError(error);
    }
    const launched = await this._broker.launch(runToken, executable, args);

    let browser = null;
    let barrier = null;
    try {
      throwIfCancelled(signal);
      // 2) Headless 从 DevToolsActivePort 读取 Chrome 分配的端口；交互窗口则等待
      //    预先分配的非零端口就绪，避免 port=0 暴露 webdriver。
      let endpoint;
      if (headless) {
        endpoint = await this._waitForDevTools(resolvedUserDataDir, notBefore, {
          signal,
          previousPortFile,
          readProcessState: (includeDebugPorts) => this._readHeadlessProcessState(runToken, includeDebugPorts, signal),
        });
      } else {
        await this._waitForInteractiveCdp(debugPort);
        endpoint = `http://127.0.0.1:${debugPort}`;
      }
      throwIfCancelled(signal);

      // 3) 先装身份屏障并处理完既有 Target，之后才允许 Playwright attach。
      if (headless && !headlessIdentity) throw new Error("缺少 Headless 浏览器身份信息");
      if (headless || environmentMode === "fixed") {
        barrier = await this._installBarrier({
          endpoint,
          identity: headlessIdentity,
          accountId,
          timezoneId: launchArgs.timezoneId,
          locale: launchArgs.locale,
        });
      }
      throwIfCancelled(signal);

      // 4) 现在才接管。
      const httpEndpoint = headless ? toHttpEndpoint(endpoint) : endpoint;
      // Interactive windows retain Chrome's native focus, media preferences and
      // downloads. Keep Playwright's defaults for background automation only.
      browser = manual && !headless
        ? await this._connectManual(httpEndpoint)
        : await this._connectOverCDP(endpoint, { noDefaults: !headless });
      throwIfCancelled(signal);
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome 没有默认浏览器上下文");

      barrier?.attachContext?.(context);

      const pages = context.pages();
      const page =
        pages.find((candidate) => candidate.url() === "about:blank")
        ?? pages[0]
        ?? (await context.newPage());
      throwIfCancelled(signal);

      // context.close 显式发送 CDP Browser.close，让持久 Profile 先正常落盘；
      // 进程树的有界等待、强制兜底与最终证明仍由 BrowserRun / broker 完成。
      installBrokerContextClose(context, browser, barrier);

      return {
        context,
        page,
        browser,
        rootPid: launched.rootPid,
        rootStartTime: launched.rootStartTime,
        runToken,
        brokerGenerationId: this._broker.generationId,
        endpoint: httpEndpoint,
      };
    } catch (error) {
      barrier?.close?.();
      if (browser) await browser.close().catch(() => {});
      // broker 的 launch 已经成功，Job 与进程树都存在且归这个 token。回收**不在这里**
      // 做：BrowserRun 是唯一所有者，由它的关闭序列 terminate → 等计数归零 → dispose，
      // 未能证明时进 quarantine。这里再自行 dispose+forget 会让随后 BrowserRun 的
      // terminate 拿到 UNKNOWN_TOKEN，把一次成功回收误判成 close_failed 并错误隔离账号。
      throw normalizeChromeLaunchError(error);
    }
  }

  async _readHeadlessProcessState(runToken, includeDebugPorts, signal) {
    const state = await this._broker.enumerate(runToken, { includeDebugPorts });
    for (const port of state.debugPorts ?? []) {
      if (signal?.aborted) break;
      let endpoint;
      try {
        const timeout = AbortSignal.timeout(750);
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) continue;
        endpoint = (await response.json()).webSocketDebuggerUrl;
        const prefix = `ws://127.0.0.1:${port}/devtools/browser/`;
        if (typeof endpoint !== "string" || !endpoint.startsWith(prefix) || endpoint === prefix) continue;
      } catch {
        continue;
      }
      // HTTP 探测前后端口都须属于本次 Chrome。后续使用同一个带浏览器 ID 的 WS 地址。
      const confirmed = await this._broker.enumerate(runToken, { includeDebugPorts: true });
      if (confirmed.ok && confirmed.rootAlive && confirmed.debugPorts?.includes(port)) {
        return { ...confirmed, endpoint };
      }
      return confirmed;
    }
    return state;
  }
}

function toHttpEndpoint(wsEndpoint) {
  // waitForDevToolsEndpoint 返回 ws://127.0.0.1:PORT/devtools/browser/ID
  const url = new URL(wsEndpoint);
  return `http://127.0.0.1:${url.port}`;
}

/**
 * 构造启动参数。唯一初始页固定 about:blank：屏障建立在 DevToolsActivePort 可读
 * 之后，若启动时就导航到业务 URL，首个 document 请求会赶在屏障之前发出。
 */
export function buildLaunchArgs({ userDataDir, launchArgs, headless, debugPort = 0 }) {
  if (!headless && (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65_535)) {
    throw new Error("交互式 Chrome 必须使用有效的非零本地调试端口");
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${headless ? 0 : debugPort}`,
    // 抑制既有 Profile 的会话恢复。禁止写 session.restore_on_startup=1（那是"恢复
    // 上次会话"）；这里走命令行，不改 Preferences。
    "--no-startup-window=false",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
  ];
  if (headless) {
    args.push("--headless=new");
    args.push("--disable-blink-features=AutomationControlled");
  } else {
    args.push("--start-maximized");
  }
  for (const arg of launchArgs.args ?? []) {
    if (
      arg.startsWith("--disk-cache-size=")
      || arg.startsWith("--media-cache-size=")
      || arg === STRICT_RESOLVER_ARGUMENT
      || arg === "--no-proxy-server"
    ) {
      if (!args.includes(arg)) args.push(arg);
    }
  }
  if (launchArgs.userAgent) args.push(`--user-agent=${launchArgs.userAgent}`);
  if (launchArgs.locale) {
    args.push(`--lang=${launchArgs.locale}`, `--accept-lang=${launchArgs.locale}`);
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
  return args.filter((arg) => arg !== "--no-startup-window=false");
}

async function requestGracefulBrowserClose(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    await session.send("Browser.close");
  } catch (error) {
    // Chrome 正常退出时 CDP 连接可能先断开，此时命令会以 Target closed 拒绝。
    if (browser.isConnected()) throw error;
  }
}

function installBrokerContextClose(context, browser, barrier) {
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = Promise.resolve()
        .then(() => requestGracefulBrowserClose(browser))
        .finally(() => barrier?.close?.());
    }
    return closing;
  };
  Object.defineProperty(context, "close", {
    configurable: true,
    value: close,
  });
  return context;
}
