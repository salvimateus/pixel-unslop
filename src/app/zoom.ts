import { TUNING } from './tuning.ts';
import { readStored, writeStored } from './storage.ts';
import type { LogicalArea } from './platform.ts';

/**
 * Interface zoom of the desktop window, in whole percent, in steps of TUNING.ui.zoom.step. The browser keeps its
 * own zoom, so this is desktop only.
 */

const STORE_KEY = 'uiZoom';

export type ZoomMove = 'in' | 'out' | 'reset';

/**
 * The zoom of the first start: the larger default only when the work area holds the smallest layout at that
 * zoom (1200 x 800 at 125%), else 100%. An unknown work area takes the larger default.
 */
export function defaultZoom(workArea: LogicalArea | null): number {
  const { minViewport } = TUNING.ui;
  const larger = TUNING.ui.zoom.default;
  if (!workArea) return larger;
  const fits = workArea.width >= (minViewport.width * larger) / 100 && workArea.height >= (minViewport.height * larger) / 100;
  return fits ? larger : 100;
}

/** The nearest step inside the range: a saved value of 123 becomes 125. */
export function snapZoom(percent: number): number {
  const { min, max, step } = TUNING.ui.zoom;
  return Math.min(max, Math.max(min, Math.round(percent / step) * step));
}

/** The zoom after a key press: one step up or down, held at the ends of the range, or `fallback` for a reset. */
export function nextZoom(current: number, move: ZoomMove, fallback: number): number {
  if (move === 'reset') return fallback;
  return snapZoom(snapZoom(current) + (move === 'in' ? 1 : -1) * TUNING.ui.zoom.step);
}

/** A stored value as a step, or `fallback` when the value is missing or not a number above 0. */
export function parseZoom(raw: string | null, fallback: number): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? snapZoom(value) : fallback;
}

/** The zoom that the user kept, or `fallback`. */
export function storedZoom(fallback: number): number {
  return parseZoom(readStored(STORE_KEY), fallback);
}

export function storeZoom(percent: number): void {
  writeStored(STORE_KEY, String(percent));
}

/** The move of a key press with Ctrl (or Cmd), or null for another key. Also the numpad keys. */
export function zoomMoveOf(event: KeyboardEvent): ZoomMove | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'in';
  if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') return 'out';
  if (event.key === '0' || event.code === 'Numpad0') return 'reset';
  return null;
}
