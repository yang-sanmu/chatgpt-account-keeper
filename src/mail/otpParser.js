const RECIPIENT_HEADERS = [
  "to",
  "delivered-to",
  "x-original-to",
  "x-forwarded-to",
  "envelope-to",
  "sender",
  "x-qq-csender",
  "return-path",
  "authentication-results",
  "received-spf",
  "received",
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const RFC2047_RE = /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi;
const ADJACENT_ENCODED_WORDS_RE = /(\?=)[ \t\r\n]+(=\?)/g;

const HTML_ENTITIES = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#39", "'"],
]);

function normalizeCharset(raw) {
  const value = String(raw || "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!value || value === "utf8" || value === "utf-8") return "utf-8";
  if (value === "gb2312" || value === "gbk" || value === "cp936") return "gbk";
  if (value === "gb18030") return "gb18030";
  if (value === "latin1" || value === "iso8859-1") return "iso-8859-1";
  return value;
}

export function decodeCharsetBytes(bytes, charset = "utf-8") {
  const normalized = normalizeCharset(charset);
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeQuotedPrintableBytes(text) {
  const unfolded = String(text || "").replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < unfolded.length; i++) {
    if (
      unfolded[i] === "=" &&
      i + 2 < unfolded.length &&
      /^[0-9a-fA-F]{2}$/.test(unfolded.slice(i + 1, i + 3))
    ) {
      out.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = unfolded.charCodeAt(i);
    if (code <= 0xff) {
      out.push(code);
    } else {
      const encoded = Buffer.from(unfolded[i], "utf8");
      for (const byte of encoded) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

/**
 * 解码 RFC 2047 邮件头编码词。
 */
export function decodeRfc2047(text) {
  if (!text) return "";
  const compact = String(text)
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(ADJACENT_ENCODED_WORDS_RE, "$1$2");

  return compact.replace(RFC2047_RE, (_full, charset, encoding, payload) => {
    try {
      const mode = String(encoding).toUpperCase();
      if (mode === "B") {
        const bytes = Buffer.from(payload, "base64");
        return decodeCharsetBytes(bytes, charset);
      }
      const qDecoded = decodeQuotedPrintableBytes(payload.replace(/_/g, " "));
      return decodeCharsetBytes(qDecoded, charset);
    } catch {
      return payload;
    }
  });
}

function splitHeaderAndBody(raw) {
  const input = String(raw || "");
  const crlf = input.indexOf("\r\n\r\n");
  const lf = input.indexOf("\n\n");
  let idx = -1;
  let sepLen = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    idx = crlf;
    sepLen = 4;
  } else if (lf >= 0) {
    idx = lf;
    sepLen = 2;
  }
  if (idx < 0) return { headerText: input, bodyText: "" };
  return {
    headerText: input.slice(0, idx),
    bodyText: input.slice(idx + sepLen),
  };
}

function parseHeaders(headerText) {
  const unfolded = String(headerText || "").replace(/\r?\n([ \t]+)/g, " ");
  const headers = new Map();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
}

function parseContentType(headerValue) {
  const raw = String(headerValue || "text/plain");
  const parts = raw.split(";");
  const mimeType = parts[0].trim().toLowerCase() || "text/plain";
  const params = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    params[key] = val;
  }
  return { mimeType, params };
}

function decodeBodyContent(bodyText, transferEncoding, charset) {
  const cte = String(transferEncoding || "").trim().toLowerCase();
  if (cte === "base64") {
    const cleaned = String(bodyText || "").replace(/[^A-Za-z0-9+/=]/g, "");
    return decodeCharsetBytes(Buffer.from(cleaned, "base64"), charset);
  }
  if (cte === "quoted-printable") {
    return decodeCharsetBytes(decodeQuotedPrintableBytes(bodyText), charset);
  }
  return decodeCharsetBytes(Buffer.from(String(bodyText || ""), "latin1"), charset);
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, (full, entity) => {
      const lower = entity.toLowerCase();
      if (HTML_ENTITIES.has(lower)) return HTML_ENTITIES.get(lower);
      if (lower.startsWith("#x")) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      if (lower.startsWith("#")) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      return full;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectMimeParts(rawPart, depth = 0, out = { plain: [], html: [] }) {
  if (depth > 8 || !rawPart) return out;
  const { headerText, bodyText } = splitHeaderAndBody(rawPart);
  const headers = parseHeaders(headerText);
  const ctHeader = headers.get("content-type")?.[0] || "text/plain; charset=utf-8";
  const { mimeType, params } = parseContentType(ctHeader);
  const cte = headers.get("content-transfer-encoding")?.[0] || "";
  const charset = params.charset || "utf-8";

  if (mimeType.startsWith("multipart/") && params.boundary) {
    const boundary = `--${params.boundary}`;
    const chunks = bodyText.split(boundary);
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith("--")) break;
      const trimmed = chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      collectMimeParts(trimmed, depth + 1, out);
    }
    return out;
  }

  if (mimeType === "message/rfc822") {
    collectMimeParts(bodyText, depth + 1, out);
    return out;
  }

  const decoded = decodeBodyContent(bodyText, cte, charset);
  if (mimeType === "text/html") {
    out.html.push(stripHtml(decoded));
  } else if (mimeType.startsWith("text/") || mimeType === "") {
    out.plain.push(decoded.trim());
  }
  return out;
}

/**
 * 解析 RFC 5322 原始邮件，提取正文、主题、时间戳及转发/直投收件人候选集合。
 */
export function parseRawEmail(raw) {
  const { headerText } = splitHeaderAndBody(raw);
  const headers = parseHeaders(headerText);
  const subject = decodeRfc2047(headers.get("subject")?.[0] || "").trim();
  const from = decodeRfc2047(headers.get("from")?.[0] || "").trim();
  const messageId = (headers.get("message-id")?.[0] || "").trim();
  const rawDate = headers.get("date")?.[0] || "";
  const parsedDate = Date.parse(rawDate);
  const dateTs = Number.isFinite(parsedDate) ? parsedDate : null;

  const recipientTexts = [];
  const recipientEmails = new Set();
  for (const key of RECIPIENT_HEADERS) {
    const values = headers.get(key);
    if (!values) continue;
    for (const rawVal of values) {
      const decoded = decodeRfc2047(rawVal).toLowerCase();
      recipientTexts.push(decoded);
      for (const match of decoded.matchAll(EMAIL_RE)) {
        recipientEmails.add(match[0]);
      }
      // 解析 iCloud / Cloudflare VERP 转发格式，如 bounces+1234-foo=icloud.com@relay
      for (const verpMatch of decoded.matchAll(/([a-z0-9._%+-]+)=([a-z0-9.-]+\.[a-z]{2,})(?=@|[;\s>"]|$)/g)) {
        const localToken = verpMatch[1];
        const domain = verpMatch[2];
        recipientEmails.add(`${localToken}@${domain}`);
        // 支持前缀附带路由 tag：例如 bounces+279124-d4a2-alice.example=icloud.com
        const splitByPlus = localToken.split("+");
        for (let i = 1; i < splitByPlus.length; i++) {
          recipientEmails.add(`${splitByPlus.slice(i).join("+")}@${domain}`);
        }
        const tailPlus = splitByPlus[splitByPlus.length - 1];
        const dashParts = tailPlus.split("-");
        for (let i = 1; i < dashParts.length; i++) {
          recipientEmails.add(`${dashParts.slice(i).join("-")}@${domain}`);
        }
      }
    }
  }

  const parts = collectMimeParts(raw);
  const text = [...parts.plain, ...parts.html].filter(Boolean).join("\n\n").trim();

  return {
    headers,
    subject,
    from,
    messageId,
    dateTs,
    recipientEmails,
    recipientRawLower: recipientTexts.join("\n"),
    text,
  };
}

export function normalizeEmailAddress(email) {
  return String(email || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

/**
 * 判断邮件是否属于目标邮箱（兼容直接投递与 iCloud / Cloudflare 转发头）。
 */
export function matchesRecipient(parsed, targetEmail) {
  const target = normalizeEmailAddress(targetEmail);
  if (!target || !target.includes("@")) return false;
  if (parsed.recipientEmails?.has(target)) return true;

  const [local, domain] = target.split("@");
  const verpNeedle = `${local}=${domain}`;
  const haystack = parsed.recipientRawLower || "";
  let idx = haystack.indexOf(verpNeedle);
  while (idx >= 0) {
    const prev = idx === 0 ? "" : haystack[idx - 1];
    const next = haystack[idx + verpNeedle.length] || "";
    const leftOk = !prev || /[^a-z0-9._]|^/.test(prev) || prev === "+" || prev === "-";
    const rightOk = !next || next === "@" || /[^a-z0-9.-]/.test(next);
    if (leftOk && rightOk) return true;
    idx = haystack.indexOf(verpNeedle, idx + verpNeedle.length);
  }
  return false;
}

const OPENAI_SENDER_RE = /\b(?:openai\.com|chatgpt\.com|tm\d*\.openai\.com|email\.openai\.com|auth\.openai\.com)\b/i;
const OPENAI_TEXT_RE = /(openai|chatgpt|verification code|one[- ]time|log ?in code|anmeldecode|bestätigungscode|código|code de vérification|codice|mã đăng nhập|mã openai|tạm thời|認証コード|確認コード|인증 코드|验证码|一次性代码)/i;
const AUTH_SUBJECT_RE = /(code|verify|verification|log ?in|sign ?in|otp|anmeldecode|bestätigungscode|código|codice|mã|đăng nhập|tạm thời|認証|確認|인증|验证|代码|登录)/i;
const NEGATIVE_SUBJECT_RE = /(password was changed|email(?: address)? was changed|new (?:login|sign[- ]?in) to|security alert|password reset complete|got a question\?|start here|welkom bij|welcome to chatgpt|登录提醒)/i;

/**
 * 判断邮件是否为 OpenAI / ChatGPT 登录验证邮件。
 */
export function isOpenAiAuthMessage(parsed) {
  const from = String(parsed?.from || "");
  const subject = String(parsed?.subject || "");
  const text = String(parsed?.text || "");
  const combined = `${subject}\n${text.slice(0, 4000)}`;

  if (NEGATIVE_SUBJECT_RE.test(subject) && !/\b\d{6}\b/.test(subject)) {
    return false;
  }
  const hasBrand = OPENAI_SENDER_RE.test(from) || /\b(openai|chatgpt)\b/i.test(combined);
  if (!hasBrand) return false;
  return AUTH_SUBJECT_RE.test(subject) || OPENAI_TEXT_RE.test(combined);
}

const SUBJECT_CODE_RE = /(?:code|otp|pin|anmeldecode|bestätigungscode|código|codice|mã|인증\s*코드|認証コード|確認コード|验证码|代码)[^0-9]{0,24}(\d{6})\b/i;
const EXPLICIT_BODY_PATTERNS = [
  /(?:your\s+(?:temporary\s+|one[- ]time\s+)?(?:verification|log ?in|sign ?in)?\s*code\s*(?:is)?[:：\s]*)(\d{6})\b/i,
  /(?:enter\s+(?:this\s+)?(?:verification\s+)?code[:：\s]*)(\d{6})\b/i,
  /(?:one[- ]time\s+code[:：\s]*)(\d{6})\b/i,
  /(?:dein\s+(?:temporärer\s+)?(?:anmeldecode|bestätigungscode)[^\d]{0,24})(\d{6})\b/i,
  /(?:(?:código|code|codice|mã(?:\s+xác\s+minh|\s+đăng\s+nhập)?(?:\s+tạm\s+thời)?)[^\d]{0,30})(\d{6})\b/i,
  /(?:(?:認証コード|確認コード|인증\s*코드|验证码|动态密码)(?:为|是|：|:)?\s*)(\d{6})\b/i,
];

/**
 * 提取邮件中的 6 位 OpenAI 验证码；无匹配时返回 null。
 */
export function extractOpenAiOtp(parsed) {
  if (!parsed) return null;
  const subject = String(parsed.subject || "");
  const subjectMatch = subject.match(SUBJECT_CODE_RE);
  if (subjectMatch) return subjectMatch[1];

  const subjectBare = subject.match(/\b(\d{6})\b/);
  if (subjectBare && AUTH_SUBJECT_RE.test(subject)) {
    return subjectBare[1];
  }

  const text = String(parsed.text || "");
  for (const pattern of EXPLICIT_BODY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  // 兜底：若正文含验证码/ChatGPT 语境，取单独成行或紧邻关键词的 6 位数字。
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const standalone = line.trim().match(/^(\d{6})$/);
    if (standalone) return standalone[1];
  }

  const matches = [...text.matchAll(/\b(\d{6})\b/g)];
  for (const match of matches) {
    const start = Math.max(0, (match.index ?? 0) - 80);
    const window = text.slice(start, (match.index ?? 0) + 86);
    if (/(code|verify|verification|otp|chatgpt|openai|mã|xác minh|anmeldecode|bestätigungscode|código|codice|認証|確認|인증|验证|代码)/i.test(window)) {
      return match[1];
    }
  }
  return null;
}
