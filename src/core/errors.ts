import type { ErrorCode, ErrorDetails } from "./contracts/audit.js";

// Typed library failure, specs/MISSION.md 3.10. Callers switch on `code`, never on `message`.
export class ConfxError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly details: ErrorDetails[C] | undefined;

  constructor(code: C, message: string, ...details: C extends "internal_error" ? [] : [details?: ErrorDetails[C]]) {
    super(message);
    this.name = "ConfxError";
    this.code = code;
    this.details = details[0] as ErrorDetails[C] | undefined;
  }

  toJSON(): { code: C; message: string; details?: ErrorDetails[C] } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export const isConfxError = (value: unknown): value is ConfxError => value instanceof ConfxError;
