import fs from "node:fs";
import path from "node:path";
import { ensureDir, fromRoot } from "./paths.js";
import { replaceFileSync } from "./atomicFile.js";

const STATUS_CACHE_ENV = "CHATGPT_ACCOUNT_KEEPER_STATUS_CACHE_FILE";
let tempFileCounter = 0;
let statusBackend = null;

export function configureStatusBackend(backend) {
  if (backend != null && typeof backend !== "object") {
    throw new TypeError("status backend must be an object or null");
  }
  const previous = statusBackend;
  statusBackend = backend;
  return () => {
    statusBackend = previous;
  };
}

export function getStatusCacheFile() {
  const override = process.env[STATUS_CACHE_ENV];
  return override ? path.resolve(override) : fromRoot("config/status-cache.json");
}

export function readPersistedStatuses() {
  if (typeof statusBackend?.readPersistedStatuses === "function") {
    return statusBackend.readPersistedStatuses();
  }
  const file = getStatusCacheFile();
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const accounts = parsed?.accounts;
  return accounts && typeof accounts === "object" && !Array.isArray(accounts)
    ? accounts
    : {};
}

export function writePersistedStatuses(accounts) {
  if (typeof statusBackend?.writePersistedStatuses === "function") {
    return statusBackend.writePersistedStatuses(accounts);
  }
  const file = getStatusCacheFile();
  const directory = ensureDir(path.dirname(file));
  const tempFile = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${++tempFileCounter}.tmp`
  );
  let operationError = null;
  try {
    fs.writeFileSync(
      tempFile,
      JSON.stringify({ version: 1, accounts }, null, 2),
      "utf8"
    );
    replaceFileSync(tempFile, file);
  } catch (error) {
    operationError = error;
  }
  try {
    fs.unlinkSync(tempFile);
  } catch (error) {
    if (error?.code !== "ENOENT" && !operationError) operationError = error;
  }
  if (operationError) throw operationError;
}
