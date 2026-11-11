import { TRANSPARENT, alpha, blue, green, pack, red } from './color.ts';
import { PARAMS } from './params.ts';
import type { RasterImage, Sprite } from './types.ts';

const MAX_DISTANCE = 0xffff;

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

export function scaleNearest(sprite: Sprite, scale: number): RasterImage {
  const k = Math.max(1, Math.floor(scale));
  const { cols, rows, pixels } = sprite;
  const width = cols * k;
  const height = rows * k;
  const data = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let ty = 0; ty < rows; ty++) {
    const rowStart = ty * k * rowBytes;
    for (let tx = 0; tx < cols; tx++) {
      const color = pixels[ty * cols + tx];
      if (color === TRANSPARENT) continue;
      const r = red(color);
      const g = green(color);
      const b = blue(color);
      const a = alpha(color);
      for (let i = 0, o = rowStart + tx * k * 4; i < k; i++, o += 4) {
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = a;
      }
    }
    for (let i = 1; i < k; i++) data.copyWithin(rowStart + i * rowBytes, rowStart, rowStart + rowBytes);
  }
  return { width, height, data };
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
