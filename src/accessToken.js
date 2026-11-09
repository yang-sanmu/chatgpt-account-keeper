export function readAccessTokenClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function accessTokenExpiry(token) {
  const exp = readAccessTokenClaims(token)?.exp;
  if (!Number.isFinite(exp)) return null;
  const date = new Date(exp * 1000);
  const year = date.getUTCFullYear();
  return year >= 0 && year <= 9999 ? date.toISOString() : null;
}
