export interface ParsedCustomProxy {
  name: string;
  protocol: "http" | "https" | "socks5";
  server: string;
  port: number;
  username: string;
  password: string;
}

/** Parse pasted proxy settings as data, without saving or executing commands. */
export function parseCustomProxyInput(input: string, selectedProtocol?: ParsedCustomProxy["protocol"]): ParsedCustomProxy[];
