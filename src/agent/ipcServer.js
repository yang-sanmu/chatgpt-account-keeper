import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { errorEnvelope, ERROR_CODES, ApplicationError } from "../application/errors.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FrameDecoder,
  decodeJsonFrame,
  encodeFrame,
} from "./framing.js";
import { currentUserEndpoint } from "./endpoint.js";
import { assertMethodResultContract, assertOutgoingContract, assertRequestContract } from "./contractValidator.js";

function validateRequest(request) {
  assertRequestContract(request);
  if (typeof request.id !== "string" || !request.id || request.id.length > 128) {
    throw new ApplicationError(ERROR_CODES.VALIDATION_FAILED, "请求 id 必须是 1 到 128 个字符的字符串");
  }
  if (typeof request.method !== "string" || !request.method) {
    throw new ApplicationError(ERROR_CODES.VALIDATION_FAILED, "请求 method 不能为空");
  }
  if (
    request.params !== undefined &&
    (request.params === null || typeof request.params !== "object" || Array.isArray(request.params))
  ) {
    throw new ApplicationError(ERROR_CODES.VALIDATION_FAILED, "请求 params 必须是对象");
  }
}

function writeEnvelope(socket, envelope, maxFrameBytes) {
  if (socket.destroyed || !socket.writable) return false;
  try {
    // Validate the exact JSON representation that will cross the process
    // boundary. JSON.stringify intentionally removes optional undefined fields.
    const jsonEnvelope = JSON.parse(JSON.stringify(envelope));
    assertOutgoingContract(jsonEnvelope);
    return socket.write(encodeFrame(jsonEnvelope, { maxFrameBytes }));
  } catch {
    socket.destroy();
    return false;
  }
}

export class AgentIpcServer {
  constructor(options = {}) {
    if (!options.services) throw new TypeError("services is required");
    this.services = options.services;
    this.endpoint = options.endpoint ?? currentUserEndpoint();
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.logger = options.logger ?? console;
    this.server = null;
    this.clients = new Set();
    this._unsubscribe = null;
    this._listening = false;
    // draining 期间只放行只读诊断：活动、Operation、队列与 BrowserRun 查询。
    this._rejectBusiness = false;
    this._serverClosePromise = null;
  }

  static DRAIN_ALLOWED_METHODS = new Set([
    "system.hello",
    "system.getActivity",
    "operations.get",
    "operations.list",
    "operations.listActive",
    "queue.getSnapshot",
    "browserRuns.list",
  ]);

  async listen() {
    if (this._listening) return { endpoint: this.endpoint };
    // 重新 listen 必须完整复位关闭状态，否则复用同一实例时会残留上一轮的
    // _serverClosePromise / _rejectBusiness。
    this._serverClosePromise = null;
    this._rejectBusiness = false;
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.endpoint), { recursive: true, mode: 0o700 });
    }
    this.server = net.createServer((socket) => this._accept(socket));
    await listenWithStaleSocketRecovery(this.server, this.endpoint);
    this._listening = true;
    if (process.platform !== "win32") fs.chmodSync(this.endpoint, 0o600);
    this._unsubscribe = this.services.events.subscribe((event) => this._broadcastEvent(event));
    return { endpoint: this.endpoint };
  }

  /**
   * 停止接受新连接，但**不动已建立的连接**，并保留事件订阅——关闭期间的最终事件
   * 仍要推给 Desktop。
   *
   * 旧实现在任何 Chrome 关闭之前就 destroy 了全部客户端，Desktop 从来收不到关闭期间
   * 的事件；它的「等待断连」之所以看起来成功，只是因为 socket 被立刻销毁了。
   */
  async stopAccepting() {
    this._rejectBusiness = true;
    if (this.server && !this._serverClosePromise) {
      // net.Server.close(cb) 的回调语义是「监听已关闭 **且** 所有连接已结束」。这个
      // 阶段按设计要保留已建连接来推送最终事件，所以绝不能 await 那个回调——那会
      // 自锁，导致 16 步关闭序列根本进不去。
      //
      // 因此：立刻发起 close 并把完成状态记在 _serverClosePromise 上（不 await），
      // 同步把监听状态置为 false；真正的「已释放」由 destroy() 等待同一个 promise。
      // server 不在这里置 null，否则 destroy 无法判断是否还需要收尾。
      this._serverClosePromise = new Promise((resolve) => {
        this.server.close(() => resolve());
      });
    }
    this._listening = false;
    return true;
  }

  /** 摘除事件订阅、销毁客户端、清理 socket 文件。必须晚于最终事件推送。 */
  async destroy() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    if (this.server) {
      // 未经 stopAccepting 直接 destroy（兼容路径）时才需要在这里发起 close；
      // 已经发起过就复用同一个 promise，避免二次 close 抛 ERR_SERVER_NOT_RUNNING。
      if (!this._serverClosePromise) {
        this._serverClosePromise = new Promise((resolve) => {
          this.server.close(() => resolve());
        });
      }
      // 客户端已全部销毁，close 回调此刻才可能兑现。
      await this._serverClosePromise;
      this.server = null;
      this._serverClosePromise = null;
    }
    this._listening = false;
    this._rejectBusiness = false;
    if (process.platform !== "win32") {
      removeUnixSocket(this.endpoint);
    }
  }

  /** 兼容旧调用点：一次做完两段。生产链改为分两段调用（见 createAgent.stop）。 */
  async close() {
    await this.stopAccepting();
    await this.destroy();
  }

  _accept(socket) {
    socket.setNoDelay(true);
    const client = {
      socket,
      decoder: new FrameDecoder({ maxFrameBytes: this.maxFrameBytes }),
      helloComplete: false,
      queue: Promise.resolve(),
    };
    this.clients.add(client);
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = client.decoder.push(chunk);
      } catch (error) {
        writeEnvelope(socket, { id: null, error: errorEnvelope(error) }, this.maxFrameBytes);
        socket.end();
        return;
      }
      for (const frame of frames) {
        client.queue = client.queue
          .then(() => this._handleFrame(client, frame))
          .catch((error) => {
            this.logger.error?.(String(error?.stack || error));
            socket.destroy();
          });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.clients.delete(client));
  }

  async _handleFrame(client, frame) {
    let request;
    try {
      request = decodeJsonFrame(frame);
      validateRequest(request);
      if (!client.helloComplete && request.method !== "system.hello") {
        throw new ApplicationError(
          ERROR_CODES.PROTOCOL_MISMATCH,
          "连接的第一个请求必须是 system.hello"
        );
      }
      if (this._rejectBusiness && !AgentIpcServer.DRAIN_ALLOWED_METHODS.has(request.method)) {
        throw new ApplicationError(
          ERROR_CODES.AGENT_DRAINING,
          "Agent 正在关闭，只接受诊断查询",
          { retryable: true }
        );
      }
      const result = await this.services.execute(request);
      assertMethodResultContract(request.method, result);
      if (request.method === "system.hello") client.helloComplete = true;
      writeEnvelope(client.socket, { id: request.id, result }, this.maxFrameBytes);
    } catch (error) {
      writeEnvelope(
        client.socket,
        { id: request?.id ?? null, error: errorEnvelope(error) },
        this.maxFrameBytes
      );
      if (!client.helloComplete) client.socket.end();
    }
  }

  _broadcastEvent(event) {
    for (const client of this.clients) {
      if (client.helloComplete) writeEnvelope(client.socket, event, this.maxFrameBytes);
    }
  }
}

export function createAgentIpcServer(options) {
  return new AgentIpcServer(options);
}

async function listenWithStaleSocketRecovery(server, endpoint) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await listenServer(server, endpoint);
      return;
    } catch (error) {
      if (
        process.platform === "win32" ||
        error?.code !== "EADDRINUSE" ||
        attempt !== 0 ||
        !(await removeIfStaleUnixSocket(endpoint))
      ) {
        throw error;
      }
    }
  }
}

function listenServer(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      path: endpoint,
      readableAll: false,
      writableAll: false,
    });
  });
}

async function removeIfStaleUnixSocket(endpoint) {
  const state = await probeUnixSocket(endpoint);
  if (state !== "stale") return false;

  try {
    const stat = fs.lstatSync(endpoint);
    if (!stat.isSocket()) return false;
    fs.unlinkSync(endpoint);
    return true;
  } catch (error) {
    // Another cleanup may win the race after bind reported EADDRINUSE. Retrying
    // the bind is safe when the path has disappeared.
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function probeUnixSocket(endpoint) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ path: endpoint });
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    // A timeout or an unexpected error is treated as occupied. Recovery only
    // deletes paths for the two errors that unambiguously mean no listener.
    const timer = setTimeout(() => finish("occupied"), 500);
    timer.unref?.();
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error) => {
      finish(error?.code === "ECONNREFUSED" || error?.code === "ENOENT" ? "stale" : "occupied");
    });
  });
}

function removeUnixSocket(endpoint) {
  try {
    const stat = fs.lstatSync(endpoint);
    if (stat.isSocket()) fs.unlinkSync(endpoint);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
