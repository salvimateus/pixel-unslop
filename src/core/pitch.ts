import type { AxisEdges } from './edge-profile.ts';
import { PARAMS } from './params.ts';

export type HarmonicNote = 'harmonic-down' | 'harmonic-up';

/** Score of a candidate period. Higher is a better grid. */
export type PeriodScore = (period: number) => number;

export interface PeriodResult {
  period: number;
  /** Share of the edge weight that repeats with the period, 0 to 1. */
  coherence: number;
  /** Coherence times the square root of the effective edge count: comparable across image sizes. */
  significance: number;
  notes: HarmonicNote[];
}

/**
 * DFT of a signal at one frequency, sample i at position i. The phasor is normalized
 * again every 1024 samples to stop the drift of the rotation.
 */
export function dft(signal: Float64Array, freq: number): [number, number] {
  const w = -2 * Math.PI * freq;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  let zr = 1;
  let zi = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    if (v !== 0) {
      re += v * zr;
      im += v * zi;
    }
    const nr = zr * cw - zi * sw;
    zi = zr * sw + zi * cw;
    zr = nr;
    if ((i & 1023) === 1023) {
      const n = Math.hypot(zr, zi);
      zr /= n;
      zi /= n;
    }
  }
  return [re, im];
}

/** Share of the edge weight that repeats with period p, 0 to 1. */
export function coherence(edges: AxisEdges, p: number): number {
  if (edges.peakWeight <= 0 || !(p > 0)) return 0;
  const [re, im] = dft(edges.peaks, 1 / (p * PARAMS.edges.binsPerPixel));
  return Math.min(1, Math.hypot(re, im) / edges.peakWeight);
}

export function significance(edges: AxisEdges, c: number): number {
  return c * Math.sqrt(edges.effectiveCount);
}

/** Bound position of the period p, in [0, p). */
export function phaseOffset(edges: AxisEdges, p: number): number {
  const [re, im] = dft(edges.peaks, 1 / (p * PARAMS.edges.binsPerPixel));
  if (re === 0 && im === 0) return 0;
  const raw = (-Math.atan2(im, re) * p) / (2 * Math.PI);
  const offset = ((raw % p) + p) % p;
  return offset >= p ? 0 : offset;
}

interface Candidate { period: number; score: number }

/** Relative range around a multiple of the period where the harmonic search looks. */
const HARMONIC_WINDOW = 0.05;

/** Higher score wins; a tie goes to the period closer to `prior`, then to the smaller period. */
function better(a: Candidate, b: Candidate, prior: number): boolean {
  if (a.score !== b.score) return a.score > b.score;
  const da = Math.abs(a.period - prior);
  const db = Math.abs(b.period - prior);
  if (da !== db) return da < db;
  return a.period < b.period;
}

function linearSearch(score: PeriodScore, low: number, high: number, steps: number, prior: number): Candidate {
  let best: Candidate = { period: low, score: -Infinity };
  for (let i = 0; i <= steps; i++) {
    const period = low + ((high - low) * i) / steps;
    const candidate = { period, score: score(period) };
    if (better(candidate, best, prior)) best = candidate;
  }
  return best;
}

/** Coarse linear search over [low, high], then a fine search over one coarse step on each side. */
function searchRange(score: PeriodScore, low: number, high: number, prior: number): Candidate {
  const { coarseSteps, fineSteps } = PARAMS.pitch;
  const coarse = linearSearch(score, low, high, coarseSteps, prior);
  const step = (high - low) / coarseSteps;
  const fine = linearSearch(score, Math.max(low, coarse.period - step), Math.min(high, coarse.period + step), fineSteps, prior);
  return better(fine, coarse, prior) ? fine : coarse;
}

function searchAround(score: PeriodScore, center: number, low: number = PARAMS.pitch.priorLow, high: number = PARAMS.pitch.priorHigh): Candidate {
  return searchRange(score, center * low, center * high, center);
}

/** Snaps to len / N when the period is close to a whole cell count and keeps the score. */
function snapWhole(score: PeriodScore, length: number, best: Candidate): Candidate {
  const { snapTolerance, snapKeep } = PARAMS.pitch;
  const cells = length / best.period;
  const whole = Math.round(cells);
  if (whole < 1 || Math.abs(cells - whole) >= snapTolerance) return best;
  const period = length / whole;
  if (period === best.period) return best;
  const s = score(period);
  return s >= snapKeep * best.score ? { period, score: s } : best;
}

/** Climbs to a multiple of the period while the multiple keeps most of the score. */
function climb(score: PeriodScore, limit: number, start: Candidate): Candidate {
  const { superHarmonicKeep } = PARAMS.pitch;
  let best = start;
  for (let guard = 0; guard < 16; guard++) {
    let next: Candidate | null = null;
    for (const k of [2, 3]) {
      const multiple = best.period * k;
      if (multiple > limit) continue;
      const candidate = searchAround(score, multiple, 1 - HARMONIC_WINDOW, 1 + HARMONIC_WINDOW);
      if (candidate.score >= superHarmonicKeep * best.score) {
        next = candidate;
        break;
      }
    }
    if (!next || next.period <= best.period * 1.5) break;
    best = next;
  }
  return best;
}

function result(edges: AxisEdges, period: number, notes: HarmonicNote[]): PeriodResult {
  const c = coherence(edges, period);
  return { period, coherence: c, significance: significance(edges, c), notes };
}

/**
 * Period near a prior (the size of the user box or a hint), with the harmonic corrections.
 * The peak next to the prior wins unless a peak farther away in the range is clearly stronger,
 * so a good hint is not pulled to a noise peak.
 */
function refineWith(score: PeriodScore, length: number, prior: number, window?: { low: number; high: number }): { best: Candidate; notes: HarmonicNote[] } {
  const notes: HarmonicNote[] = [];
  const { subHarmonicGain, superHarmonicKeep, minPeriod, priorLow, priorHigh, hintWindow, hintTrust } = PARAMS.pitch;
  const low = window?.low ?? priorLow;
  const high = window?.high ?? priorHigh;
  let best = searchAround(score, prior, low, high);
  if (!window) {
    const near = searchAround(score, prior, 1 - hintWindow, 1 + hintWindow);
    if (near.score * hintTrust >= best.score) best = near;
    let sub: Candidate | null = null;
    for (const k of [2, 3]) {
      if ((prior / k) * low < minPeriod) continue;
      const candidate = searchAround(score, prior / k, low, high);
      if (candidate.score >= subHarmonicGain * best.score && (!sub || better(candidate, sub, prior / k))) sub = candidate;
    }
    if (sub) {
      best = sub;
      notes.push('harmonic-down');
    } else if (best.period * 2 <= length / 2) {
      const doubled = searchAround(score, best.period * 2, 1 - HARMONIC_WINDOW, 1 + HARMONIC_WINDOW);
      if (doubled.score >= superHarmonicKeep * best.score) {
        best = doubled;
        notes.push('harmonic-up');
      }
    }
  }
  return { best, notes };
}

/** Period of one axis near a prior (non-square box or hint). */
export function refinePeriod(edges: AxisEdges, prior: number, window?: { low: number; high: number }): PeriodResult {
  if (edges.peakWeight <= 0) return { period: prior, coherence: 0, significance: 0, notes: [] };
  const score: PeriodScore = (p) => coherence(edges, p);
  const { best, notes } = refineWith(score, edges.length, prior, window);
  return result(edges, snapWhole(score, edges.length, best).period, notes);
}

/** Largest period that the automatic detection considers on an axis of this length. */
export function detectLimit(length: number): number {
  return Math.min(PARAMS.pitch.maxPeriod, length / PARAMS.pitch.minCellsPerAxis);
}

/** Log-spaced search of the best period, a fine search, then the climb to the fundamental. */
export function searchPeriod(score: PeriodScore, limit: number): Candidate | null {
  const { minPeriod, logStep } = PARAMS.pitch;
  if (!(limit >= minPeriod)) return null;
  let best: Candidate = { period: minPeriod, score: -Infinity };
  for (let period = minPeriod; period <= limit; period *= logStep) {
    const candidate = { period, score: score(period) };
    if (better(candidate, best, minPeriod)) best = candidate;
  }
  const fine = searchRange(score, Math.max(minPeriod, best.period / logStep), Math.min(limit, best.period * logStep), best.period);
  if (better(fine, best, best.period)) best = fine;
  if (best.score <= 0) return null;
  return climb(score, limit, best);
}

/** Coherence of the period, or 0 when too few cells repeat for a weak coherence to mean a grid. */
export function gridCoherence(edges: AxisEdges, p: number): number {
  const c = coherence(edges, p);
  const { reliableCells, fewCellsCoherence } = PARAMS.pitch;
  return edges.length / p < reliableCells && c < fewCellsCoherence ? 0 : c;
}

/** Highest score of the log-spaced search: the scale of one axis. */
function peakScore(score: PeriodScore, limit: number): number {
  const { minPeriod, logStep } = PARAMS.pitch;
  let peak = 0;
  for (let period = minPeriod; period <= limit; period *= logStep) peak = Math.max(peak, score(period));
  return peak;
}

/**
 * Mean significance of the period over a set of axes. Each axis is scaled by its own peak, so every
 * image of a set has the same vote, whatever its size.
 */
function setScore(axes: AxisEdges[]): PeriodScore {
  if (axes.length === 1) {
    const edges = axes[0];
    return (p) => significance(edges, gridCoherence(edges, p));
  }
  const scores = axes.map((edges) => (p: number) => significance(edges, gridCoherence(edges, p)));
  const peaks = scores.map((score, i) => peakScore(score, detectLimit(axes[i].length)));
  return (p) => {
    let total = 0;
    for (let i = 0; i < scores.length; i++) if (peaks[i] > 0) total += scores[i](p) / peaks[i];
    return total / scores.length;
  };
}

function limitOf(axes: AxisEdges[]): number {
  return Math.min(...axes.map((edges) => detectLimit(edges.length)));
}

/** A square grid: one joint period, and each axis within the square slack of it. */
export interface SquareFit {
  x: number;
  y: number;
  /** The joint period. */
  period: number;
  /** Joint score: geometric mean of the axis scores (significance; for a set, the mean share of each axis peak). */
  score: number;
  /** Joint score over the best score of a period that is neither near the joint period nor a harmonic of it. */
  prominence: number;
  notes: HarmonicNote[];
}

function jointScore(xs: AxisEdges[], ys: AxisEdges[]): { score: PeriodScore; limit: number } | null {
  const usableX = xs.filter((edges) => edges.peakWeight > 0);
  const usableY = ys.filter((edges) => edges.peakWeight > 0);
  if (usableX.length === 0 && usableY.length === 0) return null;
  const scoreX = usableX.length > 0 ? setScore(usableX) : null;
  const scoreY = usableY.length > 0 ? setScore(usableY) : null;
  const limit = Math.min(...[usableX, usableY].filter((axes) => axes.length > 0).map(limitOf));
  // The geometric mean rewards a period on which both axes agree, as square art pixels do.
  const score: PeriodScore = scoreX && scoreY ? (p) => Math.sqrt(scoreX(p) * scoreY(p)) : (scoreX ?? scoreY)!;
  return { score, limit };
}

const HARMONIC_RATIOS = [1 / 3, 1 / 2, 1, 2, 3];

function prominenceOf(score: PeriodScore, limit: number, best: Candidate): number {
  const { minPeriod, logStep, rivalDistance } = PARAMS.pitch;
  let rival = 0;
  for (let period = minPeriod; period <= limit; period *= logStep) {
    const ratio = period / best.period;
    if (HARMONIC_RATIOS.some((h) => Math.abs(ratio / h - 1) < rivalDistance)) continue;
    rival = Math.max(rival, score(period));
  }
  return rival > 0 ? best.score / rival : Infinity;
}

/**
 * One axis may leave the joint period by at most the square slack, and only when its own
 * evidence is strong. Weak evidence keeps the joint period, so the art pixels stay square.
 */
function axisPeriod(edges: AxisEdges, joint: number): number {
  const { squareSlack } = PARAMS.pitch;
  if (edges.peakWeight <= 0) return joint;
  const score: PeriodScore = (p) => coherence(edges, p);
  let own = searchAround(score, joint, 1 - squareSlack, 1 + squareSlack);
  own = snapWhole(score, edges.length, own);
  if (Math.abs(own.period / joint - 1) > squareSlack) return joint;
  return significance(edges, own.score) >= PARAMS.pitch.goodSignificance ? own.period : joint;
}

function squareFit(xs: AxisEdges[], ys: AxisEdges[], score: PeriodScore, limit: number, best: Candidate, notes: HarmonicNote[]): SquareFit {
  const single = xs.length === 1 && ys.length === 1;
  return {
    x: single ? axisPeriod(xs[0], best.period) : best.period,
    y: single ? axisPeriod(ys[0], best.period) : best.period,
    period: best.period,
    score: best.score,
    prominence: prominenceOf(score, limit, best),
    notes,
  };
}

/**
 * Square periods with no user input, for one image or for a set of pieces of one sheet.
 * One joint period comes from the evidence of both axes together.
 */
export function detectPeriods(xs: AxisEdges[], ys: AxisEdges[]): SquareFit | null {
  const joint = jointScore(xs, ys);
  if (!joint) return null;
  const best = searchPeriod(joint.score, joint.limit);
  if (!best) return null;
  return squareFit(xs, ys, joint.score, joint.limit, best, []);
}

/**
 * Square periods near a prior. With no window (a box drawn by the user) the search is wide and
 * corrects harmonics; with a window (a typed size or the shared period of a set) it stays inside it.
 */
export function refineSquare(x: AxisEdges, y: AxisEdges, prior: number, window?: { low: number; high: number }): SquareFit {
  const joint = jointScore([x], [y]);
  if (!joint) return { x: prior, y: prior, period: prior, score: 0, prominence: 0, notes: [] };
  const { best, notes } = refineWith(joint.score, Math.min(x.length, y.length), prior, window);
  return squareFit([x], [y], joint.score, joint.limit, best, notes);
}

/** Result of a known period on one axis. */
export function measurePeriod(edges: AxisEdges, period: number): PeriodResult {
  return result(edges, period, []);
}
