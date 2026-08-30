import type { Logger } from "./types.js";

const SECRET_KEY = /(authorization|api[_-]?key|token|cookie|password|secret)/i;

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/xai-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export const logger: Logger = {
  log(level, event, fields = {}) {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...redact(fields) as object })}\n`);
  },
};
