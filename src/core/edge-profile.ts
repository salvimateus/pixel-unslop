import { PARAMS } from './params.ts';
import type { RasterImage } from './types.ts';

/**
 * Edge evidence of one axis.
 * - `profile[i]`: summed edge energy on the boundary between pixel i and pixel i + 1 (bound position i + 1).
 * - `peaks`: the edges as sub-pixel positions. Each local maximum of the edge energy along a line is
 *   placed with a parabola fit, so a blurred edge keeps its true position and a fractional period
 *   does not alias. Bin j holds the weight of the edges at position j / PARAMS.edges.binsPerPixel.
 */
export interface AxisEdges {
  length: number;
  profile: Float64Array;
  peaks: Float64Array;
  /** Sum of the peak weights. */
  peakWeight: number;
  /** (sum of weights)^2 / sum of squared weights: the number of edges that carry the weight. */
  effectiveCount: number;
  /** Share of the peak weight on sharp edges (no blur on either side). */
  sharpShare: number;
}

export interface EdgeProfiles {
  x: AxisEdges;
  y: AxisEdges;
  /** Distinct opaque colors, counted up to PARAMS.pitch.nativeMaxColors + 1. */
  colorCount: number;
}

function countColors(image: RasterImage, limit: number): number {
  const seen = new Set<number>();
  const { data } = image;
  for (let i = 0; i < data.length && seen.size <= limit; i += 4) {
    if (data[i + 3] >= 128) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return seen.size;
}

/** Premultiplied RGBA as floats, so transparent pixels with garbage RGB add no edge energy. */
function premultiply(image: RasterImage): Float32Array {
  const { data } = image;
  const pre = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    const f = a / 255;
    pre[i] = data[i] * f;
    pre[i + 1] = data[i + 1] * f;
    pre[i + 2] = data[i + 2] * f;
    pre[i + 3] = a;
  }
  return pre;
}

/** Energy (L1 of premultiplied RGBA) between the pixels at byte offsets o and n. */
function energyAt(pre: Float32Array, o: number, n: number): number {
  return Math.abs(pre[o] - pre[n]) + Math.abs(pre[o + 1] - pre[n + 1]) + Math.abs(pre[o + 2] - pre[n + 2]) + Math.abs(pre[o + 3] - pre[n + 3]);
}

const ENERGY_BUCKETS = 2048;

/**
 * Noise level of the image: the median energy between neighbor pixels that are not both transparent.
 * The edge threshold follows it, so a noisy image does not turn its noise into edges and a smooth
 * (upscaled) image keeps its soft edges.
 */
function edgeThreshold(pre: Float32Array, width: number, height: number): number {
  const counts = new Float64Array(ENERGY_BUCKETS);
  let total = 0;
  const add = (o: number, n: number) => {
    if (pre[o + 3] === 0 && pre[n + 3] === 0) return;
    counts[Math.min(ENERGY_BUCKETS - 1, Math.round(energyAt(pre, o, n)))]++;
    total++;
  };
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const o = (row * width + col) * 4;
      if (col + 1 < width) add(o, o + 4);
      if (row + 1 < height) add(o, o + width * 4);
    }
  }
  let median = 0;
  for (let sum = 0; median < ENERGY_BUCKETS; median++) {
    sum += counts[median];
    if (sum >= total / 2) break;
  }
  const { noiseFactor, minThreshold, maxThreshold } = PARAMS.edges;
  return Math.min(maxThreshold, Math.max(minThreshold, noiseFactor * median));
}

function axisEdges(pre: Float32Array, width: number, height: number, axis: 'x' | 'y', peakThreshold: number): AxisEdges {
  const length = axis === 'x' ? width : height;
  const lines = axis === 'x' ? height : width;
  const step = axis === 'x' ? 4 : width * 4;
  const lineStep = axis === 'x' ? width * 4 : 4;
  const { binsPerPixel, sharpRatio } = PARAMS.edges;
  const profile = new Float64Array(Math.max(0, length - 1));
  const peaks = new Float64Array((length + 1) * binsPerPixel);
  // energy[b] is the edge energy at bound position b (between pixel b - 1 and pixel b).
  const energy = new Float64Array(length + 1);
  let weight = 0;
  let squared = 0;
  let sharp = 0;
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    for (let i = 0; i + 1 < length; i++) {
      const o = base + i * step;
      const e = energyAt(pre, o, o + step);
      energy[i + 1] = e;
      profile[i] += e;
    }
    for (let b = 1; b < length; b++) {
      const center = energy[b];
      if (center <= peakThreshold) continue;
      const left = energy[b - 1];
      const right = energy[b + 1];
      if (!(center > left && center >= right)) continue;
      const curve = left - 2 * center + right;
      const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curve)) : 0;
      const w = center - peakThreshold;
      peaks[Math.round((b + shift) * binsPerPixel)] += w;
      weight += w;
      squared += w * w;
      if (left <= sharpRatio * center && right <= sharpRatio * center) sharp += w;
    }
  }
  return {
    length,
    profile,
    peaks,
    peakWeight: weight,
    effectiveCount: squared > 0 ? (weight * weight) / squared : 0,
    sharpShare: weight > 0 ? sharp / weight : 0,
  };
}

export function computeProfiles(image: RasterImage): EdgeProfiles {
  const pre = premultiply(image);
  const threshold = edgeThreshold(pre, image.width, image.height);
  return {
    x: axisEdges(pre, image.width, image.height, 'x', threshold),
    y: axisEdges(pre, image.width, image.height, 'y', threshold),
    colorCount: countColors(image, PARAMS.pitch.nativeMaxColors),
  };
}

/** Value at quantile `q` (0 to 1) of the values, lower rank. */
export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[rank];
}
