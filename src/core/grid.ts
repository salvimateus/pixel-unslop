import { edgeStrength, capture, fitBoundaries, keepInside } from './elastic.ts';
import type { AxisEdges, EdgeProfiles } from './edge-profile.ts';
import { CoreError } from './errors.ts';
import { PARAMS } from './params.ts';
import { detectPeriods, measurePeriod, phaseOffset, refinePeriod, refineSquare, type PeriodResult, type SquareFit } from './pitch.ts';
import type { AxisFit, CellGrid, GridFit, GridNote, GridOptions, Selection } from './types.ts';

/** Inputs of a fit beyond the contract (CLI). */
export interface FitExtras {
  /** A period shared by a set of images. */
  sharedPeriod?: { x: number; y: number };
  /** The caller asked for a non-square pixel size (`--pixel-size WxH`): each axis refines its own size. */
  nonSquare?: boolean;
  /** The selection is a typed size, not a drawn box: refine only within PARAMS.pitch.hintWindow, with no harmonic change. */
  typedSize?: boolean;
}

interface AxisChoice { result: PeriodResult; offset: number | null }

interface Choice { x: AxisChoice; y: AxisChoice; quality: 1 | 2 | 3 }

/** Regular bounds offset + k * p over [-p, length + p], reduced to the cells whose center is inside. */
export function regularBounds(length: number, period: number, offset: number): Float64Array {
  const start = Math.floor((-period - offset) / period);
  const end = Math.ceil((length + period - offset) / period);
  const bounds = new Float64Array(end - start + 1);
  for (let k = start; k <= end; k++) bounds[k - start] = offset + k * period;
  return keepInside(bounds, length);
}

function nativeBounds(length: number): Float64Array {
  const bounds = new Float64Array(length + 1);
  for (let i = 0; i <= length; i++) bounds[i] = i;
  return bounds;
}

function isWeak(result: PeriodResult): boolean {
  return result.significance < PARAMS.pitch.weakSignificance;
}

function axisQuality(result: PeriodResult): 1 | 2 | 3 {
  if (result.significance >= PARAMS.pitch.goodSignificance) return 3;
  return result.significance >= PARAMS.pitch.weakSignificance ? 2 : 1;
}

function addNotes(notes: GridNote[], extra: readonly GridNote[]): void {
  for (const note of extra) if (!notes.includes(note)) notes.push(note);
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function boxOffset(start: number, period: number): number {
  return ((start % period) + period) % period;
}

function measured(edges: EdgeProfiles, x: number, y: number): { x: AxisChoice; y: AxisChoice } {
  return { x: { result: measurePeriod(edges.x, x), offset: null }, y: { result: measurePeriod(edges.y, y), offset: null } };
}

function significanceQuality(x: PeriodResult, y: PeriodResult): 1 | 2 | 3 {
  return Math.min(axisQuality(x), axisQuality(y)) as 1 | 2 | 3;
}

function squareChoice(edges: EdgeProfiles, fit: SquareFit, notes: GridNote[]): Choice {
  addNotes(notes, fit.notes);
  const axes = measured(edges, fit.x, fit.y);
  return { ...axes, quality: significanceQuality(axes.x.result, axes.y.result) };
}

/**
 * Periods of both axes. Art pixels are square unless the caller asks for a non-square size:
 * fixedPeriod with two values, a box more than squareTolerance from a square, or the nonSquare extra.
 */
function choosePeriods(
  edges: EdgeProfiles,
  selection: Selection | null,
  options: GridOptions,
  extras: FitExtras,
  notes: GridNote[],
): Choice | 'native' {
  const { nativeBelow, squareTolerance } = PARAMS.pitch;
  const fixed = options.fixedPeriod;
  if (fixed && positive(fixed.x) && positive(fixed.y)) {
    if (fixed.x < nativeBelow && fixed.y < nativeBelow) return 'native';
    const axes = measured(edges, Math.max(1, fixed.x), Math.max(1, fixed.y));
    return { ...axes, quality: significanceQuality(axes.x.result, axes.y.result) };
  }

  if (selection && positive(selection.w) && positive(selection.h)) {
    if (selection.w < nativeBelow && selection.h < nativeBelow) return 'native';
    const boxW = Math.max(1, selection.w);
    const boxH = Math.max(1, selection.h);
    const square = !extras.nonSquare && Math.abs(boxW - boxH) <= squareTolerance * Math.max(boxW, boxH);
    let x: PeriodResult;
    let y: PeriodResult;
    let harmonic: GridNote[];
    const { hintWindow } = PARAMS.pitch;
    const window = extras.typedSize ? { low: 1 - hintWindow, high: 1 + hintWindow } : undefined;
    if (square) {
      const fit = refineSquare(edges.x, edges.y, (boxW + boxH) / 2, window);
      x = measurePeriod(edges.x, fit.x);
      y = measurePeriod(edges.y, fit.y);
      harmonic = fit.notes;
    } else {
      x = refinePeriod(edges.x, boxW, window);
      y = refinePeriod(edges.y, boxH, window);
      harmonic = [...x.notes, ...y.notes];
    }
    if (isWeak(x) && isWeak(y)) {
      notes.push('weak-grid');
      return {
        // A drawn box gives the phase; a typed size has no position, so the phase comes from the edges.
        x: { result: measurePeriod(edges.x, boxW), offset: extras.typedSize ? null : boxOffset(selection.x, boxW) },
        y: { result: measurePeriod(edges.y, boxH), offset: extras.typedSize ? null : boxOffset(selection.y, boxH) },
        quality: 1,
      };
    }
    addNotes(notes, harmonic);
    return { x: { result: x, offset: null }, y: { result: y, offset: null }, quality: significanceQuality(x, y) };
  }

  const shared = extras.sharedPeriod;
  if (shared && positive(shared.x) && positive(shared.y)) {
    const { squareSlack } = PARAMS.pitch;
    return squareChoice(edges, refineSquare(edges.x, edges.y, (shared.x + shared.y) / 2, { low: 1 - squareSlack, high: 1 + squareSlack }), notes);
  }

  const detected = detectPeriods([edges.x], [edges.y]);
  const { minProminence, strongJointSignificance } = PARAMS.pitch;
  const weak = !detected || (detected.prominence < minProminence && detected.score < strongJointSignificance);
  if (weak) {
    // A crisp or few-color image with no repeating edges is already one source pixel per art pixel.
    const crisp = Math.min(edges.x.sharpShare, edges.y.sharpShare) >= PARAMS.pitch.nativeSharpShare;
    if (!detected || crisp || edges.colorCount <= PARAMS.pitch.nativeMaxColors) {
      if (!detected) notes.push('weak-grid');
      return 'native';
    }
    notes.push('weak-grid');
    return { ...measured(edges, detected.x, detected.y), quality: 1 };
  }
  return { ...measured(edges, detected.x, detected.y), quality: detected.score >= strongJointSignificance ? 3 : 2 };
}

function fitAxis(
  edges: AxisEdges,
  choice: AxisChoice,
  nudge: number,
  elastic: GridOptions['elastic'],
): { bounds: Float64Array; fit: AxisFit } {
  const { period } = choice.result;
  const offset = boxOffset((choice.offset ?? phaseOffset(edges, period)) + nudge, period);
  const regular = regularBounds(edges.length, period, offset);
  let bounds = regular;
  let adapted = false;
  const wanted = elastic === 'on' || (elastic === 'auto' && period >= PARAMS.elastic.minPeriod);
  if (wanted && edges.length >= 2) {
    const strength = edgeStrength(edges.profile, edges.length);
    const fitted = fitBoundaries(strength, edges.length, period);
    const gain = capture(strength, fitted) / Math.max(1e-9, capture(strength, regular));
    // A regular grid that drifts loses or adds a cell; then a smaller gain is enough evidence.
    const needed = fitted.length !== regular.length ? PARAMS.elastic.countChangeGain : PARAMS.elastic.minGain;
    if (fitted.length >= 2 && (elastic === 'on' || gain >= needed)) {
      bounds = fitted;
      adapted = true;
    }
  }
  return { bounds, fit: { period, offset, coherence: choice.result.coherence, adapted } };
}

/**
 * Fits the grid of art pixels on an image.
 * `selection` is the box that the user drew over one art pixel, or null for the automatic detection.
 */
export function fitGrid(
  width: number,
  height: number,
  edges: EdgeProfiles,
  selection: Selection | null,
  options: GridOptions,
  extras: FitExtras = {},
): GridFit {
  const notes: GridNote[] = [];
  const chosen = choosePeriods(edges, selection, options, extras, notes);
  let grid: CellGrid;
  let axes: { x: AxisFit; y: AxisFit };
  let quality: 1 | 2 | 3;
  if (chosen === 'native') {
    if (!notes.includes('native-resolution')) notes.push('native-resolution');
    grid = { x: nativeBounds(width), y: nativeBounds(height) };
    axes = {
      x: { period: 1, offset: 0, coherence: 0, adapted: false },
      y: { period: 1, offset: 0, coherence: 0, adapted: false },
    };
    quality = notes.includes('weak-grid') ? 1 : 3;
  } else {
    const nudge = options.nudge;
    const hasNudge = !!nudge && (nudge.x !== 0 || nudge.y !== 0);
    const elastic = hasNudge ? 'off' : options.elastic;
    const x = fitAxis(edges.x, chosen.x, hasNudge ? nudge.x : 0, elastic);
    const y = fitAxis(edges.y, chosen.y, hasNudge ? nudge.y : 0, elastic);
    if (x.fit.adapted || y.fit.adapted) notes.push('elastic');
    grid = { x: x.bounds, y: y.bounds };
    axes = { x: x.fit, y: y.fit };
    quality = notes.includes('weak-grid') ? 1 : chosen.quality;
  }
  const cols = grid.x.length - 1;
  const rows = grid.y.length - 1;
  if (cols < 1 || rows < 1) throw new CoreError('internal', 'The grid has no cells.');
  if (cols * rows > PARAMS.limits.maxCells) {
    throw new CoreError('too-many-cells', `The grid has ${cols} x ${rows} cells; the limit is ${PARAMS.limits.maxCells}.`);
  }
  return { grid, cols, rows, axes, quality, notes };
}
