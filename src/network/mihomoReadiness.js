import http from "node:http";
import YAML from "yaml";

function applyConfig(port, payload, timeoutMs) {
  return new Promise((resolve) => {
    // Reapply the exact generated config. Mihomo serializes ApplyConfig and only
    // responds after switching its tunnel to Running. A TCP listener alone can
    // accept requests while that tunnel is still suspended. No website is probed.
    const body = JSON.stringify({ payload });
    const request = http.request({ host: "127.0.0.1", port, path: "/configs", method: "PUT", agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
      response.on("error", () => resolve(null));
    });
    const timer = setTimeout(() => request.destroy(), timeoutMs);
    request.on("close", () => clearTimeout(timer));
    request.on("error", () => resolve(null));
    request.end(body);
  });
}

export async function waitMihomoConfigApplied(port, config, { timeoutMs = 20000, shouldStop = () => false } = {}) {
  const payload = YAML.stringify(config);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) return { ok: false, stopped: true };
    const status = await applyConfig(port, payload, Math.min(2000, deadline - Date.now()));
    if (shouldStop()) return { ok: false, stopped: true };
    if (status === 204) return { ok: true };
    if (status != null && status !== 503) return { ok: false, status };
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  return { ok: false, timedOut: true };
}
