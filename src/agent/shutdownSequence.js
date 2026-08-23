/**
 * Agent 退出流程（计划 §12.2）。
 *
 * 两条硬约束贯穿全程：
 *  - 第 8 / 9 步未收敛时**不得** seal、不得 checkpoint/close：活 handler 在数据库
 *    关闭后写入，比不 checkpoint 更坏。
 *  - broker 只有在 active registry 为空时才允许 shutdown；靠退出 broker 让
 *    KILL_ON_JOB_CLOSE 回收 Chrome，绝不能冒充单 run 的正常回收。
 */

export const OVERALL_TIMEOUT_MS = 20_000;
export const STEP_TIMEOUT_MS = 5_000;

export class ShutdownAbort extends Error {
  constructor(step, detail) {
    super(`关闭流程在第 ${step} 步未收敛：${detail}`);
    this.name = "ShutdownAbort";
    this.step = step;
    this.detail = detail;
  }
}

async function withStepTimeout(step, label, action, timeoutMs, log) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(action)
        .then((value) => ({ value }), (error) => ({ error })),
      timeout,
    ]);
    if (result?.timedOut) {
      log.warn?.(`关闭第 ${step} 步「${label}」超过 ${timeoutMs}ms，继续后续步骤`);
      return { timedOut: true };
    }
    if (result?.error) {
      log.warn?.(`关闭第 ${step} 步「${label}」失败：${String(result.error?.message || result.error)}`);
      return { error: result.error };
    }
    return { value: result.value };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行 16 步关闭。deps 由组合根提供；缺失的步骤自动跳过，便于旧入口与测试复用。
 */
export async function runShutdownSequence(deps) {
  const log = deps.log ?? console;
  const stepTimeoutMs = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const overallMs = deps.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  const started = deps.now ? deps.now() : Date.now();
  const completed = [];
  let currentStep = 0;

  const overall = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new ShutdownAbort(currentStep, `整体关闭超过 ${overallMs}ms`));
    }, overallMs);
    timer.unref?.();
  });

  const sequence = async () => {
    const step = async (index, label, action) => {
      currentStep = index;
      const result = await withStepTimeout(index, label, action, stepTimeoutMs, log);
      completed.push({ step: index, label, ...result });
      return result;
    };

    await step(1, "置 draining", () => deps.beginDraining?.());
    await step(2, "停止接受新连接", () => deps.stopAccepting?.());
    await step(3, "停定时器与队列准入", () => deps.stopTimers?.());
    await step(4, "取消排队条目", () => deps.cancelQueued?.());
    await step(5, "向活动条目发取消信号", () => deps.signalActive?.());
    await step(6, "关闭登录窗口与长期页面", () => deps.closeInteractive?.());
    await step(7, "关闭全部活动 BrowserRun", () => deps.closeBrowserRuns?.());
    const converged = await step(8, "等待 handler 与维护 Worker 收敛", () => deps.awaitConvergence?.());
    const brokerStopped = await step(9, "broker shutdown", () => deps.shutdownBroker?.());

    // 第 8 / 9 步未收敛：不得 seal、不得关库，直接交给 watchdog。
    const unresolved = deps.unresolved?.() ?? [];
    if (unresolved.length > 0) {
      throw new ShutdownAbort(
        9,
        `仍有未归零对象：${unresolved.map((item) => JSON.stringify(item)).join(", ")}`
      );
    }
    if (converged?.timedOut) throw new ShutdownAbort(8, "handler 或维护 Worker 未在限定时间内归零");
    if (brokerStopped?.error || brokerStopped?.timedOut) {
      throw new ShutdownAbort(9, "broker 未能正常 shutdown");
    }

    await step(10, "flush 终态并推送最终事件", () => deps.flushOperations?.());
    await step(11, "seal 写入口", () => deps.sealOperations?.());
    await step(12, "停止代理内核", () => deps.stopProxies?.());
    await step(13, "checkpoint 并关闭数据库", () => deps.closeRepository?.());
    await step(14, "释放运行后端", () => deps.releaseBackends?.());
    await step(15, "销毁 IPC 客户端", () => deps.destroyServer?.());
    await step(16, "释放单实例锁", () => deps.releaseInstanceLock?.());
    return { ok: true, steps: completed, elapsedMs: (deps.now ? deps.now() : Date.now()) - started };
  };

  try {
    return await Promise.race([sequence(), overall]);
  } catch (error) {
    if (error instanceof ShutdownAbort) {
      log.error?.(
        `${error.message}；不进行 seal 与数据库关闭，交由 watchdog 退出（已完成步骤：${completed
          .map((entry) => entry.step)
          .join(",")}）`
      );
      return { ok: false, fatal: true, step: error.step, detail: error.detail, steps: completed };
    }
    log.error?.(`关闭流程异常：${String(error?.stack || error)}`);
    return { ok: false, fatal: true, step: currentStep, detail: String(error?.message || error), steps: completed };
  }
}
