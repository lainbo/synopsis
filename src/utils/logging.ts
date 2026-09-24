type LogData = Record<string, unknown>;

export function logInfo(event: string, data: LogData = {}): void {
  writeLog("info", event, data);
}

export function logError(
  event: string,
  error: unknown,
  data: LogData = {}
): void {
  writeLog("error", event, {
    ...data,
    error: normalizeError(error)
  });
}

function writeLog(level: "info" | "error", event: string, data: LogData): void {
  console.log(
    JSON.stringify({
      event,
      "level": level,
      timestamp: new Date().toISOString(),
      ...data
    })
  );
}

function normalizeError(error: unknown): { name: string; reason?: string; status?: number } {
  if (error instanceof Error) {
    const structured = error as Error & { reason?: unknown; status?: unknown };
    return {
      name: /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.name) ? error.name : "Error",
      reason: typeof structured.reason === "string" && /^[a-z0-9_]{1,100}$/.test(structured.reason)
        ? structured.reason : undefined,
      status: typeof structured.status === "number" ? structured.status : undefined
    };
  }
  return {
    name: "UnknownError",
    reason: typeof error === "string" && /^[a-z0-9_]{1,100}$/.test(error) ? error : undefined
  };
}
