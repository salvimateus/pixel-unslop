/** The few parameter keys that every usage event shares, so the tag manager needs few variables. */
export interface TrackParams {
  kind?: string;
  detail?: string | number | boolean;
  format?: string;
  width?: number;
  height?: number;
  count?: number;
  screen?: string;
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/** Sends a usage event through the `gtag` command of the tag snippet. Does nothing where the tag is not installed, and never throws. */
export function track(event: string, params?: TrackParams): void {
  try {
    window.gtag?.('event', event, params ?? {});
  } catch {
    // Analytics must never break the app.
  }
}

/** The lowercase extension of a file name, or `none`. */
export function formatOf(fileName: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  return match ? match[1].toLowerCase() : 'none';
}
