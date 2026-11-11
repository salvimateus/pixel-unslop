import { edgeStrength, capture, fitAnchoredBoundaries, fitBoundaries, keepInside } from './elastic.ts';
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

interface Choice { x: AxisChoice; y: AxisChoice; quality: 1 | 2 | 3; suggestion?: GridFit['suggestion'] }

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
    // A drawn box defines the tile: the period stays within boxWindow of its side and never moves to a harmonic.
    const share = extras.typedSize ? hintWindow : PARAMS.pitch.boxWindow;
    const window = { low: 1 - share, high: 1 + share };
    const refine = (search?: { low: number; high: number }) => {
      if (square) {
        const fit = refineSquare(edges.x, edges.y, (boxW + boxH) / 2, search);
        return { x: measurePeriod(edges.x, fit.x), y: measurePeriod(edges.y, fit.y), notes: fit.notes };
      }
      const rx = refinePeriod(edges.x, boxW, search);
      const ry = refinePeriod(edges.y, boxH, search);
      return { x: rx, y: ry, notes: [...rx.notes, ...ry.notes] };
    };
    ({ x, y, notes: harmonic } = refine(window));
    const weak = isWeak(x) && isWeak(y);
    if (weak) {
      x = measurePeriod(edges.x, boxW);
      y = measurePeriod(edges.y, boxH);
    }
    const suggestion = extras.typedSize ? undefined : suggestionFor(refine(), x.period, y.period, share);
    if (weak) {
      notes.push('weak-grid');
      return {
        // A drawn box gives the phase; a typed size has no position, so the phase comes from the edges.
        x: { result: x, offset: extras.typedSize ? null : boxOffset(selection.x, boxW) },
        y: { result: y, offset: extras.typedSize ? null : boxOffset(selection.y, boxH) },
        quality: 1,
        suggestion,
      };
    }
    addNotes(notes, harmonic);
    return { x: { result: x, offset: null }, y: { result: y, offset: null }, quality: significanceQuality(x, y), suggestion };
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

function hasCellCenteredNear(bounds: Float64Array, position: number, period: number): boolean {
  const tolerance = Math.max(PARAMS.elastic.anchorTolerance, PARAMS.elastic.anchorShare * period);
  for (let i = 0; i + 1 < bounds.length; i++) if (Math.abs((bounds[i] + bounds[i + 1]) / 2 - position) <= tolerance) return true;
  return false;
}

/**
 * The pixel size that the wide search (with harmonic corrections) gives for a drawn box, when it is more than
 * `share` away from the kept size. The core never applies it. A weak wide result gives no suggestion.
 */
function suggestionFor(wide: { x: PeriodResult; y: PeriodResult }, keptX: number, keptY: number, share: number): GridFit['suggestion'] {
  if (isWeak(wide.x) && isWeak(wide.y)) return undefined;
  const far = (candidate: number, kept: number) => Math.abs(candidate - kept) > share * kept;
  if (!far(wide.x.period, keptX) && !far(wide.y.period, keptY)) return undefined;
  const kind = wide.x.period + wide.y.period > keptX + keptY ? 'larger' : 'smaller';
  return { period: { x: wide.x.period, y: wide.y.period }, kind };
}

/** The center of a drawn box: one cell of the grid is centered on it. A typed size has no position. */
function anchorOf(selection: Selection | null, extras: FitExtras): { x: number; y: number } | null {
  if (!selection || extras.typedSize || !positive(selection.w) || !positive(selection.h)) return null;
  if (!Number.isFinite(selection.x) || !Number.isFinite(selection.y)) return null;
  return { x: selection.x + selection.w / 2, y: selection.y + selection.h / 2 };
}

function fitAxis(
  edges: AxisEdges,
  choice: AxisChoice,
  nudge: number,
  elastic: GridOptions['elastic'],
  trusted: boolean,
  anchor: number | null,
  userPeriod: boolean,
): { bounds: Float64Array; fit: AxisFit } {
  const { period } = choice.result;
  const start = anchor === null ? (choice.offset ?? phaseOffset(edges, period)) : anchor - period / 2;
  // The grid is decided with no nudge; the nudge then moves the result as one rigid body.
  const offset = boxOffset(start + nudge, period);
  const regular = regularBounds(edges.length, period, boxOffset(start, period));
  const result = (bounds: Float64Array, adapted: boolean) => ({
    bounds: nudge === 0 ? bounds : adapted ? translateBounds(bounds, nudge, period, edges.length) : regularBounds(edges.length, period, offset),
    fit: { period, offset, coherence: choice.result.coherence, adapted },
  });
  let bounds = regular;
  let adapted = false;
  // A weak grid often has a harmonic period, and the elastic fit then follows the wrong edges.
  const wanted = elastic === 'on' || (elastic === 'auto' && trusted && period >= PARAMS.elastic.minPeriod);
  if (wanted && edges.length >= 2) {
    const strength = edgeStrength(edges.profile, edges.length);
    const free = fitBoundaries(strength, edges.length, period);
    let fitted = free;
    if (anchor !== null) {
      // The box cell is kept exactly. In auto the elastic fit is used only when the box is centered on a cell of the
      // drawn edges; a box placed off them is a request to move the whole grid, so the regular grid follows it.
      const low = anchor - period / 2;
      const high = anchor + period / 2;
      if (elastic === 'auto' && !hasCellCenteredNear(free, anchor, period)) return result(regular, false);
      fitted = fitAnchoredBoundaries(strength, edges.length, period, low, high);
    }
    const gain = capture(strength, fitted) / Math.max(1e-9, capture(strength, regular));
    // A regular grid that drifts loses or adds a cell; then a smaller gain is enough evidence.
    const needed = fitted.length !== regular.length ? PARAMS.elastic.countChangeGain : PARAMS.elastic.minGain;
    // A period that the user set must stay visible: the elastic fit may not change the cell count much.
    const regularCells = regular.length - 1;
    const countLimit = Math.max(PARAMS.elastic.userCountSlack, PARAMS.elastic.userCountShare * regularCells);
    const keepsCount = !userPeriod || Math.abs(fitted.length - 1 - regularCells) <= countLimit;
    if (fitted.length >= 2 && keepsCount && (elastic === 'on' || gain >= needed)) {
      bounds = fitted;
      adapted = true;
    }
  }
  return result(bounds, adapted);
}

/**
 * Bounds moved by `shift`, as one rigid body: the cells whose center leaves [0, length) are removed, and the free
 * space at each end gets cells of `period`, as a regular grid has. The cells that stay keep their sizes.
 */
export function translateBounds(bounds: Float64Array, shift: number, period: number, length: number): Float64Array {
  const first = bounds[0] + shift;
  const last = bounds[bounds.length - 1] + shift;
  const before = Math.max(0, Math.floor(first / period + 0.5));
  const after = Math.max(0, Math.ceil((length - last) / period - 0.5));
  const moved = new Float64Array(before + bounds.length + after);
  for (let i = 0; i < before; i++) moved[i] = first - (before - i) * period;
  for (let i = 0; i < bounds.length; i++) moved[before + i] = bounds[i] + shift;
  for (let i = 1; i <= after; i++) moved[before + bounds.length - 1 + i] = last + i * period;
  return keepInside(moved, length);
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
  let suggestion: GridFit['suggestion'];
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
    const elastic = options.elastic;
    const trusted = (notes.includes('weak-grid') ? 1 : chosen.quality) >= PARAMS.elastic.minQuality;
    const anchor = anchorOf(selection, extras);
    const fixed = options.fixedPeriod;
    // The CLI (typedSize) keeps its own elastic rule; the limit is for the period that the user sets in the app.
    const userPeriod = !extras.typedSize && ((!!fixed && positive(fixed.x) && positive(fixed.y)) || (!!selection && positive(selection.w) && positive(selection.h)));
    const x = fitAxis(edges.x, chosen.x, hasNudge ? nudge.x : 0, elastic, trusted, anchor ? anchor.x : null, userPeriod);
    const y = fitAxis(edges.y, chosen.y, hasNudge ? nudge.y : 0, elastic, trusted, anchor ? anchor.y : null, userPeriod);
    if (x.fit.adapted || y.fit.adapted) notes.push('elastic');
    grid = { x: x.bounds, y: y.bounds };
    axes = { x: x.fit, y: y.fit };
    quality = notes.includes('weak-grid') ? 1 : chosen.quality;
    suggestion = chosen.suggestion;
  }
  const cols = grid.x.length - 1;
  const rows = grid.y.length - 1;
  if (cols < 1 || rows < 1) throw new CoreError('internal', 'The grid has no cells.');
  if (cols * rows > PARAMS.limits.maxCells) {
    throw new CoreError('too-many-cells', `The grid has ${cols} x ${rows} cells; the limit is ${PARAMS.limits.maxCells}.`);
  }
  const fit: GridFit = { grid, cols, rows, axes, quality, notes };
  if (suggestion) fit.suggestion = suggestion;
  return fit;
}

/** Throws CoreError('internal') when the bounds of one axis cannot be a grid of an image of `length` pixels. */
function checkBounds(bounds: Float64Array, length: number, axis: 'x' | 'y'): void {
  const fail = (detail: string) => {
    throw new CoreError('internal', `The ${axis} grid lines are not valid: ${detail}`);
  };
  if (bounds.length < 2) fail(`it needs 2 lines or more (got ${bounds.length}).`);
  const { minSpacing } = PARAMS.manualGrid;
  for (let i = 0; i < bounds.length; i++) {
    if (!Number.isFinite(bounds[i])) fail(`line ${i} is not a finite number.`);
    if (i === 0) continue;
    const spacing = bounds[i] - bounds[i - 1];
    if (!(spacing >= minSpacing)) fail(`lines ${i - 1} and ${i} are ${spacing} pixels apart; the minimum is ${minSpacing} and the lines must ascend.`);
    const center = (bounds[i] + bounds[i - 1]) / 2;
    if (center < 0 || center >= length) fail(`cell ${i - 1} has its center at ${center}, outside the image (0 to ${length}).`);
  }
  // Like a fitted grid, the strip that no cell covers at each end stays below one cell.
  if (bounds[0] >= bounds[1] - bounds[0]) fail(`the first line (${bounds[0]}) leaves a strip wider than the first cell at the start.`);
  const last = bounds.length - 1;
  if (length - bounds[last] >= bounds[last] - bounds[last - 1]) fail(`the last line (${bounds[last]}) leaves a strip wider than the last cell at the end (${length}).`);
}

function medianSpacing(bounds: Float64Array): number {
  const spacings = new Float64Array(bounds.length - 1);
  for (let i = 1; i < bounds.length; i++) spacings[i - 1] = bounds[i] - bounds[i - 1];
  spacings.sort();
  const middle = spacings.length >> 1;
  return spacings.length % 2 === 1 ? spacings[middle] : (spacings[middle - 1] + spacings[middle]) / 2;
}

/**
 * The fit of a grid whose lines the user placed. Each axis reports the median spacing as its period, the first
 * line modulo that period as its offset, and the coherence of that period; quality uses the same measure as the
 * other fits. Throws CoreError('internal') for invalid lines and CoreError('too-many-cells') above the limit.
 */
export function manualGridFit(width: number, height: number, edges: EdgeProfiles, grid: CellGrid): GridFit {
  const x = Float64Array.from(grid.x);
  const y = Float64Array.from(grid.y);
  checkBounds(x, width, 'x');
  checkBounds(y, height, 'y');
  const cols = x.length - 1;
  const rows = y.length - 1;
  if (cols * rows > PARAMS.limits.maxCells) {
    throw new CoreError('too-many-cells', `The grid has ${cols} x ${rows} cells; the limit is ${PARAMS.limits.maxCells}.`);
  }
  const axis = (bounds: Float64Array, axisEdges: AxisEdges) => {
    const period = medianSpacing(bounds);
    const result = measurePeriod(axisEdges, period);
    return { result, fit: { period, offset: boxOffset(bounds[0], period), coherence: result.coherence, adapted: true } };
  };
  const ax = axis(x, edges.x);
  const ay = axis(y, edges.y);
  return { grid: { x, y }, cols, rows, axes: { x: ax.fit, y: ay.fit }, quality: significanceQuality(ax.result, ay.result), notes: ['manual'] };
}
