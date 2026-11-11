const PREFIX = 'pixel-unslop:';

/** localStorage keeps only conveniences, and it can be missing or blocked. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage is a convenience only: the app works the same without it.
  }
}
