import type { ErrorCode } from './protocol.ts';

/** An expected failure with a stable code, for the worker reply and the CLI exit. */
export class CoreError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

export function errorCode(error: unknown): ErrorCode {
  return error instanceof CoreError ? error.code : 'internal';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
