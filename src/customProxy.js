import { createHash } from "node:crypto";

function invalid() {
  const error = new Error("代理格式无效：请填写 主机:端口@用户名:密码，或带端口的 HTTP/SOCKS5 代理 URL、curl -x 主机:端口 -U \"用户名:密码\"");
  error.badRequest = true;
  return error;
}

// Parse a small curl argument subset as data. Never execute the pasted command.
function words(text) {
  const result = [];
  let word = "", quote = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === "\\" && ['"', "\\"].includes(text[i + 1])) {
        word += text[++i];
      } else if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) result.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw invalid();
  if (started) result.push(word);
  return result;
}

export function parseCustomProxies(input, selectedProtocol = "http") {
  if (!["http", "socks5"].includes(selectedProtocol)) throw invalid();
  if (typeof input !== "string" || input.length > 65536) throw invalid();
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 100) throw invalid();
  return lines.map((line) => {
    try {
      let address = line, credentials, scheme;
      // Provider export: host:port@username:password (also accepts a literal \@).
      // Split only the first separator so @ and colons in the password survive.
      if (!/^curl(?:\.exe)?\s/i.test(line) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
        const separator = line.indexOf("@");
        if (separator >= 0) {
          address = line.slice(0, separator).replace(/\\$/, "");
          credentials = line.slice(separator + 1);
        }
        // This format contains only an endpoint, not URL paths or fragments.
        if (!/^(?:\[[^\]\s]+\]|[^:\s/?#@\\]+):\d+$/.test(address)) throw invalid();
        scheme = selectedProtocol;
      }
      if (/^curl(?:\.exe)?\s/i.test(line)) {
        const args = words(line);
        address = null;
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          const match = arg.match(/^(--proxy|--proxy-user|--socks5|--socks5-hostname)=(.*)$/);
          const flag = match ? match[1] : arg;
          if (["-x", "--proxy", "-U", "--proxy-user", "--socks5", "--socks5-hostname"].includes(flag)) {
            const value = match ? match[2] : args[++i];
            if (!value) throw invalid();
            if (flag === "-U" || flag === "--proxy-user") credentials = value;
            else {
              if (address !== null) throw invalid();
              address = value;
              if (flag.startsWith("--socks5")) scheme = "socks5";
            }
          } else if (arg.startsWith("-")) {
            // Do not silently misinterpret unrelated curl options as proxy settings.
            throw invalid();
          }
        }
        if (!address) throw invalid();
      }
      if (!address.includes("://")) address = `${scheme ?? selectedProtocol}://${address}`;
      const url = new URL(address);
      const protocol = url.protocol.slice(0, -1).toLowerCase();
      if (!["http", "https", "socks5", "socks5h"].includes(protocol)) throw invalid();
      if (scheme === "socks5" && !protocol.startsWith("socks5")) throw invalid();
      if (url.search || (url.pathname && url.pathname !== "/")) throw invalid();
      const authority = address.split("://")[1].split(/[/?#]/)[0].split("@").at(-1);
      const explicitPort = authority.match(/:(\d+)$/)?.[1];
      const port = Number(explicitPort);
      if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
      let username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
      if (credentials !== undefined) {
        const colon = credentials.indexOf(":");
        if (colon <= 0) throw invalid();
        username = credentials.slice(0, colon);
        password = credentials.slice(colon + 1);
      }
      if (password && !username) throw invalid();
      const type = protocol.startsWith("socks5") ? "socks5" : "http";
      const server = url.hostname.replace(/^\[|\]$/g, "");
      const tls = protocol === "https";
      const identity = JSON.stringify([type, server, port, tls, username, password]);
      const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 20);
      const name = decodeURIComponent(url.hash.slice(1)).trim() || `${type.toUpperCase()} ${url.hostname}:${port} · ${suffix.slice(0, 6)}`;
      if (name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw invalid();
      return {
        id: `custom_${suffix}`,
        name,
        raw: { name: `custom_${suffix}`, type, server, port, ...(tls ? { tls: true } : {}), ...(username ? { username, password } : {}) },
        enabled: true,
        missing: false,
      };
    } catch {
      // Parser exceptions can contain the original URL and its credentials.
      throw invalid();
    }
  });
}

export function appendCustomProxies(previous, imported) {
  const nodes = new Map(previous.map((node) => [node.id, node]));
  for (const node of imported) {
    const old = nodes.get(node.id);
    nodes.set(node.id, { ...node, name: old?.name ?? node.name, enabled: old ? old.enabled !== false : true });
  }
  return [...nodes.values()];
}
