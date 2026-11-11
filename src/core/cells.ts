import { TRANSPARENT, pack } from './color.ts';
import { PARAMS } from './params.ts';
import type { CellGrid, RasterImage, Sprite } from './types.ts';

/** Coverage of the pixels [p, p + 1) by the span [start, end), for the pixels the span touches. */
interface Coverage { first: number; weights: Float64Array }

function coverage(start: number, end: number, size: number): Coverage {
  const lo = Math.max(0, start);
  const hi = Math.min(size, end);
  if (!(hi > lo)) return { first: 0, weights: new Float64Array(0) };
  const first = Math.floor(lo);
  const last = Math.min(size - 1, Math.ceil(hi) - 1);
  const weights = new Float64Array(last - first + 1);
  for (let p = first; p <= last; p++) weights[p - first] = Math.max(0, Math.min(hi, p + 1) - Math.max(lo, p));
  return { first, weights };
}

/** Reusable buffers for the vote of one tile. */
class TileVote {
  private readonly binsA = new Float64Array(512);
  private readonly binsB = new Float64Array(729);
  private readonly touchedA: number[] = [];
  private readonly touchedB: number[] = [];
  readonly offsets: number[] = [];
  readonly weights: number[] = [];

  reset(): void {
    for (const i of this.touchedA) this.binsA[i] = 0;
    for (const i of this.touchedB) this.binsB[i] = 0;
    this.touchedA.length = 0;
    this.touchedB.length = 0;
    this.offsets.length = 0;
    this.weights.length = 0;
  }

  /** Collects the pixels of one rectangle. Returns the weights of transparent and opaque pixels. */
  collect(image: RasterImage, xs: Coverage, ys: Coverage): { clear: number; opaque: number } {
    const { data, width } = image;
    const { alphaCut, binShift, binOffset } = PARAMS.cells;
    let clear = 0;
    let opaque = 0;
    for (let j = 0; j < ys.weights.length; j++) {
      const wy = ys.weights[j];
      if (wy <= 0) continue;
      const row = (ys.first + j) * width;
      for (let i = 0; i < xs.weights.length; i++) {
        const w = xs.weights[i] * wy;
        if (w <= 0) continue;
        const o = (row + xs.first + i) * 4;
        if (data[o + 3] < alphaCut) {
          clear += w;
          continue;
        }
        opaque += w;
        const r = data[o];
        const g = data[o + 1];
        const b = data[o + 2];
        const a = ((r >> binShift) << 6) | ((g >> binShift) << 3) | (b >> binShift);
        const bb = (((r + binOffset) >> binShift) * 9 + ((g + binOffset) >> binShift)) * 9 + ((b + binOffset) >> binShift);
        if (this.binsA[a] === 0) this.touchedA.push(a);
        if (this.binsB[bb] === 0) this.touchedB.push(bb);
        this.binsA[a] += w;
        this.binsB[bb] += w;
        this.offsets.push(o);
        this.weights.push(w);
      }
    }
    return { clear, opaque };
  }

  /** The heaviest bin of A and B. Ties: A before B, then the lower index. */
  winner(): { histogram: 'a' | 'b'; index: number; weight: number } {
    let histogram: 'a' | 'b' = 'a';
    let index = -1;
    let weight = -1;
    for (const i of this.touchedA) {
      const w = this.binsA[i];
      if (w > weight || (w === weight && i < index)) {
        weight = w;
        index = i;
      }
    }
    for (const i of this.touchedB) {
      const w = this.binsB[i];
      if (w > weight || (w === weight && histogram === 'b' && i < index)) {
        weight = w;
        index = i;
        histogram = 'b';
      }
    }
    return { histogram, index, weight };
  }
}

function inBin(data: Uint8ClampedArray, o: number, histogram: 'a' | 'b', index: number): boolean {
  const { binShift, binOffset } = PARAMS.cells;
  const r = data[o];
  const g = data[o + 1];
  const b = data[o + 2];
  if (histogram === 'a') return (((r >> binShift) << 6) | ((g >> binShift) << 3) | (b >> binShift)) === index;
  return ((((r + binOffset) >> binShift) * 9 + ((g + binOffset) >> binShift)) * 9 + ((b + binOffset) >> binShift)) === index;
}

const channelHistogram = new Float64Array(256);

/** Weighted lower median of one channel over the selected pixels. */
function weightedMedian(data: Uint8ClampedArray, offsets: number[], weights: number[], channel: number, half: number): number {
  const histogram = channelHistogram;
  histogram.fill(0);
  for (let i = 0; i < offsets.length; i++) histogram[data[offsets[i] + channel]] += weights[i];
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    sum += histogram[v];
    if (sum >= half) return v;
  }
  return 255;
}

function medianColor(data: Uint8ClampedArray, offsets: number[], weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  const half = total / 2;
  return pack(weightedMedian(data, offsets, weights, 0, half), weightedMedian(data, offsets, weights, 1, half), weightedMedian(data, offsets, weights, 2, half));
}

/**
 * One flat color per cell: the largest color area of the cell core wins.
 * The border of each cell (innerMargin) does not vote, because the blur of the source sits there.
 */
export function sampleCells(image: RasterImage, grid: CellGrid, onProgress?: (ratio: number) => void): Sprite {
  const cols = grid.x.length - 1;
  const rows = grid.y.length - 1;
  const pixels = new Uint32Array(cols * rows);
  const { innerMargin, minCoreWeight, transparentShare, minWinnerShare } = PARAMS.cells;
  const vote = new TileVote();
  const coreX: Coverage[] = [];
  const fullX: Coverage[] = [];
  for (let c = 0; c < cols; c++) {
    const x0 = grid.x[c];
    const x1 = grid.x[c + 1];
    const m = (x1 - x0) * innerMargin;
    coreX.push(coverage(x0 + m, x1 - m, image.width));
    fullX.push(coverage(x0, x1, image.width));
  }
  for (let r = 0; r < rows; r++) {
    const y0 = grid.y[r];
    const y1 = grid.y[r + 1];
    const m = (y1 - y0) * innerMargin;
    const coreY = coverage(y0 + m, y1 - m, image.height);
    const fullY = coverage(y0, y1, image.height);
    for (let c = 0; c < cols; c++) {
      vote.reset();
      let weights = vote.collect(image, coreX[c], coreY);
      if (weights.clear + weights.opaque < minCoreWeight) {
        vote.reset();
        weights = vote.collect(image, fullX[c], fullY);
      }
      const total = weights.clear + weights.opaque;
      if (total <= 0 || weights.clear >= transparentShare * total) {
        pixels[r * cols + c] = TRANSPARENT;
        continue;
      }
      const win = vote.winner();
      let offsets = vote.offsets;
      let selected = vote.weights;
      if (win.weight >= minWinnerShare * weights.opaque) {
        offsets = [];
        selected = [];
        for (let i = 0; i < vote.offsets.length; i++) {
          if (inBin(image.data, vote.offsets[i], win.histogram, win.index)) {
            offsets.push(vote.offsets[i]);
            selected.push(vote.weights[i]);
          }
        }
      }
      pixels[r * cols + c] = medianColor(image.data, offsets, selected);
    }
    if (onProgress && (r & 15) === 15) onProgress((r + 1) / rows);
  }
  return { cols, rows, pixels };
}

/** Block size of the aligned image: close to the source size, at least 1. */
export function alignedBlock(fitPeriodX: number, fitPeriodY: number, cols: number, rows: number): number {
  const target = Math.max(1, Math.round((fitPeriodX + fitPeriodY) / 2));
  const limit = Math.floor(PARAMS.limits.maxExportSide / Math.max(cols, rows));
  return Math.max(1, Math.min(target, limit));
}

/**
 * The source resampled so that each cell is a uniform `block` x `block` square, for the before/after
 * comparison: each output pixel takes the nearest source pixel at the same relative place of its cell.
 */
export function alignedImage(image: RasterImage, grid: CellGrid, block: number): RasterImage {
  const cols = grid.x.length - 1;
  const rows = grid.y.length - 1;
  const width = cols * block;
  const height = rows * block;
  const data = new Uint8ClampedArray(width * height * 4);
  const sourceX = new Int32Array(width);
  const sourceY = new Int32Array(height);
  const place = (bounds: Float64Array, index: number, size: number) => {
    const cell = Math.floor(index / block);
    const t = ((index % block) + 0.5) / block;
    const v = Math.floor(bounds[cell] + t * (bounds[cell + 1] - bounds[cell]));
    return Math.max(0, Math.min(size - 1, v));
  };
  for (let x = 0; x < width; x++) sourceX[x] = place(grid.x, x, image.width);
  for (let y = 0; y < height; y++) sourceY[y] = place(grid.y, y, image.height);
  for (let y = 0; y < height; y++) {
    const row = sourceY[y] * image.width;
    for (let x = 0; x < width; x++) {
      const s = (row + sourceX[x]) * 4;
      const o = (y * width + x) * 4;
      data[o] = image.data[s];
      data[o + 1] = image.data[s + 1];
      data[o + 2] = image.data[s + 2];
      data[o + 3] = image.data[s + 3];
    }
  }
  return { width, height, data };
}
