import { quantile } from './edge-profile.ts';
import { PARAMS } from './params.ts';

/**
 * Edge strength at the bound positions 0..length (entry c is the bound between pixel c - 1 and pixel c),
 * with half credit one pixel off for edges spread over two pixels, normalized by a high percentile.
 */
export function edgeStrength(profile: Float64Array, length: number): Float64Array {
  const raw = new Float64Array(length + 1);
  for (let c = 1; c < length; c++) raw[c] = profile[c - 1];
  const strength = new Float64Array(length + 1);
  for (let c = 0; c <= length; c++) {
    const left = c > 0 ? raw[c - 1] : 0;
    const right = c < length ? raw[c + 1] : 0;
    strength[c] = Math.max(raw[c], 0.5 * Math.max(left, right));
  }
  const scale = Math.max(1e-9, quantile(strength.subarray(1, length), PARAMS.elastic.normalizePercentile));
  for (let c = 0; c <= length; c++) strength[c] /= scale;
  return strength;
}

/** Share of the edge energy that lies on the bounds. */
export function capture(strength: Float64Array, bounds: Float64Array): number {
  const n = strength.length - 1;
  let total = 0;
  for (let c = 1; c < n; c++) total += strength[c];
  let hit = 0;
  for (let i = 0; i < bounds.length; i++) {
    const c = Math.round(bounds[i]);
    if (c > 0 && c < n) hit += strength[c];
  }
  return hit / Math.max(1e-9, total);
}

/**
 * Bounds that follow the drawn edges: a dynamic program on a sub-pixel lattice that maximizes
 * the edge strength on the bounds minus a quadratic cost for each cell that leaves the period.
 * The first bound lies in (-smax, 0], the last at or after `length`. Only the cells whose
 * center lies inside the image are kept.
 */
export function fitBoundaries(strength: Float64Array, length: number, period: number): Float64Array {
  const { lattice: q, minSpacing, maxSpacing, slack } = PARAMS.elastic;
  const steps = length * q;
  const smin = Math.max(1, Math.floor(minSpacing * period * q));
  const smax = Math.max(smin + 1, Math.ceil(maxSpacing * period * q));
  const lambda = 1 / (slack * period) ** 2;
  const penalty = new Float64Array(smax - smin + 1);
  for (let s = smin; s <= smax; s++) penalty[s - smin] = lambda * (s / q - period) ** 2;
  const gain = (t: number): number => {
    if (t <= 0 || t >= steps) return 0;
    const c = Math.floor(t / q);
    const f = (t % q) / q;
    return strength[c] * (1 - f) + strength[Math.min(c + 1, length)] * f;
  };

  // Index j is the lattice position plus smax, so positions run from -smax to steps + smax.
  const size = steps + 2 * smax + 1;
  const best = new Float64Array(size).fill(-Infinity);
  const previous = new Int32Array(size).fill(-1);
  for (let j = 1; j <= smax; j++) best[j] = 0;
  for (let j = smax + 1; j < size; j++) {
    let top = -Infinity;
    let arg = -1;
    for (let s = smin; s <= smax && s <= j; s++) {
      const v = best[j - s] - penalty[s - smin];
      if (v > top) {
        top = v;
        arg = j - s;
      }
    }
    if (arg >= 0) {
      best[j] = top + gain(j - smax);
      previous[j] = arg;
    }
  }
  let end = size - 1;
  for (let j = steps + smax; j < size; j++) if (best[j] > best[end] || (best[j] === best[end] && j < end)) end = j;
  const reversed: number[] = [];
  for (let j = end; j >= 0; j = previous[j]) {
    reversed.push((j - smax) / q);
    if (previous[j] < 0) break;
  }
  const bounds = reversed.reverse();
  return keepInside(Float64Array.from(bounds), length);
}

/**
 * Bounds that follow the drawn edges from a fixed `start` forward, with the cost of fitBoundaries.
 * The first bound is `start` exactly; the lattice is relative to it, and the last bound lies at or after `length`.
 */
export function fitBoundariesFrom(strength: Float64Array, length: number, period: number, start: number): Float64Array {
  if (start >= length) return Float64Array.of(start);
  const { lattice: q, minSpacing, maxSpacing, slack } = PARAMS.elastic;
  const smin = Math.max(1, Math.floor(minSpacing * period * q));
  const smax = Math.max(smin + 1, Math.ceil(maxSpacing * period * q));
  const lambda = 1 / (slack * period) ** 2;
  const penalty = new Float64Array(smax - smin + 1);
  for (let s = smin; s <= smax; s++) penalty[s - smin] = lambda * (s / q - period) ** 2;
  const gain = (t: number): number => {
    if (t <= 0 || t >= length) return 0;
    const c = Math.floor(t);
    const f = t - c;
    return strength[c] * (1 - f) + strength[Math.min(c + 1, length)] * f;
  };
  const reach = Math.ceil((length - start) * q);
  const size = reach + smax + 1;
  const best = new Float64Array(size).fill(-Infinity);
  const previous = new Int32Array(size).fill(-1);
  best[0] = 0;
  for (let j = smin; j < size; j++) {
    let top = -Infinity;
    let arg = -1;
    for (let s = smin; s <= smax && s <= j; s++) {
      const v = best[j - s] - penalty[s - smin];
      if (v > top) {
        top = v;
        arg = j - s;
      }
    }
    if (arg >= 0) {
      best[j] = top + gain(start + j / q);
      previous[j] = arg;
    }
  }
  let end = -1;
  for (let j = reach; j < size; j++) if (start + j / q >= length && best[j] > -Infinity && (end < 0 || best[j] > best[end])) end = j;
  // The end window is longer than the largest step, so a reachable end always exists; the guard keeps a valid grid.
  if (end < 0) return Float64Array.of(start, start + period);
  const reversed: number[] = [];
  for (let j = end; j > 0; j = previous[j]) reversed.push(start + j / q);
  reversed.push(start);
  return Float64Array.from(reversed.reverse());
}

/**
 * Elastic bounds that keep the cell [low, high] exactly: the bounds after it come from fitBoundariesFrom, and the
 * bounds before it from the same fit on the mirrored axis. Only the cells whose center lies inside are kept.
 */
export function fitAnchoredBoundaries(strength: Float64Array, length: number, period: number, low: number, high: number): Float64Array {
  const after = fitBoundariesFrom(strength, length, period, high);
  const mirrored = new Float64Array(length + 1);
  for (let c = 0; c <= length; c++) mirrored[c] = strength[length - c];
  const before = fitBoundariesFrom(mirrored, length, period, length - low);
  const bounds = new Float64Array(before.length + after.length);
  for (let i = 0; i < before.length; i++) bounds[i] = length - before[before.length - 1 - i];
  bounds.set(after, before.length);
  return keepInside(bounds, length);
}

/** The run of cells whose center lies inside [0, length). */
export function keepInside(bounds: Float64Array, length: number): Float64Array {
  let first = -1;
  let last = -1;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const center = (bounds[i] + bounds[i + 1]) / 2;
    if (center >= 0 && center < length) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? bounds : bounds.slice(first, last + 2);
}
