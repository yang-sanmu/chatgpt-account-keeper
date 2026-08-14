export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  RESOURCE_BUSY: "RESOURCE_BUSY",
  PROFILE_IN_USE: "PROFILE_IN_USE",
  PROXY_UNAVAILABLE: "PROXY_UNAVAILABLE",
  ALREADY_OPEN: "ALREADY_OPEN",
  LOGIN_FORCE_CONFLICT: "LOGIN_FORCE_CONFLICT",
  CHROME_NOT_FOUND: "CHROME_NOT_FOUND",
  AGENT_DRAINING: "AGENT_DRAINING",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  INTERNAL: "INTERNAL",
});

export class ApplicationError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code));
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function fail(code, message, options) {
  throw new ApplicationError(code, message, options);
}

export function assertInput(condition, message, details) {
  if (!condition) {
    fail(ERROR_CODES.VALIDATION_FAILED, message, { details });
  }
}

function isChromeMissing(error, message) {
  if (error?.code === ERROR_CODES.CHROME_NOT_FOUND) return true;
  return /(?:google\s+chrome|channel\s*["']?chrome|chrome\.exe).*(?:not found|does not exist|missing|install)|(?:not found|could not find|missing).*(?:google\s+chrome|channel\s*["']?chrome|chrome\.exe)/i.test(
    message
  );
}

export function normalizeApplicationError(error) {
  if (error instanceof ApplicationError) return error;

  const message = String(error?.message || error || "Unknown error");
  if (error?.code === "FRAME_TOO_LARGE") {
    return new ApplicationError(ERROR_CODES.FRAME_TOO_LARGE, message, { cause: error });
  }
  if (
    error?.code === "INVALID_JSON" ||
    error?.code === "INVALID_FRAME" ||
    error?.code === "COMMAND_ID_REUSED"
  ) {
    return new ApplicationError(ERROR_CODES.VALIDATION_FAILED, message, { cause: error });
  }
  if (isChromeMissing(error, message)) {
    return new ApplicationError(
      ERROR_CODES.CHROME_NOT_FOUND,
      "未找到本机 Google Chrome，请安装 Chrome 后重试",
      { cause: error }
    );
  }
  if (error?.code === "LOGIN_FORCE_CONFLICT") {
    return new ApplicationError(ERROR_CODES.LOGIN_FORCE_CONFLICT, message, {
      details: { conflictTaskId: error.conflictTaskId ?? null },
      cause: error,
    });
  }
  if (error?.badRequest || error?.statusCode === 400) {
    return new ApplicationError(ERROR_CODES.VALIDATION_FAILED, message, {
      cause: error,
    });
  }
  if (error?.statusCode === 404) {
    return new ApplicationError(ERROR_CODES.NOT_FOUND, message, { cause: error });
  }
  if (error?.statusCode === 409) {
    const code = /profile/i.test(message)
      ? ERROR_CODES.PROFILE_IN_USE
      : ERROR_CODES.RESOURCE_BUSY;
    return new ApplicationError(code, message, {
      retryable: true,
      cause: error,
    });
  }
  return new ApplicationError(ERROR_CODES.INTERNAL, message, { cause: error });
}

export function errorEnvelope(error) {
  const normalized = normalizeApplicationError(error);
  const out = {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable === true,
  };
  if (normalized.details !== undefined) out.details = normalized.details;
  return out;
}
