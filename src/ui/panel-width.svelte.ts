import { readStored, removeStored, writeStored } from '../app/storage.ts';
import { TUNING } from '../app/tuning.ts';

const STORE_KEY = 'panelWidth';

/** A stored width in CSS pixels, or null when it is missing or not a number at or above the smallest width. */
export function parsePanelWidth(raw: string | null): number | null {
  const value = raw === null || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= TUNING.ui.panel.minPx ? Math.round(value) : null;
}

let width = $state<number | null>(parsePanelWidth(readStored(STORE_KEY)));

/** The width that the user gave to the side panels, the same on every screen; null keeps the width of each screen. */
export function panelWidth(): number | null {
  return width;
}

/** Changes the width at once. With `keep`, the width also stays for the next start. */
export function setPanelWidth(next: number, keep: boolean): void {
  width = Math.round(next);
  if (keep) writeStored(STORE_KEY, String(width));
}

/** Writes the current width for the next start, at the end of a drag. */
export function keepPanelWidth(): void {
  if (width !== null) writeStored(STORE_KEY, String(width));
}

/** Back to the width of each screen. */
export function resetPanelWidth(): void {
  width = null;
  removeStored(STORE_KEY);
}
