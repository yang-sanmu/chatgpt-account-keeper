import path from "node:path";
import { chromium } from "playwright-core";
import {
  ChromeNotFoundError,
  findChromeExecutable,
  installIdentityBarrierOnEndpoint,
  normalizeChromeLaunchError,
  reserveLocalDebugPort,
  waitForDevToolsEndpoint,
  waitForInteractiveCdp,
} from "./browser.js";
import * as defaultLog from "./logger.js";

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
    this._connectOverCDP = options.connectOverCDP ?? ((endpoint) => chromium.connectOverCDP(endpoint));
    this._waitForDevTools = options.waitForDevToolsEndpoint ?? waitForDevToolsEndpoint;
    this._reserveDebugPort = options.reserveLocalDebugPort ?? reserveLocalDebugPort;
    this._waitForInteractiveCdp =
      options.waitForInteractiveCdp ?? waitForInteractiveCdp;
    this._findChrome = options.findChromeExecutable ?? findChromeExecutable;
    this._installBarrier = options.installIdentityBarrier ?? installIdentityBarrierOnEndpoint;
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
    runToken,
    signal = null,
  }) {
    if (!this._broker?.running) {
      const error = new Error("chrome-launcher 不可用，无法启动 Chrome");
      error.code = "CHROME_BROKER_UNAVAILABLE";
      throw error;
    }
    const executable = this._findChrome();
    if (!executable) throw new ChromeNotFoundError(new Error("Google Chrome executable not found"));

    const resolvedUserDataDir = path.resolve(userDataDir);
    // Chrome 会把 --remote-debugging-port=0 视为自动化信号并暴露
    // navigator.webdriver=true。交互窗口必须恢复旧路径的随机非零端口；Headless
    // 仍用 0，让 Chrome 通过 DevToolsActivePort 回报实际端口。
    const debugPort = headless ? 0 : await this._reserveDebugPort();
    const args = buildLaunchArgs({
      userDataDir: resolvedUserDataDir,
      launchArgs,
      headless,
      debugPort,
    });
    const notBefore = Date.now();

    const launched = await this._broker.launch(runToken, executable, args);

    let browser = null;
    let barrier = null;
    try {
      // 2) Headless 从 DevToolsActivePort 读取 Chrome 分配的端口；交互窗口则等待
      //    预先分配的非零端口就绪，避免 port=0 暴露 webdriver。
      let endpoint;
      if (headless) {
        endpoint = await this._waitForDevTools(resolvedUserDataDir, notBefore);
      } else {
        await this._waitForInteractiveCdp(debugPort);
        endpoint = `http://127.0.0.1:${debugPort}`;
      }

      // 3) 先装身份屏障并处理完既有 Target，之后才允许 Playwright attach。
      if (headless) {
        if (!headlessIdentity) throw new Error("缺少 Headless 浏览器身份信息");
        barrier = await this._installBarrier({
          endpoint,
          identity: headlessIdentity,
          accountId,
        });
      }

      // 4) 现在才接管。
      const httpEndpoint = headless ? toHttpEndpoint(endpoint) : endpoint;
      browser = await this._connectOverCDP(httpEndpoint);
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome 没有默认浏览器上下文");

      barrier?.attachContext?.(context);

      const pages = context.pages();
      const page =
        pages.find((candidate) => candidate.url() === "about:blank")
        ?? pages[0]
        ?? (await context.newPage());

      // context.close 收口到 browser.close：CDP 接入的默认持久 Context 不由
      // Playwright 负责进程生命周期，进程回收由 broker 的 Job 完成。
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

function installBrokerContextClose(context, browser, barrier) {
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = Promise.resolve()
        .then(() => browser.close())
        .catch(() => {})
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
