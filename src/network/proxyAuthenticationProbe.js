import http from "node:http";
import { randomBytes } from "node:crypto";
import { validateProxyCredentials } from "./strictConfig.js";

// Diagnostic for the pinned mihomo HTTP listener, not general HTTP status
// classification or proof of listener identity. Call only for a registered
// process/port; production ownership checks remain a separate M1 requirement.
// GET / is origin-form with no target authority: mihomo authenticates first,
// then returns 400 locally without forwarding. Three separate connections rule
// out a previous connection's authenticated state. No URL, cookie or proxy
// credentials are returned, and no browser authentication cache is warmed.
export async function probeMihomoAuthentication({ proxyOrigin, credentials, timeoutMs = 3000 }) {
  validateProxyCredentials(credentials);
  const endpoint = new URL(proxyOrigin);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("Invalid local authentication probe parameters");
  const snapshot = Object.freeze({ username: credentials.username, password: credentials.password });
  const query = supplied => new Promise(resolve => {
    let finished = false; let timer;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); request.destroy(); resolve(result);
    };
    const request = http.request({ hostname: "127.0.0.1", port: endpoint.port, method: "GET", path: "/", agent: false,
      maxHeaderSize: 4096,
      headers: { Connection: "close", ...(supplied ? {
        "Proxy-Authorization": `Basic ${Buffer.from(`${supplied.username}:${supplied.password}`).toString("base64")}`,
      } : {}) },
    }, response => {
      // Only the status and challenge scheme are needed; never retain bodies.
      finish({ status: response.statusCode, basic: /^Basic(?:\s|$)/iu.test(response.headers["proxy-authenticate"] ?? "") });
    });
    request.on("error", () => finish({ status: null, basic: false }));
    timer = setTimeout(() => finish({ status: null, basic: false }), timeoutMs);
    request.end();
  });
  const unknown = reason => ({ status: "unconfirmed", reason });
  const anonymous = await query(null);
  if (anonymous.status !== 407 || !anonymous.basic) return unknown("CHALLENGE_NOT_CONFIRMED");
  const negative = await query({ username: `probe-${randomBytes(24).toString("hex")}`, password: randomBytes(32).toString("hex") });
  if (negative.status !== 403) return unknown("REJECTION_NOT_CONFIRMED");
  const supplied = await query(snapshot);
  if (supplied.status === 403) return { status: "rejected", reason: "CREDENTIALS_REJECTED" };
  if (supplied.status !== 400) return unknown("LOCAL_RESPONSE_NOT_CONFIRMED");
  return { status: "accepted", reason: "LOCAL_AUTH_CHECK_PASSED" };
}
