export type ErrorKind =
  | "invalid_input"
  | "auth"
  | "confirmation_required"
  | "destructive_blocked"
  | "host_ops_disabled"
  | "not_found"
  | "transient_exhausted"
  | "unknown";

export interface ToolError {
  kind: ErrorKind;
  message: string;
  raw_response?: unknown;
}

export type ToolResult =
  | ({ status: "ok" } & Record<string, unknown>)
  | ({ status: "partial" } & Record<string, unknown>)
  | { status: "error"; error: ToolError };

export function ok(data?: Record<string, unknown>): ToolResult {
  return { status: "ok", ...data };
}

export function partial(data: Record<string, unknown>): ToolResult {
  return { status: "partial", ...data };
}

export function err(
  kind: ErrorKind,
  message: string,
  raw_response?: unknown,
): ToolResult {
  const error: ToolError = { kind, message };
  if (raw_response !== undefined) {
    error.raw_response = raw_response;
  }
  return { status: "error", error };
}

export class CoolifyError extends Error {
  kind: ErrorKind;
  status?: number;
  raw_response?: unknown;
  retryAfter?: number;

  constructor(
    kind: ErrorKind,
    message: string,
    opts?: { status?: number; raw_response?: unknown; retryAfter?: number },
  ) {
    super(message);
    this.name = "CoolifyError";
    this.kind = kind;
    if (opts) {
      this.status = opts.status;
      this.raw_response = opts.raw_response;
      this.retryAfter = opts.retryAfter;
    }
    // Restore prototype chain in compiled ESM output
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function toErrorResult(e: unknown): ToolResult {
  if (e instanceof CoolifyError) {
    return err(e.kind, e.message, e.raw_response);
  }
  if (e instanceof Error) {
    return err("unknown", e.message);
  }
  if (typeof e === "string") {
    return err("unknown", e || "An unknown error occurred");
  }
  return err("unknown", "An unknown error occurred");
}
