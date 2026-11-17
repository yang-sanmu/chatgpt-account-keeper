import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 基于 IPC 主密钥派生独立用途的 256-bit AES-GCM 密钥。
 */
export function deriveSealingKey(ipcKey, info) {
  return hkdfSync("sha256", ipcKey, "", info, 32);
}

/**
 * 使用 AES-256-GCM 密封明文字符串，并绑定 AAD 防止密文跨记录复用。
 */
export function sealSecret(key, aad, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/**
 * 解封密文；认证失败或格式损坏时返回 null。
 */
export function unsealSecret(key, aad, sealed) {
  if (typeof sealed !== "string" || !sealed) return null;
  try {
    const data = Buffer.from(sealed, "base64");
    if (data.length < IV_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES));
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
