export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class FrameProtocolError extends Error {
  constructor(message, code = "INVALID_FRAME") {
    super(message);
    this.name = "FrameProtocolError";
    this.code = code;
  }
}

export function encodeFrame(value, options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new FrameProtocolError(`JSON 序列化失败：${error.message || error}`, "INVALID_JSON");
  }
  if (payload.length > maxFrameBytes) {
    throw new FrameProtocolError(
      `帧长度 ${payload.length} 超过上限 ${maxFrameBytes}`,
      "FRAME_TOO_LARGE"
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  constructor(options = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this._buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (!chunk.length) return [];
    this._buffer = this._buffer.length
      ? Buffer.concat([this._buffer, chunk])
      : chunk;
    const frames = [];
    while (this._buffer.length >= 4) {
      const length = this._buffer.readUInt32LE(0);
      if (length > this.maxFrameBytes) {
        this._buffer = Buffer.alloc(0);
        throw new FrameProtocolError(
          `帧长度 ${length} 超过上限 ${this.maxFrameBytes}`,
          "FRAME_TOO_LARGE"
        );
      }
      if (this._buffer.length < 4 + length) break;
      frames.push(this._buffer.subarray(4, 4 + length));
      this._buffer = this._buffer.subarray(4 + length);
    }
    return frames;
  }

  reset() {
    this._buffer = Buffer.alloc(0);
  }
}

export function decodeJsonFrame(payload) {
  try {
    const value = JSON.parse(payload.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("顶层 JSON 必须是对象");
    }
    return value;
  } catch (error) {
    throw new FrameProtocolError(`无效 JSON：${error.message || error}`, "INVALID_JSON");
  }
}
