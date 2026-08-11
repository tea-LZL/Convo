import { invoke } from "@tauri-apps/api/core";

export type LogStatus = "started" | "succeeded" | "failed" | "cancelled";

export interface LogEvent {
  operation: string;
  status: LogStatus;
  route?: string;
  providerKind?: string;
  durationMs?: number;
  errorClass?: string;
}

export function errorClass(error: unknown): string {
  if (error instanceof DOMException) return error.name || "DOMException";
  if (error instanceof Error) return error.name || "Error";
  if (typeof error === "string") return "Error";
  return "UnknownError";
}

export function recordLog(event: LogEvent): void {
  const safe = {
    operation: event.operation,
    status: event.status,
    ...(event.route ? { route: event.route } : {}),
    ...(event.providerKind ? { providerKind: event.providerKind } : {}),
    ...(event.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(event.durationMs)) } : {}),
    ...(event.errorClass ? { errorClass: event.errorClass } : {}),
  };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("convo:log", { detail: safe }));
  }
  void Promise.resolve(invoke("append_log_event", { event: safe })).catch(() => {
    // Diagnostics logging must never affect the operation being observed.
  });
  if (event.status === "failed") console.warn("[Convo] operation failed", safe);
}

export function withLog<T>(operation: string, work: () => Promise<T>, context: Omit<LogEvent, "operation" | "status" | "durationMs" | "errorClass"> = {}): Promise<T> {
  const started = performance.now();
  recordLog({ operation, status: "started", ...context });
  return work().then((value) => {
    recordLog({ operation, status: "succeeded", durationMs: performance.now() - started, ...context });
    return value;
  }).catch((error) => {
    recordLog({ operation, status: "failed", durationMs: performance.now() - started, errorClass: errorClass(error), ...context });
    throw error;
  });
}
