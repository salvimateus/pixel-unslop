import { TRANSPARENT } from './color.ts';
import { CoreError } from './errors.ts';
import { applyColorMap, combinedColors, matchColors, unifyPalettes, type ColorCount } from './palette.ts';
import { PARAMS } from './params.ts';
import { borderBackground, eraseTiles, holdsScenery, opaqueBox, type TileBox } from './sprite.ts';
import type { Sprite } from './types.ts';

/**
 * 'full' keeps the grid, 'crop' keeps the common box of the drawing, 'feet' stands every frame on one pivot and
 * 'box' keeps a box that the user drew on the grid.
 */
export type CellMode = 'full' | 'crop' | 'feet' | 'box';

/** Whole tiles. The content of a frame moves by this amount in the output: positive x moves it right, positive y moves it down. */
export interface FrameOffset {
  x: number;
  y: number;
}

export interface PreparedFrames {
  /** One palette for all frames, on the full grid. */
  frames: Sprite[];
  /** Per frame: the erase kept a scenery background. Always false when eraseBackground is off. */
  kept: boolean[];
}

export interface Placement {
  cell: CellMode;
  /** Per frame; a missing entry is no move. */
  offsets?: readonly FrameOffset[];
  /** The kept box of 'box', in grid tiles. It may extend past the grid edges. */
  box?: TileBox | null;
}

export interface FrameOptions {
  /** The active preset strength: the frames already merged their own colors at this strength. */
  strength: number;
  /** listPalette of the reference frame's own sprite, or null. */
  reference: readonly ColorCount[] | null;
  eraseBackground: boolean;
  cell: CellMode;
  offsets?: readonly FrameOffset[];
  box?: TileBox | null;
}

export interface BuiltFrames {
  /** Every frame has cols = cell.cols and rows = cell.rows. */
  frames: Sprite[];
  cell: { cols: number; rows: number };
  /** Per frame: the erase kept a scenery background. Always false when eraseBackground is off. */
  kept: boolean[];
}

function checkSameSize(frames: readonly Sprite[]): { cols: number; rows: number } {
  const { cols, rows } = frames[0];
  if (frames.some((sprite) => sprite.cols !== cols || sprite.rows !== rows || sprite.pixels.length !== cols * rows)) {
    throw new CoreError('internal', 'The frames of an animation must have the same grid size.');
  }
  return { cols, rows };
}

/**
 * The palette work of an animation. The inputs are the own sprites of the frames, all on one grid and already
 * merged at `strength`. With a reference, one color map serves every frame, so a color never flickers between two
 * reference colors.
 */
export function prepareFrames(
  owns: readonly Sprite[],
  options: { strength: number; reference: readonly ColorCount[] | null; eraseBackground: boolean },
): PreparedFrames {
  if (owns.length === 0) return { frames: [], kept: [] };
  checkSameSize(owns);
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
  return { frames: sprites, kept };
}

function offsetsOf(count: number, offsets: readonly FrameOffset[] | undefined): FrameOffset[] {
  const result: FrameOffset[] = [];
  for (let i = 0; i < count; i++) {
    const offset = offsets?.[i] ?? { x: 0, y: 0 };
    if (!Number.isInteger(offset.x) || !Number.isInteger(offset.y)) {
      throw new CoreError('internal', `The offset of frame ${i} must be whole tiles (got ${offset.x}, ${offset.y}).`);
    }
    result.push({ x: offset.x, y: offset.y });
  }
  return result;
}

function checkBox(box: TileBox | null | undefined): TileBox {
  if (!box) throw new CoreError('internal', "The 'box' cell needs a box.");
  if (!Number.isInteger(box.col) || !Number.isInteger(box.row)) throw new CoreError('internal', 'The box position must be whole tiles.');
  if (!Number.isInteger(box.cols) || !Number.isInteger(box.rows) || box.cols < 1 || box.rows < 1) {
    throw new CoreError('internal', 'The box size must be whole tiles, 1 or more on each side.');
  }
  return box;
}

function checkCell(cols: number, rows: number): void {
  const max = PARAMS.limits.maxExportSide;
  if (cols > max || rows > max) throw new CoreError('too-large', `The frame cell would be ${cols} x ${rows} tiles; the limit is ${max} per side.`);
}

/** Output tile (c, r) = source tile (box.col + c - dx, box.row + r - dy); TRANSPARENT outside the source grid. */
function windowOf(sprite: Sprite, box: TileBox, dx: number, dy: number): Sprite {
  const { cols, rows } = box;
  const pixels = new Uint32Array(cols * rows);
  const x0 = box.col - dx;
  const c0 = Math.max(0, -x0);
  const c1 = Math.min(cols, sprite.cols - x0);
  if (c1 > c0) {
    for (let r = 0; r < rows; r++) {
      const y = box.row + r - dy;
      if (y < 0 || y >= sprite.rows) continue;
      const start = y * sprite.cols + x0;
      pixels.set(sprite.pixels.subarray(start + c0, start + c1), r * cols + c0);
    }
  }
  return { cols, rows, pixels };
}

/** The smallest box that holds every box; null when none is given. */
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

/** `limited`: the cell is a user box or holds moved frames, so its size is checked against the export limit. */
function windows(
  frames: readonly Sprite[],
  box: TileBox,
  shifts: readonly FrameOffset[],
  limited: boolean,
): { frames: Sprite[]; cell: { cols: number; rows: number } } {
  if (limited) checkCell(box.cols, box.rows);
  return { frames: frames.map((sprite, i) => windowOf(sprite, box, shifts[i].x, shifts[i].y)), cell: { cols: box.cols, rows: box.rows } };
}

/**
 * The cell step of an animation: equal cells from prepared frames, each moved by its offset. It does no palette
 * work, so a drag can call it on every pointer move.
 */
export function placeFrames(frames: readonly Sprite[], placement: Placement): { frames: Sprite[]; cell: { cols: number; rows: number } } {
  if (frames.length === 0) return { frames: [], cell: { cols: 0, rows: 0 } };
  const { cols, rows } = checkSameSize(frames);
  const offsets = offsetsOf(frames.length, placement.offsets);
  const grid: TileBox = { col: 0, row: 0, cols, rows };
  const moved = offsets.some((offset) => offset.x !== 0 || offset.y !== 0);
  switch (placement.cell) {
    case 'box':
      return windows(frames, checkBox(placement.box), offsets, true);
    case 'full':
      return windows(frames, grid, offsets, false);
    case 'crop': {
      const boxes = frames.map((sprite, i) => {
        const box = opaqueBox(sprite);
        return box && { col: box.col + offsets[i].x, row: box.row + offsets[i].y, cols: box.cols, rows: box.rows };
      });
      return windows(frames, unionBox(boxes) ?? grid, offsets, moved);
    }
    case 'feet': {
      // Each frame first moves its pivot (bottom row, pivot column) to 0,0, then by its offset.
      const boxes = frames.map(opaqueBox);
      if (boxes.every((box) => box === null)) return windows(frames, grid, offsets, false);
      const shifts = boxes.map((box, i) => {
        if (!box) return offsets[i];
        return { x: offsets[i].x - pivotColumn(frames[i], box), y: offsets[i].y - (box.row + box.rows - 1) };
      });
      const placed = boxes.map((box, i) => box && { col: box.col + shifts[i].x, row: box.row + shifts[i].y, cols: box.cols, rows: box.rows });
      return windows(frames, unionBox(placed) as TileBox, shifts, moved);
    }
    default:
      throw new CoreError('internal', `Unknown cell mode ${String(placement.cell)}.`);
  }
}

/** The frames of one animation as equal cells with one palette: prepareFrames, then placeFrames. */
export function buildFrames(owns: readonly Sprite[], options: FrameOptions): BuiltFrames {
  if (owns.length === 0) return { frames: [], cell: { cols: 0, rows: 0 }, kept: [] };
  const prepared = prepareFrames(owns, options);
  const placed = placeFrames(prepared.frames, { cell: options.cell, offsets: options.offsets, box: options.box });
  return { frames: placed.frames, cell: placed.cell, kept: prepared.kept };
}
