import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fromInstallRoot } from "./paths.js";
import * as log from "./logger.js";

/**
 * Node 侧的 chrome-launcher broker 客户端。
 *
 * 为什么是一个 Agent 级 broker 而不是每个 BrowserRun 一个 helper：broker 独占全部
 * per-run Job 句柄，这正是 KILL_ON_JOB_CLOSE 能作为可靠兜底的前提。每 run 一个
 * helper 会按 run 泄漏进程，而且 helper 崩溃后那个 Job 再也无法查询。
 *
 * Agent 绝不持有 per-run Job 句柄的任何副本：一旦存在副本，broker 崩溃时句柄计数
 * 不会归零，KILL_ON_JOB_CLOSE 不触发，Chrome 会残留。
 */

export const BROKER_PROTOCOL_VERSION = 1;

const DEFINITE_NO_LAUNCH_CODES = new Set([
  "INVALID_REQUEST",
  "TOKEN_IN_USE",
  "TOKEN_RETIRED",
  "CAPACITY_EXHAUSTED",
  "LAUNCH_FAILED",
]);

export class ChromeBrokerUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ChromeBrokerUnavailableError";
    this.code = "CHROME_BROKER_UNAVAILABLE";
    this.retryable = false;
  }
}

/**
 * Windows 命令行转义（CommandLineToArgvW 规则）。
 *
 * Profile 路径常含空格，朴素拼接会把一个参数悄悄拆成两个；结尾反斜杠若不加倍，
 * 会把随后的结束引号转义掉。
 */
export function buildWindowsCommandLine(executable, args = []) {
  const quote = (value) => {
    const text = String(value);
    if (text.length > 0 && !/[ \t"\n\v]/.test(text)) return text;
    let out = '"';
    for (let i = 0; i < text.length; i++) {
      let backslashes = 0;
      while (i < text.length && text[i] === "\\") {
        backslashes++;
        i++;
      }
      if (i === text.length) {
        out += "\\".repeat(backslashes * 2);
        break;
      }
      if (text[i] === '"') {
        out += "\\".repeat(backslashes * 2 + 1);
      } else {
        out += "\\".repeat(backslashes);
      }
      out += text[i];
    }
    return out + '"';
  };
  return [quote(executable), ...args.map(quote)].join(" ");
}

export function brokerExecutableName() {
  return process.platform === "win32" ? "chrome-launcher.exe" : "chrome-launcher";
}

/**
 * 已安装布局把 broker 放在 agent/bin，与 mihomo 同层；开发树则用 dotnet publish 的
 * 输出目录，避免每次改动都要重新 stage 一份。
 */
export function brokerExecutableCandidates() {
  const name = brokerExecutableName();
  // 显式覆盖优先，且**只**用它：测试与开发需要能指向一个不存在的路径来验证
  // fail-closed，若继续回退到其它候选就测不出安装损坏的行为。
  const override = process.env.GPT_ACCOUNT_KEEPER_CHROME_LAUNCHER;
  if (override && override.trim()) return [path.resolve(override.trim())];
  // 全部锚定在 fromInstallRoot（由本模块自身位置推导），不用 process.cwd()：Agent
  // 会被 Desktop 以任意工作目录启动，用 cwd 解析会让源码树运行时找不到 broker 并
  // 触发 fail-closed（Desktop 可用性测试就是这样被判"Agent 在建立 IPC 前退出"）。
  const devOutputs = ["x64/Release", "Release"].map((flavor) =>
    fromInstallRoot("tools", "chrome-launcher", "bin", ...flavor.split("/"), "net10.0", "win-x64", "publish", name)
  );
  return [
    // 已安装布局：agent/bin，与 mihomo 同层。
    fromInstallRoot("bin", name),
    fromInstallRoot("..", "bin", name),
    ...devOutputs,
  ];
}

export function resolveBrokerExecutable(candidates = brokerExecutableCandidates(), exists = fs.existsSync) {
  return candidates.find((candidate) => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  }) ?? null;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class ChromeLauncherBroker {
  constructor(options = {}) {
    this._executable = options.executable ?? null;
    this._spawn = options.spawn ?? spawn;
    this._log = options.log ?? log;
    this._readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this._requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this._onFatal = options.onFatal ?? null;
    this._child = null;
    this._pending = new Map();
    this._buffer = "";
    this._nextId = 0;
    this._helloResolve = null;
    this._shuttingDown = false;
    this._fatalReported = false;
    this.generationId = null;
    this.ready = null;
  }

  get running() {
    return !!this._child && this._child.exitCode == null && !this._child.killed;
  }

  async start() {
    if (this._child) return this.ready;
    const executable = this._executable ?? resolveBrokerExecutable();
    if (!executable) {
      throw new ChromeBrokerUnavailableError(
        "找不到随应用安装的 chrome-launcher。安装可能已损坏，请重新安装应用。"
      );
    }
    this._executable = executable;

    let child;
    try {
      child = this._spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new ChromeBrokerUnavailableError(
        `无法启动 chrome-launcher：${String(error?.message || error)}`,
        error
      );
    }
    this._child = child;

    const spawnFailure = new Promise((_, reject) => {
      child.once("error", (error) => {
        reject(
          new ChromeBrokerUnavailableError(
            `无法启动 chrome-launcher：${String(error?.message || error)}`,
            error
          )
        );
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this._onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this._log.warn(`chrome-launcher: ${text}`);
    });
    child.once("exit", (code, signal) => this._onExit(code, signal));

    const hello = new Promise((resolve) => {
      this._helloResolve = resolve;
    });

    let helloEnvelope;
    try {
      helloEnvelope = await this._withTimeout(
        Promise.race([hello, spawnFailure]),
        this._readyTimeoutMs,
        "等待 chrome-launcher 握手超时"
      );
    } catch (error) {
      await this.dispose();
      throw error instanceof ChromeBrokerUnavailableError
        ? error
        : new ChromeBrokerUnavailableError(String(error?.message || error), error);
    }
    this.generationId = helloEnvelope.brokerGenerationId ?? null;
    if (!this.generationId) {
      await this.dispose();
      throw new ChromeBrokerUnavailableError("chrome-launcher 未报告 brokerGenerationId");
    }

    let ready;
    try {
      ready = await this.sendRaw({
        requestId: this._newRequestId(),
        command: "ready",
        brokerGenerationId: this.generationId,
        protocolVersion: BROKER_PROTOCOL_VERSION,
        rid: process.platform === "win32" ? (process.arch === "x64" ? "win-x64" : "win-x86") : process.platform,
      });
    } catch (error) {
      await this.dispose();
      throw new ChromeBrokerUnavailableError(
        `chrome-launcher 握手失败：${String(error?.message || error)}`,
        error
      );
    }
    if (!ready.ok) {
      await this.dispose();
      throw new ChromeBrokerUnavailableError(
        `chrome-launcher 握手被拒绝：${ready.message ?? ready.code ?? "未知原因"}`
      );
    }
    if (ready.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      await this.dispose();
      throw new ChromeBrokerUnavailableError(
        `chrome-launcher 协议版本不兼容：broker ${ready.protocolVersion}，Agent ${BROKER_PROTOCOL_VERSION}`
      );
    }
    // 独立运行（不经 Desktop）时没有 Agent 级 outer Job，缺少进程树最终兜底。
    // 这不阻止启动：开发 / CLI 场景仍然可用，但必须让用户知道保证更弱。
    if (ready.parentInJob === false) {
      this._log.warn(
        "Agent 未由桌面程序托管，缺少进程树兜底；Agent 被强杀时依赖 broker 感知管道关闭来回收 Chrome"
      );
    }
    this.ready = ready;
    return ready;
  }

  _newRequestId() {
    return `req-${++this._nextId}`;
  }

  newRunToken() {
    return `run-${randomUUID()}`;
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (!line) continue;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        this._log.warn(`chrome-launcher 输出无法解析：${line.slice(0, 200)}`);
        continue;
      }
      if (envelope.command === "hello" && this._helloResolve) {
        const resolve = this._helloResolve;
        this._helloResolve = null;
        resolve(envelope);
        continue;
      }
      const pending = envelope.requestId ? this._pending.get(envelope.requestId) : null;
      if (!pending) continue;
      clearTimeout(pending.timer);
      this._pending.delete(envelope.requestId);
      pending.resolve(envelope);
    }
  }

  /**
   * broker 意外退出是 Agent 级 fatal。它独占全部 per-run Job 句柄，退出已经让所有
   * Job 到达 last-handle 并由 KILL_ON_JOB_CLOSE 回收全部活动 Chrome；继续运行只会
   * 让 Agent 状态与现实脱节。不得乐观把任何 run 判为 closed，也不在进程内重启。
   */
  _onExit(code, signal) {
    const error = new Error(
      `chrome-launcher 已退出（code=${code}, signal=${signal ?? "none"}）`
    );
    error.code = "CHROME_BROKER_EXITED";
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "CHROME_BROKER_EXITED", message: error.message });
    }
    this._pending.clear();
    if (this._helloResolve) {
      const resolve = this._helloResolve;
      this._helloResolve = null;
      resolve({ ok: false, code: "CHROME_BROKER_EXITED", message: error.message });
    }
    if (this._shuttingDown || this._fatalReported) return;
    this._fatalReported = true;
    try {
      this._log.error(
        `chrome-launcher 意外退出（code=${code}, signal=${signal ?? "none"}），全部活动 Chrome 已由 Job 回收；Agent 将 fail-fast 退出`
      );
    } catch {
      // 日志失败不能阻止 fatal 传播
    }
    try {
      this._onFatal?.(error);
    } catch (fatalError) {
      try {
        this._log.error(`broker fatal 处理失败：${String(fatalError?.message || fatalError)}`);
      } catch {
        // ignore
      }
    }
  }

  _withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  sendRaw(request) {
    if (!this._child || this._child.exitCode != null) {
      return Promise.resolve({
        ok: false,
        code: "CHROME_BROKER_EXITED",
        message: "chrome-launcher 不在运行",
      });
    }
    const requestId = request.requestId ?? this._newRequestId();
    const payload = { ...request, requestId };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        resolve({
          ok: false,
          code: "CHROME_BROKER_TIMEOUT",
          message: `chrome-launcher 命令超时：${payload.command}`,
        });
      }, this._requestTimeoutMs);
      timer.unref?.();
      this._pending.set(requestId, { resolve, timer });
      try {
        this._child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        resolve({
          ok: false,
          code: "CHROME_BROKER_WRITE_FAILED",
          message: String(error?.message || error),
        });
      }
    });
  }

  _send(command, extra = {}) {
    return this.sendRaw({
      requestId: this._newRequestId(),
      command,
      brokerGenerationId: this.generationId,
      ...extra,
    });
  }

  async launch(runToken, executable, args, workingDirectory = null) {
    const response = await this._send("launch", {
      runToken,
      executable,
      args,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    if (!response.ok) {
      const error = new Error(
        `chrome-launcher 启动 Chrome 失败：${response.message ?? response.code ?? "未知原因"}`
      );
      error.code = response.code ?? "CHROME_LAUNCH_FAILED";
      // 所有权是否已经产生，取决于失败是"明确未创建"还是"结果不确定"。
      // 前四项在创建 Job 之前拒绝；LAUNCH_FAILED 在返回前已 Dispose Job。
      // 超时 / 写失败 / broker 退出仍属结果不确定，必须保留 token 走 BrowserRun 证明。
      error.ownershipCertain = DEFINITE_NO_LAUNCH_CODES.has(response.code);
      throw error;
    }
    return { rootPid: response.rootPid, rootStartTime: response.rootStartTime };
  }

  /**
   * 逐个 pid 核对 Job 归属。禁止用「进程遍历结果 vs Job pid 列表」的集合比较作判据：
   * 两次快照取自不同瞬间，期间退出的短命 utility 进程会伪造出「逃逸」。
   * 返回确实不在该 Job 内的 pid（已退出的 pid 不算逃逸）。
   */
  async inspect(runToken, pids) {
    const response = await this._send("inspect", {
      runToken,
      args: pids.map((pid) => String(pid)),
    });
    return {
      ok: response.ok === true,
      code: response.code ?? null,
      outside: response.pids ?? [],
      disposed: response.disposed === true,
    };
  }

  async enumerate(runToken) {
    const response = await this._send("enumerate", { runToken });
    return {
      ok: response.ok === true,
      code: response.code ?? null,
      count: response.count ?? null,
      pids: response.pids ?? [],
      disposed: response.disposed === true,
      rootAlive: response.rootAlive === true,
    };
  }

  terminate(runToken) {
    return this._send("terminate", { runToken });
  }

  /** dispose 用后缀避免与实例清理方法 dispose() 混淆。 */
  dispose_(runToken) {
    return this._send("dispose", { runToken });
  }

  forget(runToken) {
    return this._send("forget", { runToken });
  }

  /**
   * 轮询直到 Job 内进程计数归零。root 消失本身不能替代这个确认：孤立的
   * renderer / GPU 进程仍可能存活，此时释放槽位就会让实际 Chrome 超上限。
   */
  async waitForEmpty(runToken, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = { ok: false, count: null, disposed: false };
    for (;;) {
      last = await this.enumerate(runToken);
      if (last.disposed) return { ...last, count: 0 };
      if (last.ok && last.count === 0) return last;
      if (Date.now() >= deadline) return last;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
    }
  }

  async requestShutdown() {
    this._shuttingDown = true;
    return this._send("shutdown", {});
  }

  /** 仅供测试：模拟 broker 崩溃。 */
  killForTest() {
    this._child?.kill();
  }

  async dispose() {
    this._shuttingDown = true;
    const child = this._child;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // 管道可能已关闭
    }
    if (child.exitCode == null && !child.killed) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 进程可能刚好退出
          }
          resolve();
        }, 2_000);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this._child = null;
  }
}
