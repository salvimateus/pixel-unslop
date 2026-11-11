import { TRANSPARENT, alpha, blue, green, pack, red } from './color.ts';
import { CoreError } from './errors.ts';
import { PARAMS } from './params.ts';
import type { RasterImage, Sprite } from './types.ts';

const MAX_DISTANCE = 0xffff;

/** Tolerance of the fractional area sums of a resample. */
const AREA_EPSILON = 1e-9;

/** 4-connected region of tiles with exactly the color of `start`. `distance` is the BFS step count from `start`, parallel to `indices`. */
export function floodRegion(sprite: Sprite, start: number): { indices: Int32Array; distance: Uint16Array } {
  const { cols, rows, pixels } = sprite;
  const total = cols * rows;
  if (!Number.isInteger(start) || start < 0 || start >= total) {
    return { indices: new Int32Array(0), distance: new Uint16Array(0) };
  }
  const color = pixels[start];
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  const steps = new Uint16Array(total);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const index = queue[head];
    const step = steps[head];
    head++;
    const x = index % cols;
    const next = step < MAX_DISTANCE ? step + 1 : MAX_DISTANCE;
    const visit = (neighbor: number) => {
      if (seen[neighbor] === 0 && pixels[neighbor] === color) {
        seen[neighbor] = 1;
        steps[tail] = next;
        queue[tail++] = neighbor;
      }
    };
    if (x > 0) visit(index - 1);
    if (x < cols - 1) visit(index + 1);
    if (index >= cols) visit(index - cols);
    if (index + cols < total) visit(index + cols);
  }
  return { indices: queue.slice(0, tail), distance: steps.slice(0, tail) };
}

function borderTiles(cols: number, rows: number): number[] {
  const tiles: number[] = [];
  if (cols <= 0 || rows <= 0) return tiles;
  for (let x = 0; x < cols; x++) tiles.push(x);
  if (rows > 1) for (let x = 0; x < cols; x++) tiles.push((rows - 1) * cols + x);
  for (let y = 1; y < rows - 1; y++) {
    tiles.push(y * cols);
    if (cols > 1) tiles.push(y * cols + cols - 1);
  }
  return tiles;
}

/** Tile indices of the background that touches the border. Empty when the border is already transparent or has no dominant color. */
export function borderBackground(sprite: Sprite): Int32Array {
  const { cols, rows, pixels } = sprite;
  const border = borderTiles(cols, rows);
  if (border.length === 0) return new Int32Array(0);
  const counts = new Map<number, number>();
  for (const tile of border) counts.set(pixels[tile], (counts.get(pixels[tile]) ?? 0) + 1);
  const { minBorderShare, maxColors } = PARAMS.background;
  if ((counts.get(TRANSPARENT) ?? 0) >= border.length / 2) return new Int32Array(0);
  const candidates = [...counts.entries()]
    .filter(([color, count]) => color !== TRANSPARENT && count >= minBorderShare * border.length)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, maxColors)
    .map(([color]) => color);
  if (candidates.length === 0) return new Int32Array(0);

  const total = cols * rows;
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let tail = 0;
  for (const tile of border) {
    if (seen[tile] === 0 && candidates.includes(pixels[tile])) {
      seen[tile] = 1;
      queue[tail++] = tile;
    }
  }
  // A fake checkerboard is islands of two colors, so the flood passes through every background color.
  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    const x = index % cols;
    const visit = (neighbor: number) => {
      if (seen[neighbor] === 0 && candidates.includes(pixels[neighbor])) {
        seen[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    };
    if (x > 0) visit(index - 1);
    if (x < cols - 1) visit(index + 1);
    if (index >= cols) visit(index - cols);
    if (index + cols < total) visit(index + cols);
  }
  return queue.slice(0, tail).sort();
}

export function indicesOfColor(pixels: Uint32Array, color: number): Int32Array {
  let count = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] === color) count++;
  const indices = new Int32Array(count);
  let n = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] === color) indices[n++] = i;
  return indices;
}

/** Unique colors with counts, sorted by count descending, then by value ascending. TRANSPARENT is not listed. */
export function listPalette(pixels: Uint32Array): Array<{ color: number; count: number }> {
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels.length; i++) {
    const color = pixels[i];
    if (color !== TRANSPARENT) counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count || a.color - b.color);
}

/** Bresenham line between two tiles, as flat x,y pairs, both ends included. */
export function lineTiles(x0: number, y0: number, x1: number, y1: number): Int32Array {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  const out = new Int32Array((Math.max(dx, -dy) + 1) * 2);
  let error = dx + dy;
  let x = x0;
  let y = y0;
  let n = 0;
  for (;;) {
    out[n++] = x;
    out[n++] = y;
    if (x === x1 && y === y1) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
  return out;
}

/** One image pixel per tile; TRANSPARENT becomes 0,0,0,0. */
export function spriteToRaster(sprite: Sprite): RasterImage {
  const { cols, rows, pixels } = sprite;
  const data = new Uint8ClampedArray(cols * rows * 4);
  for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
    const color = pixels[i];
    if (color === TRANSPARENT) continue;
    data[o] = red(color);
    data[o + 1] = green(color);
    data[o + 2] = blue(color);
    data[o + 3] = alpha(color);
  }
  return { width: cols, height: rows, data };
}

/** Converts a raster to a sprite: alpha below 128 becomes TRANSPARENT, every other pixel becomes opaque. */
export function spriteFromRaster(image: RasterImage, blockSize = 1): Sprite {
  const k = Math.max(1, Math.floor(blockSize));
  const cols = Math.floor(image.width / k);
  const rows = Math.floor(image.height / k);
  const pixels = new Uint32Array(cols * rows);
  const half = Math.floor(k / 2);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const o = ((ty * k + half) * image.width + tx * k + half) * 4;
      const d = image.data;
      pixels[ty * cols + tx] = d[o + 3] < 128 ? TRANSPARENT : pack(d[o], d[o + 1], d[o + 2]);
    }
  }
  return { cols, rows, pixels };
}

/** Crops to the box of the opaque tiles. Always returns a copy. Throws CoreError('empty-image') when no tile is opaque. */
export function trimSprite(sprite: Sprite): Sprite {
  const { cols, rows, pixels } = sprite;
  let left = cols;
  let right = -1;
  let top = rows;
  let bottom = -1;
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      if (pixels[row + x] === TRANSPARENT) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  if (right < 0) throw new CoreError('empty-image', 'The sprite has no opaque tile.');
  const outCols = right - left + 1;
  const outRows = bottom - top + 1;
  const out = new Uint32Array(outCols * outRows);
  for (let y = 0; y < outRows; y++) {
    const start = (top + y) * cols + left;
    out.set(pixels.subarray(start, start + outCols), y * outCols);
  }
  return { cols: outCols, rows: outRows, pixels: out };
}

function checkSide(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new CoreError('internal', `The ${name} must be a whole number of 1 or more (got ${value}).`);
}

/** Source tiles per result tile for a target height. A height that a whole reduction gives uses that whole step. */
export function heightStep(rows: number, height: number): number {
  checkSide(rows, 'row count');
  checkSide(height, 'height');
  if (height === rows) return 1;
  if (height < rows) {
    for (let k = 2; k <= PARAMS.sizing.maxReduction; k++) if (Math.ceil(rows / k) === height) return k;
    return rows / height;
  }
  return height % rows === 0 ? 1 / (height / rows) : rows / height;
}

export function resampledSize(cols: number, rows: number, step: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.ceil(cols / step - AREA_EPSILON)),
    rows: Math.max(1, Math.ceil(rows / step - AREA_EPSILON)),
  };
}

function withinLimits(size: { cols: number; rows: number }): boolean {
  const { maxExportSide, maxCells } = PARAMS.limits;
  return size.cols <= maxExportSide && size.rows <= maxExportSide && size.cols * size.rows <= maxCells;
}

/** Largest height whose result stays within the enlargement, export and cell limits. At least 1. */
export function heightLimit(cols: number, rows: number): number {
  checkSide(cols, 'column count');
  checkSide(rows, 'row count');
  const fits = (height: number) => withinLimits(resampledSize(cols, rows, heightStep(rows, height)));
  // The result size never shrinks when the height grows, so a binary search finds the limit.
  let low = 1;
  let high = rows * PARAMS.sizing.maxEnlargement;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The whole-number sizes, in this order: native (step 1), the 1/k reductions (height rounded up, step k)
 * and the k-times enlargements (step 1/k), with no repeated height. Each step equals heightStep(rows, height).
 * The native size is always listed; the other sizes only up to `limit`.
 */
export function wholeHeights(rows: number, limit: number): Array<{ height: number; step: number }> {
  checkSide(rows, 'row count');
  const sizes = [{ height: rows, step: 1 }];
  for (let k = 2; k <= PARAMS.sizing.maxReduction; k++) {
    const height = Math.ceil(rows / k);
    if (height <= limit && !sizes.some((size) => size.height === height)) sizes.push({ height, step: k });
  }
  for (let k = 2; k <= PARAMS.sizing.maxEnlargement; k++) {
    const height = rows * k;
    if (height <= limit) sizes.push({ height, step: 1 / k });
  }
  return sizes;
}

/** Integer luma; a lower value is a darker color. */
function luma(color: number): number {
  return 299 * red(color) + 587 * green(color) + 114 * blue(color);
}

/** Size of the result area that is outside the sprite on one axis. */
function padding(resultTiles: number, step: number, sourceTiles: number): number {
  const pad = resultTiles * step - sourceTiles;
  return pad < AREA_EPSILON ? 0 : pad;
}

/**
 * Each result tile takes the color with the largest area under it. `step` is the number of source tiles per
 * result tile (2 halves the sprite, 0.5 doubles it). The rows anchor at the bottom and the columns are centered.
 * A tile is transparent only when more than PARAMS.sizing.clearAbove of its square is transparent; the area
 * outside the sprite counts as transparent. Equal areas go to the darker color, then to the lower value.
 */
export function resampleSprite(sprite: Sprite, step: number): Sprite {
  if (!Number.isFinite(step) || !(step > 0)) throw new CoreError('internal', `Bad resample step ${step}.`);
  const { cols, rows, pixels } = sprite;
  const out = resampledSize(cols, rows, step);
  if (!withinLimits(out)) {
    throw new CoreError(
      'too-large',
      `The resized sprite would be ${out.cols} x ${out.rows} tiles; the limits are ${PARAMS.limits.maxExportSide} per side and ${PARAMS.limits.maxCells} tiles.`,
    );
  }
  const padX = padding(out.cols, step, cols);
  const padY = padding(out.rows, step, rows);
  // A whole step keeps whole-tile squares, so each source tile falls in exactly one result tile.
  const originX = Number.isInteger(step) ? -Math.floor(padX / 2) : -padX / 2;
  const originY = -padY;
  const area = step * step;
  const clearLimit = PARAMS.sizing.clearAbove * area + AREA_EPSILON;
  const result = new Uint32Array(out.cols * out.rows);
  const colors: number[] = [];
  const weights: number[] = [];

  for (let r = 0; r < out.rows; r++) {
    const y0 = originY + r * step;
    const y1 = y0 + step;
    const ty0 = Math.max(0, Math.floor(y0));
    const ty1 = Math.min(rows, Math.ceil(y1));
    for (let c = 0; c < out.cols; c++) {
      const x0 = originX + c * step;
      const x1 = x0 + step;
      const tx0 = Math.max(0, Math.floor(x0));
      const tx1 = Math.min(cols, Math.ceil(x1));
      colors.length = 0;
      weights.length = 0;
      let opaque = 0;
      for (let ty = ty0; ty < ty1; ty++) {
        const wy = Math.min(ty + 1, y1) - Math.max(ty, y0);
        if (wy <= 0) continue;
        const row = ty * cols;
        for (let tx = tx0; tx < tx1; tx++) {
          const color = pixels[row + tx];
          if (color === TRANSPARENT) continue;
          const wx = Math.min(tx + 1, x1) - Math.max(tx, x0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          opaque += weight;
          const index = colors.indexOf(color);
          if (index < 0) {
            colors.push(color);
            weights.push(weight);
          } else {
            weights[index] += weight;
          }
        }
      }
      if (opaque <= AREA_EPSILON || area - opaque > clearLimit) continue;
      let top = 0;
      for (const weight of weights) if (weight > top) top = weight;
      let winner = TRANSPARENT;
      let winnerLuma = Infinity;
      for (let i = 0; i < colors.length; i++) {
        if (weights[i] < top - AREA_EPSILON) continue;
        const candidate = colors[i];
        const candidateLuma = luma(candidate);
        if (candidateLuma < winnerLuma || (candidateLuma === winnerLuma && candidate < winner)) {
          winner = candidate;
          winnerLuma = candidateLuma;
        }
      }
      result[r * out.cols + c] = winner;
    }
  }
  return { cols: out.cols, rows: out.rows, pixels: result };
}
