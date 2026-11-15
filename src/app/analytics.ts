/** The few parameter keys that every usage event shares, so the tag manager needs few variables. */
export interface TrackParams {
  kind?: string;
  value?: string | number | boolean;
  format?: string;
  width?: number;
  height?: number;
  count?: number;
  screen?: string;
}

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

/** Sends a usage event to the tag manager. Does nothing where the tag is not installed, and never throws. */
export function track(event: string, params?: TrackParams): void {
  try {
    window.dataLayer?.push({ event, ...params });
  } catch {
    // Analytics must never break the app.
  }
}

/** The lowercase extension of a file name, or `none`. */
export function formatOf(fileName: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  return match ? match[1].toLowerCase() : 'none';
}
