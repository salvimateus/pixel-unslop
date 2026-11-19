import { TRANSPARENT } from './color.ts';
import { CoreError } from './errors.ts';
import { applyColorMap, combinedColors, matchColors, unifyPalettes, type ColorCount } from './palette.ts';
import { borderBackground, eraseTiles, holdsScenery, opaqueBox, type TileBox } from './sprite.ts';
import type { Sprite } from './types.ts';

/** 'full' keeps the grid, 'crop' keeps the common box of the drawing, 'feet' stands every frame on one pivot. */
export type CellMode = 'full' | 'crop' | 'feet';

export interface FrameOptions {
  /** The active preset strength: the frames already merged their own colors at this strength. */
  strength: number;
  /** listPalette of the reference frame's own sprite, or null. */
  reference: readonly ColorCount[] | null;
  eraseBackground: boolean;
  cell: CellMode;
}

export interface BuiltFrames {
  /** Every frame has cols = cell.cols and rows = cell.rows. */
  frames: Sprite[];
  cell: { cols: number; rows: number };
  /** Per frame: the erase kept a scenery background. Always false when eraseBackground is off. */
  kept: boolean[];
}

/** The tiles of `sprite` inside `box`, placed at `x`,`y` of a transparent sprite of `cols` x `rows`. */
function placeBox(sprite: Sprite, box: TileBox, cols: number, rows: number, x: number, y: number): Sprite {
  const pixels = new Uint32Array(cols * rows);
  for (let r = 0; r < box.rows; r++) {
    const start = (box.row + r) * sprite.cols + box.col;
    pixels.set(sprite.pixels.subarray(start, start + box.cols), (y + r) * cols + x);
  }
  return { cols, rows, pixels };
}

function unionBox(boxes: ReadonlyArray<TileBox | null>): TileBox | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    if (!box) continue;
    left = Math.min(left, box.col);
    top = Math.min(top, box.row);
    right = Math.max(right, box.col + box.cols - 1);
    bottom = Math.max(bottom, box.row + box.rows - 1);
  }
  return right < left ? null : { col: left, row: top, cols: right - left + 1, rows: bottom - top + 1 };
}

/**
 * The pivot column of a frame: the mean column of its opaque tiles, rounded half down. The mean follows the body,
 * so a swinging arm or weapon moves it less than it moves the box center.
 */
function pivotColumn(sprite: Sprite, box: TileBox): number {
  const { cols, pixels } = sprite;
  let sum = 0;
  let count = 0;
  for (let y = box.row; y < box.row + box.rows; y++) {
    for (let x = box.col; x < box.col + box.cols; x++) {
      if (pixels[y * cols + x] === TRANSPARENT) continue;
      sum += x;
      count++;
    }
  }
  return Math.ceil(sum / count - 0.5);
}

function feetFrames(sprites: readonly Sprite[], boxes: ReadonlyArray<TileBox | null>): { frames: Sprite[]; cols: number; rows: number } {
  const pivots = sprites.map((sprite, i) => {
    const box = boxes[i];
    return box ? pivotColumn(sprite, box) : 0;
  });
  let left = 0;
  let right = 0;
  let up = 0;
  boxes.forEach((box, i) => {
    if (!box) return;
    left = Math.max(left, pivots[i] - box.col);
    right = Math.max(right, box.col + box.cols - 1 - pivots[i]);
    up = Math.max(up, box.rows - 1);
  });
  const cols = left + 1 + right;
  const rows = up + 1;
  const frames = sprites.map((sprite, i) => {
    const box = boxes[i];
    if (!box) return { cols, rows, pixels: new Uint32Array(cols * rows) };
    return placeBox(sprite, box, cols, rows, left - (pivots[i] - box.col), rows - box.rows);
  });
  return { frames, cols, rows };
}

/**
 * The frames of one animation as equal cells with one palette. The inputs are the own sprites of the frames, all
 * on one grid and already merged at `strength`. With a reference, one color map serves every frame, so a color
 * never flickers between two reference colors.
 */
export function buildFrames(owns: readonly Sprite[], options: FrameOptions): BuiltFrames {
  if (owns.length === 0) return { frames: [], cell: { cols: 0, rows: 0 }, kept: [] };
  const { cols, rows } = owns[0];
  if (owns.some((sprite) => sprite.cols !== cols || sprite.rows !== rows || sprite.pixels.length !== cols * rows)) {
    throw new CoreError('internal', 'The frames of an animation must have the same grid size.');
  }
  let sprites = unifyPalettes([...owns], { strength: options.strength });
  if (options.reference && options.reference.length > 0) {
    const map = matchColors(combinedColors(sprites), options.reference);
    sprites = sprites.map((sprite) => applyColorMap(sprite, map));
  }
  const kept = sprites.map(() => false);
  if (options.eraseBackground) {
    sprites = sprites.map((sprite, i) => {
      const background = borderBackground(sprite);
      const erased = background.length > 0 ? eraseTiles(sprite, background) : sprite;
      kept[i] = holdsScenery(erased, background.length > 0);
      return erased;
    });
  }
  const boxes = sprites.map(opaqueBox);
  const union = unionBox(boxes);
  if (options.cell === 'full' || !union) return { frames: sprites, cell: { cols, rows }, kept };
  if (options.cell === 'crop') {
    const frames = sprites.map((sprite) => placeBox(sprite, union, union.cols, union.rows, 0, 0));
    return { frames, cell: { cols: union.cols, rows: union.rows }, kept };
  }
  if (options.cell !== 'feet') throw new CoreError('internal', `Unknown cell mode ${String(options.cell)}.`);
  const feet = feetFrames(sprites, boxes);
  return { frames: feet.frames, cell: { cols: feet.cols, rows: feet.rows }, kept };
}
