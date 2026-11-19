import { CoreError } from './errors.ts';
import { PARAMS } from './params.ts';
import type { Sprite } from './types.ts';

export interface SheetLayout {
  columns: number;
  rows: number;
  cellW: number;
  cellH: number;
  width: number;
  height: number;
}

export interface SheetMeta {
  /** The file name of the sheet image. */
  image: string;
  /** The animation name: the frame keys are "<name>-<i>". */
  name: string;
  fps: number;
  loop: boolean;
  app: string;
  version: string;
}

/** Row-major cells with no padding. `columns` is clamped to [1, count]. */
export function sheetLayout(count: number, cellW: number, cellH: number, columns: number): SheetLayout {
  const total = Math.max(0, Math.floor(count));
  const wanted = Number.isFinite(columns) ? Math.floor(columns) : 1;
  const cols = Math.min(Math.max(1, wanted), Math.max(1, total));
  const rows = total > 0 ? Math.ceil(total / cols) : 0;
  return { columns: cols, rows, cellW, cellH, width: total > 0 ? cols * cellW : 0, height: rows * cellH };
}

function fits(layout: SheetLayout): boolean {
  return layout.width <= PARAMS.limits.maxExportSide && layout.height <= PARAMS.limits.maxExportSide;
}

/**
 * The default column count: one row when it fits the export limit, else the layout that fits and is nearest to a
 * square sheet (fewer empty cells on a tie). Throws CoreError('too-large') when no layout fits.
 */
export function fitColumns(count: number, cellW: number, cellH: number): number {
  const total = Math.max(0, Math.floor(count));
  if (total === 0) return 1;
  const max = PARAMS.limits.maxExportSide;
  if (cellH <= max && total * cellW <= max) return total;
  let best = 0;
  let bestScore = Infinity;
  let bestEmpty = Infinity;
  for (let columns = 1; columns <= total; columns++) {
    const layout = sheetLayout(total, cellW, cellH, columns);
    if (!fits(layout)) continue;
    const score = Math.abs(Math.log(layout.width / layout.height));
    const empty = layout.columns * layout.rows - total;
    if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && empty < bestEmpty)) {
      best = columns;
      bestScore = score;
      bestEmpty = empty;
    }
  }
  if (best === 0) {
    throw new CoreError('too-large', `${total} frames of ${cellW} x ${cellH} do not fit in a sheet of ${max} pixels per side.`);
  }
  return best;
}

/** Packs equal frames row-major, with no padding. One image pixel per tile. */
export function packSheet(frames: readonly Sprite[], columns: number): { sprite: Sprite; layout: SheetLayout } {
  if (frames.length === 0) throw new CoreError('internal', 'A sheet needs at least one frame.');
  const { cols: cellW, rows: cellH } = frames[0];
  if (frames.some((frame) => frame.cols !== cellW || frame.rows !== cellH || frame.pixels.length !== cellW * cellH)) {
    throw new CoreError('internal', 'The frames of a sheet must have the same size.');
  }
  const layout = sheetLayout(frames.length, cellW, cellH, columns);
  const max = PARAMS.limits.maxExportSide;
  if (!fits(layout)) {
    throw new CoreError('too-large', `The sheet would be ${layout.width} x ${layout.height} pixels; the limit is ${max} per side.`);
  }
  const pixels = new Uint32Array(layout.width * layout.height);
  frames.forEach((frame, i) => {
    const x0 = (i % layout.columns) * cellW;
    const y0 = Math.floor(i / layout.columns) * cellH;
    for (let y = 0; y < cellH; y++) pixels.set(frame.pixels.subarray(y * cellW, (y + 1) * cellW), (y0 + y) * layout.width + x0);
  });
  return { sprite: { cols: layout.width, rows: layout.height, pixels }, layout };
}

/** Whole milliseconds per frame whose sum stays the exact length of the loop at `fps`. */
function frameDurations(count: number, fps: number): number[] {
  if (!Number.isFinite(fps) || fps <= 0) throw new CoreError('internal', `The frame rate must be a positive number (got ${fps}).`);
  const at = (i: number) => Math.round((i * 1000) / fps);
  return Array.from({ length: count }, (_, i) => at(i + 1) - at(i));
}

/**
 * TexturePacker "JSON hash" of a sheet, read by Phaser and Pixi. `animations` is the Pixi key and
 * `meta.frameTags` the Aseprite key.
 */
export function sheetJson(layout: SheetLayout, count: number, meta: SheetMeta): string {
  const total = Math.max(0, Math.floor(count));
  const durations = frameDurations(total, meta.fps);
  const { columns, cellW: w, cellH: h } = layout;
  const keys: string[] = [];
  const frames: Record<string, unknown> = {};
  for (let i = 0; i < total; i++) {
    const key = `${meta.name}-${i}`;
    keys.push(key);
    frames[key] = {
      frame: { x: (i % columns) * w, y: Math.floor(i / columns) * h, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
      duration: durations[i],
    };
  }
  const document = {
    frames,
    animations: { [meta.name]: keys },
    meta: {
      app: meta.app,
      version: meta.version,
      image: meta.image,
      format: 'RGBA8888',
      size: { w: layout.width, h: layout.height },
      scale: '1',
      frameTags: [{ name: meta.name, from: 0, to: total - 1, direction: 'forward' }],
      fps: meta.fps,
      loop: meta.loop,
    },
  };
  return JSON.stringify(document, null, 2);
}
