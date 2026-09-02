import type { EngineError } from "./types.js";

export type ErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "SESSION_BUSY" | "INTERACTION_RESOLVED" | "BAD_GATEWAY" | "SERVICE_UNAVAILABLE" | "CAPACITY_EXCEEDED" | "RUN_TIMEOUT" | "INTERNAL_ERROR";

export class GatewayError extends Error {
  constructor(public readonly status: number, public readonly code: ErrorCode, message: string) { super(message); }
}

export function fromEngineError(error: EngineError): GatewayError {
  const mapping = {
    INVALID_REQUEST: [400, "VALIDATION_ERROR"], UNAVAILABLE: [503, "SERVICE_UNAVAILABLE"],
    UPSTREAM_ERROR: [502, "BAD_GATEWAY"], TIMEOUT: [504, "RUN_TIMEOUT"], INTERNAL: [500, "INTERNAL_ERROR"]
  } as const;
  const [status, code] = mapping[error.code];
  return new GatewayError(status, code, error.message);
}
