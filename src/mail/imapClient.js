import net from "node:net";
import tls from "node:tls";

const MONTHS = new Map([
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
]);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function quoteImapString(value) {
  const str = String(value ?? "");
  if (/[\r\n\0]/.test(str)) {
    throw new Error("IMAP 参数不能包含换行符");
  }
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatImapSearchDate(timestampMs) {
  const date = new Date(timestampMs);
  return `${date.getUTCDate()}-${MONTH_NAMES[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

export function parseImapInternalDate(text) {
  if (!text) return null;
  const match = String(text).match(
    /(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/
  );
  if (match) {
    const day = Number.parseInt(match[1], 10);
    const month = MONTHS.get(match[2].toLowerCase());
    const year = Number.parseInt(match[3], 10);
    const hour = Number.parseInt(match[4], 10);
    const min = Number.parseInt(match[5], 10);
    const sec = Number.parseInt(match[6], 10);
    if (month !== undefined) {
      let utc = Date.UTC(year, month, day, hour, min, sec);
      if (match[7]) {
        const sign = match[7][0] === "-" ? -1 : 1;
        const tzH = Number.parseInt(match[7].slice(1, 3), 10);
        const tzM = Number.parseInt(match[7].slice(3, 5), 10);
        utc -= sign * (tzH * 60 + tzM) * 60_000;
      }
      return utc;
    }
  }
  const fallback = Date.parse(String(text));
  return Number.isFinite(fallback) ? fallback : null;
}

/**
 * 解析包含 CRLF 与 `{byteSize}\r\n` 二进制字面量的 IMAP 响应帧。
 */
export class ImapFrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.literalRemaining = 0;
    this.parts = [];
    this.literals = [];
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!incoming.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming;

    while (this.buffer.length > 0) {
      if (this.literalRemaining > 0) {
        if (this.buffer.length < this.literalRemaining) return;
        const literal = Buffer.from(this.buffer.subarray(0, this.literalRemaining));
        this.buffer = this.buffer.subarray(this.literalRemaining);
        this.literalRemaining = 0;
        this.literals.push(literal);
        continue;
      }

      const crlf = this.buffer.indexOf("\r\n");
      if (crlf < 0) return;

      const segment = this.buffer.subarray(0, crlf).toString("latin1");
      this.buffer = this.buffer.subarray(crlf + 2);

      const litMatch = segment.match(/\{(\d+)\+?\}$/);
      if (litMatch) {
        const size = Number.parseInt(litMatch[1], 10);
        const prefix = segment.slice(0, litMatch.index);
        const litIndex = this.literals.length;
        this.parts.push(`${prefix}\0LIT:${litIndex}\0`);
        if (size === 0) {
          this.literals.push(Buffer.alloc(0));
        } else {
          this.literalRemaining = size;
        }
        continue;
      }

      this.parts.push(segment);
      const frame = {
        text: this.parts.join(""),
        literals: this.literals,
      };
      this.parts = [];
      this.literals = [];
      this.onFrame(frame);
    }
  }
}

export class ImapError extends Error {
  constructor(message, { code = "IMAP_ERROR", response = null } = {}) {
    super(message);
    this.name = "ImapError";
    this.code = code;
    this.response = response;
  }
}

let cachedSystemCas = null;

function getCombinedCaCertificates() {
  if (cachedSystemCas) return cachedSystemCas;
  if (typeof tls.getCACertificates !== "function") return undefined;
  try {
    cachedSystemCas = [
      ...tls.getCACertificates("default"),
      ...tls.getCACertificates("system"),
    ];
    return cachedSystemCas.length ? cachedSystemCas : undefined;
  } catch {
    return undefined;
  }
}

function defaultConnectSocket({ host, port, tls: useTls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(socket);
    };

    const ca = useTls ? getCombinedCaCertificates() : undefined;
    const socket = useTls
      ? tls.connect({
          host,
          port,
          servername: host,
          minVersion: "TLSv1.2",
          ...(ca ? { ca } : {}),
        })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      done(new ImapError(`连接 IMAP 服务器超时（${host}:${port}）`, { code: "IMAP_TIMEOUT" }));
    }, timeoutMs);
    timer.unref?.();

    const readyEvent = useTls ? "secureConnect" : "connect";
    socket.once(readyEvent, () => {
      clearTimeout(timer);
      done(null, socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      done(new ImapError(`连接 IMAP 服务器失败：${err.message}`, { code: "IMAP_CONNECT_FAILED" }));
    });
  });
}

function parseListFrame(text) {
  const match = text.match(/^\*\s+LIST\s+\(([^)]*)\)\s+(?:"((?:[^"\\]|\\.)*)"|NIL)\s+(.+)$/i);
  if (!match) return null;
  const attrs = match[1]
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  let name = match[3].trim();
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return { attrs, name };
}

function parseFetchResponse(frame) {
  const uidMatch = frame.text.match(/\bUID\s+(\d+)\b/i);
  if (!uidMatch) return null;
  const uid = Number.parseInt(uidMatch[1], 10);
  const dateMatch = frame.text.match(/\bINTERNALDATE\s+"([^"]+)"/i);
  const internalDateTs = dateMatch ? parseImapInternalDate(dateMatch[1]) : null;
  const litMatch = frame.text.match(/\bBODY\[\]\s+\0LIT:(\d+)\0/i);
  const rawBuffer = litMatch ? frame.literals[Number.parseInt(litMatch[1], 10)] : null;
  if (!rawBuffer) return null;
  return {
    uid,
    internalDateTs,
    raw: rawBuffer.toString("latin1"),
  };
}

/**
 * 纯 Node IMAP4rev1 客户端。
 */
export class ImapClient {
  constructor(options = {}) {
    this.host = String(options.host || "").trim();
    this.port = Number(options.port || 993);
    this.tls = options.tls !== false;
    this.commandTimeoutMs = Number(options.commandTimeoutMs || 20_000);
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 15_000);
    this._connectSocket = options.connectSocket ?? defaultConnectSocket;

    this.socket = null;
    this.decoder = null;
    this.tagSeq = 0;
    this.closed = false;
    this.greetingPromise = null;
    this._greetingSettled = false;
    this._resolveGreeting = null;
    this._rejectGreeting = null;
    this._activeCommand = null;
    this._commandChain = Promise.resolve();
  }

  get isOpen() {
    return Boolean(this.socket && !this.closed && !this.socket.destroyed);
  }

  async connect() {
    if (!this.host) throw new ImapError("未配置 IMAP 服务器地址", { code: "IMAP_CONFIG_INVALID" });
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new ImapError("IMAP 端口无效", { code: "IMAP_CONFIG_INVALID" });
    }

    this.closed = false;
    this.greetingPromise = new Promise((resolve, reject) => {
      this._resolveGreeting = resolve;
      this._rejectGreeting = reject;
    });

    const socket = await this._connectSocket({
      host: this.host,
      port: this.port,
      tls: this.tls,
      timeoutMs: this.connectTimeoutMs,
    });
    this.socket = socket;
    this.decoder = new ImapFrameDecoder((frame) => this._handleFrame(frame));

    socket.on("data", (chunk) => {
      try {
        this.decoder?.push(chunk);
      } catch (err) {
        this._failPending(new ImapError(`解析 IMAP 响应失败：${err.message}`, { code: "IMAP_PROTOCOL_ERROR" }));
      }
    });
    socket.on("error", (err) => {
      this._failPending(new ImapError(`IMAP 连接异常：${err.message}`, { code: "IMAP_SOCKET_ERROR" }));
      this.closed = true;
    });
    socket.on("close", () => {
      this.closed = true;
      this._failPending(new ImapError("IMAP 连接已断开", { code: "IMAP_CLOSED" }));
    });

    const timer = setTimeout(() => {
      this._failGreeting(new ImapError("等待 IMAP 欢迎报文超时", { code: "IMAP_TIMEOUT" }));
    }, this.commandTimeoutMs);
    timer.unref?.();
    try {
      await this.greetingPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  _failGreeting(err) {
    if (this._greetingSettled) return;
    this._greetingSettled = true;
    this._rejectGreeting?.(err);
  }

  _failPending(err) {
    this._failGreeting(err);
    if (this._activeCommand) {
      const cmd = this._activeCommand;
      this._activeCommand = null;
      clearTimeout(cmd.timer);
      cmd.reject(err);
    }
  }

  _handleFrame(frame) {
    const text = frame.text;
    if (!this._greetingSettled) {
      if (/^\*\s+(OK|PREAUTH)\b/i.test(text)) {
        this._greetingSettled = true;
        this._resolveGreeting?.(text);
        return;
      }
      if (/^\*\s+BYE\b/i.test(text)) {
        this._failGreeting(new ImapError(`IMAP 拒绝连接：${text}`, { code: "IMAP_BYE" }));
        return;
      }
    }

    const active = this._activeCommand;
    if (!active) return;

    const tagPrefix = `${active.tag} `;
    if (text.startsWith(tagPrefix)) {
      const rest = text.slice(tagPrefix.length).trim();
      this._activeCommand = null;
      clearTimeout(active.timer);
      const statusMatch = rest.match(/^(OK|NO|BAD)\b\s*(.*)$/i);
      const status = statusMatch ? statusMatch[1].toUpperCase() : "BAD";
      const detail = statusMatch ? statusMatch[2] : rest;
      if (status === "OK") {
        active.resolve({ status, detail, untagged: active.untagged });
      } else {
        active.reject(
          new ImapError(detail || `IMAP 命令失败 (${status})`, {
            code: status === "NO" ? "IMAP_NO" : "IMAP_BAD",
            response: { status, detail, untagged: active.untagged },
          })
        );
      }
      return;
    }

    active.untagged.push(frame);
  }

  runCommand(line, { label = "COMMAND", signal = null } = {}) {
    const exec = async () => {
      if (!this.isOpen) {
        throw new ImapError("IMAP 连接未打开", { code: "IMAP_CLOSED" });
      }
      if (signal?.aborted) {
        throw new ImapError("操作已取消", { code: "ABORTED" });
      }
      const tag = `A${String(++this.tagSeq).padStart(4, "0")}`;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this._activeCommand?.tag === tag) {
            this._activeCommand = null;
          }
          const err = new ImapError(`IMAP ${label} 超时`, { code: "IMAP_TIMEOUT" });
          this.close();
          reject(err);
        }, this.commandTimeoutMs);
        timer.unref?.();

        const onAbort = () => {
          if (this._activeCommand?.tag === tag) {
            this._activeCommand = null;
          }
          clearTimeout(timer);
          // 中止在途命令时同步关闭底层连接，防止服务器后续回包错位污染复用会话。
          this.close();
          reject(new ImapError("操作已取消", { code: "ABORTED" }));
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });

        this._activeCommand = {
          tag,
          untagged: [],
          timer,
          resolve: (res) => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve(res);
          },
          reject: (err) => {
            signal?.removeEventListener?.("abort", onAbort);
            reject(err);
          },
        };
        this.socket.write(`${tag} ${line}\r\n`);
      });
    };

    const next = this._commandChain.then(exec, exec);
    this._commandChain = next.catch(() => {});
    return next;
  }

  async login(user, password, { signal = null } = {}) {
    if (!user || !password) {
      throw new ImapError("IMAP 用户名或授权码不能为空", { code: "IMAP_CONFIG_INVALID" });
    }
    try {
      await this.runCommand(`LOGIN ${quoteImapString(user)} ${quoteImapString(password)}`, {
        label: "LOGIN",
        signal,
      });
    } catch (err) {
      if (err instanceof ImapError && err.code === "IMAP_NO") {
        throw new ImapError("IMAP 登录失败：账号或授权码错误", {
          code: "IMAP_AUTH_FAILED",
          response: err.response,
        });
      }
      throw err;
    }
  }

  async listFolders({ signal = null } = {}) {
    const res = await this.runCommand('LIST "" "*"', { label: "LIST", signal });
    const folders = [];
    for (const frame of res.untagged) {
      const parsed = parseListFrame(frame.text);
      if (parsed) folders.push(parsed);
    }
    return folders;
  }

  async examine(folder, { signal = null } = {}) {
    const res = await this.runCommand(`EXAMINE ${quoteImapString(folder)}`, {
      label: `EXAMINE ${folder}`,
      signal,
    });
    let exists = 0;
    let uidValidity = null;
    let uidNext = null;
    for (const frame of res.untagged) {
      const existsMatch = frame.text.match(/^\*\s+(\d+)\s+EXISTS\b/i);
      if (existsMatch) exists = Number.parseInt(existsMatch[1], 10);
      const valMatch = frame.text.match(/\[UIDVALIDITY\s+(\d+)\]/i);
      if (valMatch) uidValidity = Number.parseInt(valMatch[1], 10);
      const nextMatch = frame.text.match(/\[UIDNEXT\s+(\d+)\]/i);
      if (nextMatch) uidNext = Number.parseInt(nextMatch[1], 10);
    }
    return { exists, uidValidity, uidNext };
  }

  async uidSearch(criteria, { signal = null } = {}) {
    const res = await this.runCommand(`UID SEARCH ${criteria}`, {
      label: "UID SEARCH",
      signal,
    });
    const uids = [];
    for (const frame of res.untagged) {
      const match = frame.text.match(/^\*\s+SEARCH(?:\s+(.*))?$/i);
      if (!match || !match[1]) continue;
      for (const token of match[1].trim().split(/\s+/)) {
        const uid = Number.parseInt(token, 10);
        if (Number.isInteger(uid) && uid > 0) uids.push(uid);
      }
    }
    uids.sort((a, b) => a - b);
    return uids;
  }

  async uidFetchMessages(uids, { signal = null, batchSize = 10 } = {}) {
    if (!uids?.length) return [];
    const results = [];
    for (let i = 0; i < uids.length; i += batchSize) {
      const slice = uids.slice(i, i + batchSize);
      const res = await this.runCommand(`UID FETCH ${slice.join(",")} (UID INTERNALDATE BODY.PEEK[])`, {
        label: "UID FETCH",
        signal,
      });
      for (const frame of res.untagged) {
        const parsed = parseFetchResponse(frame);
        if (parsed) results.push(parsed);
      }
    }
    return results;
  }

  async logout() {
    if (!this.isOpen) return;
    try {
      await Promise.race([
        this.runCommand("LOGOUT", { label: "LOGOUT" }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      // 关闭阶段的错误无需抛出
    } finally {
      this.close();
    }
  }

  close() {
    this.closed = true;
    this._failPending(new ImapError("IMAP 连接已关闭", { code: "IMAP_CLOSED" }));
    try {
      this.socket?.destroy();
    } catch {
      // 忽略销毁错误
    }
    this.socket = null;
  }
}
