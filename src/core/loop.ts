import { TRANSPARENT, toOklab } from './color.ts';
import { CoreError } from './errors.ts';
import { PARAMS } from './params.ts';
import type { Sprite } from './types.ts';

/** Tiles that differ between two sprites of one grid. `compared` counts the tiles that are not transparent on both sides. */
export interface SpriteDiff { compared: number; changed: Int32Array }

export type SeamVerdict = 'repeat' | 'smooth' | 'bump' | 'jump';

export type MatchLevel = 'match' | 'near' | 'far';

/** The jump from the last frame back to the first, measured against the median step between neighbor frames. */
export interface SeamReport { seam: number; step: number; ratio: number; verdict: SeamVerdict; changed: Int32Array; cols: number; rows: number }

type Lab = [number, number, number];
type DiffFn = (a: Sprite, b: Sprite) => SpriteDiff;

/** A diff function that keeps one OKLab cache across its calls, so many frame pairs convert each color once. */
function createDiff(tolerance: number): DiffFn {
  const labs = new Map<number, Lab>();
  const lab = (color: number): Lab => {
    let value = labs.get(color);
    if (value === undefined) {
      value = toOklab(color);
      labs.set(color, value);
    }
    return value;
  };
  return (a, b) => {
    if (a.cols !== b.cols || a.rows !== b.rows) {
      throw new CoreError('internal', 'The sprites of a diff must have the same grid size.');
    }
    const left = a.pixels;
    const right = b.pixels;
    const changed = new Int32Array(left.length);
    let count = 0;
    let compared = 0;
    for (let i = 0; i < left.length; i++) {
      const p = left[i];
      const q = right[i];
      if (p === q) {
        if (p !== TRANSPARENT) compared++;
        continue;
      }
      compared++;
      if (p === TRANSPARENT || q === TRANSPARENT) {
        changed[count++] = i;
        continue;
      }
      const [l1, a1, b1] = lab(p);
      const [l2, a2, b2] = lab(q);
      if (Math.hypot(l1 - l2, a1 - a2, b1 - b2) > tolerance) changed[count++] = i;
    }
    return { compared, changed: changed.slice(0, count) };
  };
}

/** Tiles that differ between `a` and `b` beyond `tolerance` (OKLab distance). Both sprites must share one grid size. */
export function diffSprites(a: Sprite, b: Sprite, tolerance: number = PARAMS.loop.tolerance): SpriteDiff {
  return createDiff(tolerance)(a, b);
}

/** Share of the compared tiles that changed, 0 to 1. */
export function diffShare(diff: SpriteDiff): number {
  return diff.compared === 0 ? 0 : diff.changed.length / diff.compared;
}

/** Changed shares of the neighbor frames, held poses left out, sorted ascending. */
function movingShares(frames: readonly Sprite[], diff: DiffFn): number[] {
  const moves: number[] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    const share = diffShare(diff(frames[i], frames[i + 1]));
    if (share > PARAMS.loop.holdDiff) moves.push(share);
  }
  return moves.sort((x, y) => x - y);
}

function medianOf(sorted: readonly number[]): number {
  const { minStep } = PARAMS.loop;
  if (sorted.length === 0) return minStep;
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(median, minStep);
}

/** Nearest-rank quantile, so an animation that alternates small and large steps is judged by its large ones. */
function quantileOf(sorted: readonly number[], q: number): number {
  const { minStep } = PARAMS.loop;
  if (sorted.length === 0) return minStep;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.max(sorted[rank], minStep);
}

/** Median changed share between neighbor frames, held poses left out. Never below `PARAMS.loop.minStep`. */
export function medianStep(frames: readonly Sprite[], tolerance: number = PARAMS.loop.tolerance): number {
  return medianOf(movingShares(frames, createDiff(tolerance)));
}

/**
 * How the jump from the last frame to the first compares with a normal step of the animation. A seam within
 * `repeatRatio` median steps shows the first pose twice; else `step` is the `stepQuantile` neighbor share and
 * `ratio = seam / step` grades the seam. Null below `minFrames`.
 */
export function loopSeam(frames: readonly Sprite[], tolerance: number = PARAMS.loop.tolerance): SeamReport | null {
  const { minFrames, repeatRatio, smoothRatio, bumpRatio, stepQuantile } = PARAMS.loop;
  if (frames.length < minFrames) return null;
  const diff = createDiff(tolerance);
  const first = frames[0];
  const seamDiff = diff(frames[frames.length - 1], first);
  const seam = diffShare(seamDiff);
  const moves = movingShares(frames, diff);
  const step = quantileOf(moves, stepQuantile);
  const ratio = seam / step;
  const verdict: SeamVerdict =
    seam <= repeatRatio * medianOf(moves) ? 'repeat' : ratio <= smoothRatio ? 'smooth' : ratio <= bumpRatio ? 'bump' : 'jump';
  return { seam, step, ratio, verdict, changed: seamDiff.changed, cols: first.cols, rows: first.rows };
}

/** How near a changed share is to the first pose, in median steps. */
export function matchLevel(share: number, step: number): MatchLevel {
  const { minStep, matchRatio, smoothRatio } = PARAMS.loop;
  const ratio = share / Math.max(step, minStep);
  return ratio <= matchRatio ? 'match' : ratio <= smoothRatio ? 'near' : 'far';
}

/**
 * The frame where the motion comes back to the first pose: the lowest point of the first dip near frame 0 after the
 * motion left it. Null below `minFrames`, when the motion never leaves the first pose, or when it never comes back.
 */
export function loopReturn(
  frames: readonly Sprite[],
  tolerance: number = PARAMS.loop.tolerance,
): { position: number; share: number } | null {
  const { minFrames, smoothRatio, leaveRatio, leaveShare } = PARAMS.loop;
  if (frames.length < minFrames) return null;
  const diff = createDiff(tolerance);
  const first = frames[0];
  const away = new Float64Array(frames.length);
  let peak = 0;
  for (let i = 1; i < frames.length; i++) {
    away[i] = diffShare(diff(frames[i], first));
    if (away[i] > peak) peak = away[i];
  }
  const step = medianOf(movingShares(frames, diff));
  const near = smoothRatio * step;
  if (peak <= near) return null;
  const leave = Math.min(leaveRatio * step, leaveShare * peak);
  let i = 1;
  while (i < frames.length && away[i] < leave) i++;
  i++;
  while (i < frames.length && away[i] > near) i++;
  if (i >= frames.length) return null;
  while (i + 1 < frames.length && away[i + 1] < away[i]) i++;
  return { position: i, share: away[i] };
}
