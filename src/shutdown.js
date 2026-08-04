const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Install process signal handlers that always finish by exiting the process.
 *
 * Registering a SIGINT listener disables Node's default Ctrl+C exit behavior,
 * so cleanup alone is not enough: the HTTP listener and timers would otherwise
 * keep the process (and its port) alive indefinitely.
 */
export function installShutdownHandlers({
  shutdown,
  processRef = process,
  logger = console,
  timeoutMs = 10_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let shuttingDown = false;

  const handleSignal = (signal) => {
    const exitCode = SIGNAL_EXIT_CODES[signal] ?? 1;

    // A second Ctrl+C is an explicit request to stop waiting for cleanup.
    if (shuttingDown) {
      processRef.exit(exitCode);
      return;
    }

    shuttingDown = true;
    processRef.exitCode = exitCode;
    logger.info?.(`收到 ${signal}，正在关闭服务…`);

    const watchdog = setTimer(() => {
      logger.warn?.(`服务未能在 ${timeoutMs}ms 内完成关闭，强制退出`);
      processRef.exit(exitCode);
    }, timeoutMs);
    watchdog?.unref?.();

    Promise.resolve()
      .then(() => shutdown(signal))
      .catch((error) => {
        logger.error?.(`关闭服务时出错：${String(error?.stack || error)}`);
      })
      .finally(() => {
        clearTimer(watchdog);
        processRef.exit(exitCode);
      });
  };

  const handlers = new Map(
    Object.keys(SIGNAL_EXIT_CODES).map((signal) => [
      signal,
      () => handleSignal(signal),
    ])
  );
  for (const [signal, handler] of handlers) processRef.on(signal, handler);

  return {
    handleSignal,
    isShuttingDown: () => shuttingDown,
    dispose() {
      for (const [signal, handler] of handlers) {
        processRef.off(signal, handler);
      }
    },
  };
}
