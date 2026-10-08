import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./processExitObserver.ps1", import.meta.url));
async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Process observer timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Test-only independent observer. Opening the original process handles before a
// crash avoids both PID reuse and treating a retained, terminated process as live.
export async function openWindowsProcessObserver(pids) {
  if (process.platform !== "win32" || !Array.isArray(pids) || !pids.length || pids.length > 32
    || new Set(pids).size !== pids.length || pids.some(pid => !Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff)) {
    throw new Error("Invalid process observer arguments");
  }
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-ProcessIds", pids.join(",")],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.on("error", () => {}); child.stderr.resume();
  let ended = false; let closed = false; let busy = false;
  const done = new Promise(resolve => {
    child.once("error", () => { ended = true; resolve({ error: true }); });
    child.once("close", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  async function read(kind) {
    const result = await bounded(Promise.race([lines.next(), done.then(() => ({ done: true }))]), 15_000);
    if (result.done) throw new Error("Process observer exited without a response");
    const message = JSON.parse(result.value);
    if (message.kind !== kind || !Array.isArray(message.processes) || message.processes.length !== pids.length
      || message.processes.some((item, index) => item.pid !== pids[index] || !/^[0-9]+$/u.test(item.creationFileTime)
        || !["running", "exited"].includes(item.state)
        || (item.state === "running" ? item.exitCode !== null : !Number.isInteger(item.exitCode)))) {
      throw new Error("Process observation failed or returned an invalid response");
    }
    return message.processes;
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (!ended) child.stdin.end("close\n");
    try { await bounded(done, 5000); }
    catch { child.kill(); await bounded(done, 5000); }
  }
  try {
    const initial = await read("ready");
    return { initial,
      async snapshot() {
        if (closed || ended || busy) throw new Error("Process observer unavailable");
        busy = true;
        try { child.stdin.write("snapshot\n"); return await read("snapshot"); }
        finally { busy = false; }
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
