import { AsyncLocalStorage } from "node:async_hooks";

const contexts = new AsyncLocalStorage<DiagnosticContext>();
const stages = new Set([
  "webhook",
  "backend",
  "telegram_api",
  "parsed",
  "openrouter",
  "tour_search",
  "departures",
  "countries",
  "meals",
  "dictionaries",
  "resolved",
  "tour_search_validation",
  "tour_results",
  "pipeline_result",
  "pipeline",
  "start_search",
]);
const events = new Set(["start", "end", "response_ready"]);
const results = new Set(["http_ok", "http_error", "exception", "completed"]);
const errorTypes = new Set([
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "NotFound",
  "PermissionDenied",
  "ConnectionRefused",
  "ConnectionReset",
  "ConnectionAborted",
  "NotConnected",
  "BrokenPipe",
  "TimedOut",
  "UnexpectedEof",
  "Http",
  "Busy",
  "Interrupted",
]);
const errorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const errors = new Set(["SEND_FAILED", "BACKEND_FAILED", "PROCESSING_FAILED"]);

function field(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Never return exception messages, stacks, arbitrary names or raw causes. */
export function classifySafeError(error: unknown): Record<string, string> {
  const name = field(error, "name");
  const ownCode = field(error, "code");
  const causeCode = field(field(error, "cause"), "code");
  const code = typeof ownCode === "string" && errorCodes.has(ownCode) ? ownCode : causeCode;
  return {
    error_type: typeof name === "string" && errorTypes.has(name) ? name : "unknown",
    error_code: typeof code === "string" && errorCodes.has(code) ? code : "unknown",
  };
}

export class DiagnosticContext {
  readonly requestId = crypto.randomUUID();
  readonly started = performance.now();
  updateId?: number;
  sendAttempts = 0;
  sendFailures = 0;

  setUpdateId(value: unknown): void {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      this.updateId = value;
    }
  }

  /** Explicit allowlist: adding a field to a caller cannot expose it in logs. */
  emit(entry: Record<string, unknown>): void {
    try {
      const safe: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        request_id: this.requestId,
      };
      if (this.updateId !== undefined) safe.update_id = this.updateId;
      safe.stage = typeof entry.stage === "string" && stages.has(entry.stage)
        ? entry.stage
        : "unknown";
      for (
        const [key, allowed] of [
          ["event", events],
          ["result", results],
          ["error", errors],
          ["error_type", errorTypes],
          ["error_code", errorCodes],
        ] as const
      ) {
        const value = entry[key];
        if (
          typeof value === "string" && (allowed.has(value) ||
            (value === "unknown" && (key === "error_type" || key === "error_code")))
        ) {
          safe[key] = value;
        }
      }
      for (const key of ["duration_ms", "send_seq", "send_attempts", "send_failures"]) {
        const value = entry[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          safe[key] = Math.round(value);
        }
      }
      const status = entry.http_status ?? entry.status;
      if (
        typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ) {
        safe.http_status = status;
      }
      console.error(JSON.stringify(safe));
    } catch {
      // Diagnostics must never change processing or HTTP responses.
    }
  }
}

export function currentDiagnostics(): DiagnosticContext | undefined {
  return contexts.getStore();
}

export function logEntry(entry: Record<string, unknown>): void {
  const context = currentDiagnostics();
  if (context) context.emit(entry);
  else console.error(JSON.stringify(entry));
}

export async function diagnoseRequest(run: () => Promise<Response>): Promise<Response> {
  const context = new DiagnosticContext();
  return await contexts.run(context, async () => {
    context.emit({ stage: "webhook", event: "start" });
    const response = await run();
    context.emit({
      stage: "webhook",
      event: "response_ready",
      http_status: response.status,
      duration_ms: performance.now() - context.started,
      send_attempts: context.sendAttempts,
      send_failures: context.sendFailures,
    });
    return response;
  });
}
