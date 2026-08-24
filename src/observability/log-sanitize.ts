const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|credential|jwt|password|secret|token)/i;

export function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      sanitized[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeForLog(entry);
    }
    return sanitized;
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
      .replace(/apiKey["']?\s*:\s*["'][^"']+["']/gi, 'apiKey:"[redacted]"');
  }
  return value;
}

export function formatLogError(error: unknown): string {
  if (error instanceof Error) {
    return String(sanitizeForLog(error.message));
  }
  return String(sanitizeForLog(error));
}
