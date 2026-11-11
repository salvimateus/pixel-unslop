/** Longest base name, so the full path stays short on Windows. */
export const MAX_BASE_NAME = 120;

export type FileNameProblem = 'empty' | 'chars' | 'end' | 'long' | 'reserved';

// Windows refuses these characters in a file name; the slashes also make a path.
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;
// Windows reserves these device names, also with an extension ("con.png", "com1.x").
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** The problem of a base name (no extension, already trimmed by `cleanBaseName`), or null when it is a valid file name. */
export function fileNameProblem(base: string): FileNameProblem | null {
  const name = base.trim();
  if (name.length === 0) return 'empty';
  if (FORBIDDEN.test(name)) return 'chars';
  if (/[. ]$/.test(name)) return 'end';
  if (RESERVED.test(name)) return 'reserved';
  if (name.length > MAX_BASE_NAME) return 'long';
  return null;
}

/** The base name without a `.png` that the user typed by habit. */
export function cleanBaseName(base: string): string {
  return base.trim().replace(/\.png$/i, '').trimEnd();
}
