import { CoreError } from '../core/errors.ts';

/** Stable error codes of the CLI: the core codes plus the file and usage codes. */
export type CliErrorCode =
  | CoreError['code']
  | 'usage'
  | 'file-not-found'
  | 'read-failed'
  | 'output-exists'
  | 'write-failed'
  | 'bad-palette';

export class CliError extends Error {
  readonly code: CliErrorCode;
  /** 2 for a usage error, 1 for a runtime error. */
  readonly exitCode: 1 | 2;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = code === 'usage' ? 2 : 1;
  }
}

export function usage(message: string): CliError {
  return new CliError('usage', message);
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof CoreError) return new CliError(error.code, error.message);
  return new CliError('internal', error instanceof Error ? error.message : String(error));
}

/** One stderr line. The input path is added only when the message does not name it already. */
export function errorLine(error: CliError, input?: string): string {
  const named = !input || error.message.includes(input);
  return `error ${error.code}: ${named ? '' : `${input}: `}${error.message}`;
}
