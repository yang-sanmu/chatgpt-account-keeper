import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = new Map(
  [...BASE32_ALPHABET].map((char, index) => [char, index])
);

/**
 * 规范化 Base32 TOTP 密钥（支持 otpauth:// URI 或带空格/连字符的字符串）。
 */
export function normalizeTotpSecret(rawSecret) {
  if (typeof rawSecret !== "string") {
    throw new Error("TOTP 密钥必须是字符串");
  }
  let candidate = rawSecret.trim();
  if (/^otpauth:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      const paramSecret = parsed.searchParams.get("secret");
      if (!paramSecret) throw new Error("otpauth URI 缺少 secret 参数");
      candidate = paramSecret;
    } catch (error) {
      throw new Error(`无效的 otpauth URI：${error.message}`);
    }
  }
  const cleaned = candidate.replace(/[\s-]+/g, "").toUpperCase().replace(/=+$/, "");
  if (!cleaned) {
    throw new Error("TOTP 密钥不能为空");
  }
  for (const ch of cleaned) {
    if (!BASE32_LOOKUP.has(ch)) {
      throw new Error(`TOTP 密钥包含非 Base32 字符：${ch}`);
    }
  }
  return cleaned;
}

/**
 * 解码规范化后的 RFC 4648 Base32 字符串。
 */
export function decodeBase32(rawSecret) {
  const normalized = normalizeTotpSecret(rawSecret);
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of normalized) {
    const idx = BASE32_LOOKUP.get(char);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (!bytes.length) {
    throw new Error("TOTP 密钥长度不足");
  }
  return Buffer.from(bytes);
}

/**
 * 计算当前 RFC 6238 时间片剩余秒数，避免踩在 30 秒边界提交过期码。
 */
export function totpSecondsRemaining(nowMs = Date.now(), stepSeconds = 30) {
  const epochSeconds = Math.floor(nowMs / 1000);
  return stepSeconds - (epochSeconds % stepSeconds);
}

/**
 * 生成 RFC 6238 TOTP 动态口令（默认 6 位 / 30 秒 / HMAC-SHA1）。
 */
export function generateTotp(
  secret,
  { nowMs = Date.now(), stepSeconds = 30, digits = 6, algorithm = "sha1" } = {}
) {
  const key = decodeBase32(secret);
  const counter = BigInt(Math.floor(nowMs / 1000 / stepSeconds));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const digest = createHmac(algorithm, key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const modulo = 10 ** digits;
  return String(binary % modulo).padStart(digits, "0");
}
