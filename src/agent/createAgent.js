import { createApplicationServices } from "../application/services.js";
import { createAgentIpcServer } from "./ipcServer.js";
import { currentUserEndpoint } from "./endpoint.js";

/**
 * Composes an Agent without choosing a persistence backend. A packaged build can
 * inject SQLite-backed store/history/status/proxy adapters while the legacy entry
 * point keeps using the current JSON modules.
 */
export function createAgent(options = {}) {
  const endpoint = options.endpoint ?? currentUserEndpoint({ dataRoot: options.dataRoot });
  let started = false;
  let stopping = null;
  let agent;

  const suppliedRuntime = options.runtime ?? {};
  const suppliedLifecycle = suppliedRuntime.lifecycle ?? {};
  const runtime = {
    ...suppliedRuntime,
    dataRoot: options.dataRoot ?? suppliedRuntime.dataRoot ?? null,
    lifecycle: {
      ...suppliedLifecycle,
      shutdown: async (context) => agent.stop(context),
    },
  };
  const services = createApplicationServices({
    runtime,
    receiptStore: options.receiptStore,
    events: options.events,
    operations: options.operations,
    // 有持久化后端时，任务历史与错误详情跨 Agent 重启存活。
    operationStore: options.operationStore,
    protocol: options.protocol,
  });
  // server 可注入：关闭顺序（stopAccepting 早于 lifecycle、destroy 晚于它）需要能在
  // 不起真实 IPC 的情况下断言，否则这条接线只有集成测试能覆盖。
  const server = options.server ?? createAgentIpcServer({
    services,
    endpoint,
    logger: options.logger,
    maxFrameBytes: options.maxFrameBytes,
  });

  agent = {
    endpoint,
    dataRoot: options.dataRoot ?? null,
    runtime: services.runtime,
    services,
    server,
    get started() {
      return started;
    },
    async start() {
      if (started) return { endpoint, dataRoot: agent.dataRoot };
      await options.beforeStart?.({
        agent,
        dataRoot: agent.dataRoot,
        endpoint,
        runtime: services.runtime,
      });
      await server.listen();
      started = true;
      try {
        await options.afterStart?.({ agent, dataRoot: agent.dataRoot, endpoint });
      } catch (error) {
        await server.close().catch(() => {});
        started = false;
        throw error;
      }
      return { endpoint, dataRoot: agent.dataRoot };
    },
    /**
     * 关闭链分两段（计划 §12.1 / §12.2）：
     *
     *   beforeStop → server.stopAccepting() → lifecycle.shutdown（真正的 16 步）
     *   → services.dispose() → server.destroy() → afterStop
     *
     * 旧实现在这里先 `await server.close()`，那会在保留客户端连接的阶段自锁，
     * 导致 lifecycle.shutdown 根本进不去；即使不自锁，它也会在任何 Chrome 关闭之前
     * 就销毁全部客户端，Desktop 收不到关闭期间的事件——正是要修掉的行为。
     *
     * dispose/destroy 必须晚于第 10 步的最终事件推送，且在失败路径上也要执行，
     * 否则修一个自锁又引入一个泄漏。
     */
    async stop(context) {
      if (stopping) return stopping;
      stopping = (async () => {
        let shutdownError = null;
        try {
          await options.beforeStop?.({ agent, dataRoot: agent.dataRoot, endpoint });
          // 停止接受新连接，但保留已建连接用于推送最终事件。
          if (started) await server.stopAccepting();
          try {
            await suppliedLifecycle.shutdown?.(context);
          } catch (error) {
            shutdownError = error;
          }
          // finally 语义：无论 lifecycle 是否失败，这三件事都必须做。
          try {
            services.dispose?.();
          } catch (error) {
            shutdownError ??= error;
          }
          try {
            if (started) await server.destroy();
          } catch (error) {
            shutdownError ??= error;
          }
          started = false;
          if (shutdownError) throw shutdownError;
          // afterStop 保持原兼容语义：只在前面全部成功后调用。
          await options.afterStop?.({ agent, dataRoot: agent.dataRoot, endpoint });
        } finally {
          stopping = null;
        }
      })();
      return stopping;
    },
  };
  return agent;
}
