const ERROR_REASON_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function sanitizeErrorReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const reason = value.trim();

  return ERROR_REASON_PATTERN.test(reason) ? reason : null;
}
