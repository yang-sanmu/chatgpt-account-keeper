/** One ephemeral Chrome session for an external local registration client.
 * stdin/stdout: newline-delimited JSON v1. No account/store/Agent IPC changes.
 * Chrome ownership and termination remain with the existing launcher broker.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const write = (value) => {
  if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify({ protocol: 1, ...value })}\n`);
};
// Imported runtime modules may log. stdout belongs exclusively to the protocol.
console.log = (...values) => console.error(...values);
const log = { info: console.error, warn: console.error, error: console.error, debug() {} };
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
let opening = null;
let closing = null;
let runtimeRoot = null;
let realTempRoot = null;
let broker = null;
let registry = null;
let run = null;
let started = false;
let lastPing = Date.now();
const watchdog = setInterval(() => {
  if (Date.now() - lastPing > 30_000) void close("client-heartbeat-lost");
}, 5_000);
watchdog.unref();

function validate(options) {
  if (options.protocol !== 1 || options.command !== "open") throw new Error("Expected protocol=1, command=open");
  if (options.headless != null && typeof options.headless !== "boolean") throw new Error("Invalid headless option");
  if (options.proxy) {
    const url = new URL(options.proxy);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Only a local HTTP relay at 127.0.0.1 is accepted");
    }
  }
  if (options.locale && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(options.locale)) throw new Error("Invalid locale");
  if (options.timezone) new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format();
}

async function open(options) {
  validate(options);
  if (process.platform !== "win32") throw new Error("This bridge currently requires the Windows Chrome launcher broker");
  realTempRoot = await fs.realpath(os.tmpdir());
  runtimeRoot = await fs.mkdtemp(path.join(realTempRoot, "gptaccount-registration-"));
  // Isolate any runtime initialization and log directories from the user's data.
  for (const name of ["DATA", "CACHE", "STATE"]) process.env[`GPT_ACCOUNT_KEEPER_${name}_ROOT`] = runtimeRoot;
  delete process.env.GPT_ACCOUNT_KEEPER_LOG_FILE;
  const { ChromeLauncherBroker } = await import("../src/chromeLauncherBroker.js");
  const { ChromeProcessLauncher } = await import("../src/chromeProcessLauncher.js");
  const { BrowserRunRegistry } = await import("../src/application/browserRuns.js");
  const { baseLaunchArgs, applyWebrtcProfilePolicy, probeHeadlessIdentity } = await import("../src/browser.js");
  controller.signal.throwIfAborted();
  broker = new ChromeLauncherBroker({ log, onFatal: () => { void close("broker-exited"); } });
  await broker.start();
  controller.signal.throwIfAborted();
  registry = new BrowserRunRegistry({ broker, log });
  const launcher = new ChromeProcessLauncher({ broker, log });
  const profilePath = path.join(runtimeRoot, "profile");
  const headless = options.headless === true;
  const args = baseLaunchArgs(headless);
  args.locale = options.locale || "en-US";
  if (options.timezone) args.timezoneId = options.timezone;
  if (options.proxy) args.proxy = { server: options.proxy };
  else args.args.push("--no-proxy-server");
  applyWebrtcProfilePolicy(profilePath);
  const identity = headless ? await probeHeadlessIdentity("chrome") : null;
  if (identity) args.userAgent = identity.userAgent;
  controller.signal.throwIfAborted();
  const token = launcher.newRunToken();
  run = registry.register({ accountId: `registration-${process.pid}`, purpose: "registration", profilePath, headless });
  registry.attachLaunch(run.browserRunId, { launcherRunToken: token });
  let launched;
  try {
    launched = await launcher.launch({ userDataDir: profilePath, launchArgs: args, headless,
      accountId: run.accountId, headlessIdentity: identity, manual: !headless,
      environmentMode: "fixed", runToken: token, signal: controller.signal });
  } catch (error) {
    // Chrome discovery fails before the broker receives a launch request.
    if (error.ownershipCertain === true || error.code === "CHROME_NOT_FOUND") registry.forgetLauncherToken(run.browserRunId);
    throw error;
  }
  registry.attachLaunch(run.browserRunId, { rootPid: launched.rootPid, rootStartTime: launched.rootStartTime,
    launcherRunToken: token, brokerGenerationId: broker.generationId, state: "running" });
  registry.markRunning(run.browserRunId, launched.context);
  controller.signal.throwIfAborted();
  launched.context.once("close", () => { void close("browser-closed"); });
  write({ event: "ready", endpoint: launched.endpoint, runtime_dir: runtimeRoot, pid: launched.rootPid });
}

async function removeOwnedDirectory() {
  if (!runtimeRoot) return;
  const target = path.resolve(runtimeRoot);
  if (path.dirname(target) !== realTempRoot || !path.basename(target).startsWith("gptaccount-registration-")) {
    throw new Error("Refusing cleanup outside the owned temporary directory");
  }
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) {
    throw new Error("Refusing cleanup of a redirected temporary directory");
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function close(reason) {
  if (closing) return closing;
  controller.abort(new Error(reason));
  closing = (async () => {
    await opening?.catch(() => {});
    let cleaned = false;
    let detail = null;
    try {
      if (run) {
        const outcome = await registry.close(run.browserRunId, reason);
        if (outcome?.state !== "closed") throw new Error("Chrome process tree cleanup was not confirmed");
      }
      await broker?.dispose();
      await removeOwnedDirectory();
      cleaned = true;
    } catch (error) {
      detail = error.message;
      // Never delete a directory whose browser ownership is still uncertain.
      await broker?.dispose().catch(() => {});
      process.exitCode = 1;
    } finally {
      registry?.cancelAllRechecks();
      clearInterval(watchdog);
      write({ event: "closed", cleaned, reason, error: detail, runtime_dir: runtimeRoot });
      input.close();
      process.stdin.destroy();
    }
  })();
  return closing;
}

input.on("line", (line) => {
  if (closing) return;
  lastPing = Date.now();
  try {
    if (line.length > 16_384) throw new Error("Request is too large");
    const message = JSON.parse(line);
    if (message.command === "ping") return;
    if (message.command === "close") { void close("client-close"); return; }
    if (started) throw new Error("Only one session is allowed per bridge process");
    started = true;
    opening = open(message);
    // Startup timeout is owned by the Python client (GPTACCOUNT_START_TIMEOUT).
    opening.catch((error) => {
      process.exitCode = 1;
      write({ event: "error", message: error.message });
      void close("launch-failed");
    });
  } catch (error) {
    process.exitCode = 1;
    write({ event: "error", message: error.message });
    void close("invalid-request");
  }
});
input.on("close", () => { void close("client-disconnected"); });
process.stdout.on("error", () => { void close("output-disconnected"); });
process.on("SIGTERM", () => { void close("terminated"); });
process.on("SIGINT", () => { void close("interrupted"); });
