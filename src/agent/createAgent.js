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
  const server = createAgentIpcServer({
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
    async stop(context) {
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          await options.beforeStop?.({ agent, dataRoot: agent.dataRoot, endpoint });
          if (started) await server.close();
          started = false;
          // 先摘掉运行时事件订阅，再走 lifecycle.shutdown；否则关闭过程中
          // 的调度/窗口变化还会往已经关掉的 IPC 广播。
          services.dispose?.();
          await suppliedLifecycle.shutdown?.(context);
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
