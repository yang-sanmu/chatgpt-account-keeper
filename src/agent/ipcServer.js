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
  }

  async listen() {
    if (this._listening) return { endpoint: this.endpoint };
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.endpoint), { recursive: true, mode: 0o700 });
    }
    this.server = net.createServer((socket) => this._accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({
        path: this.endpoint,
        readableAll: false,
        writableAll: false,
      });
    });
    this._listening = true;
    if (process.platform !== "win32") fs.chmodSync(this.endpoint, 0o600);
    this._unsubscribe = this.services.events.subscribe((event) => this._broadcastEvent(event));
    return { endpoint: this.endpoint };
  }

  async close() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this._listening = false;
    if (process.platform !== "win32") {
      try {
        const stat = fs.lstatSync(this.endpoint);
        if (stat.isSocket()) fs.unlinkSync(this.endpoint);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
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
