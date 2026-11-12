import { alignedBlock, alignedImage, sampleCells } from './cells.ts';
import { computeProfiles, type EdgeProfiles } from './edge-profile.ts';
import { CoreError } from './errors.ts';
import { fitGrid, manualGridFit, type FitExtras } from './grid.ts';
import { mergePalette, type ColorCount } from './palette.ts';
import { PARAMS } from './params.ts';
import { detectPeriods } from './pitch.ts';
import { decodeImage, encodePng, encodePngSmallest, validateImage } from './png.ts';
import type { MergeOptions, SetGrid } from './protocol.ts';
import { listPalette, spriteFromRaster, spriteToRaster } from './sprite.ts';
import type { AxisFit, CellGrid, GridFit, GridOptions, RasterImage, Selection, Sprite } from './types.ts';

/** A decoded image with the edge evidence that every fit reuses. */
export interface Source { image: RasterImage; edges: EdgeProfiles }

export const AUTO_OPTIONS: GridOptions = { elastic: 'auto' };

export function sourceFromImage(image: RasterImage): Source {
  validateImage(image);
  return { image, edges: computeProfiles(image) };
}

export function sourceFromPng(bytes: Uint8Array): Source {
  const image = decodeImage(bytes);
  return { image, edges: computeProfiles(image) };
}

export function fitSource(source: Source, selection: Selection | null, options: GridOptions, extras?: FitExtras): GridFit {
  return fitGrid(source.image.width, source.image.height, source.edges, selection, options, extras);
}

/** The fit of grid lines that the user placed on the source (see manualGridFit). */
export function manualFitSource(source: Source, grid: CellGrid): GridFit {
  return manualGridFit(source.image.width, source.image.height, source.edges, grid);
}

/** The joint square period of several sources (the period of --shared-pixel-size), or null when no period scores. */
export function sharedPeriodOf(sources: Source[]): { x: number; y: number } | null {
  if (sources.length === 0) return null;
  const joint = detectPeriods(
    sources.map((source) => source.edges.x),
    sources.map((source) => source.edges.y),
  );
  return joint ? { x: joint.x, y: joint.y } : null;
}

/** Throws CoreError('internal') when a fixed set period is not two finite positive numbers. */
export function checkSetGrid(grid: SetGrid): void {
  if (grid?.kind === 'own' || grid?.kind === 'shared') return;
  const period = grid?.kind === 'fixed' ? grid.period : undefined;
  const valid = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!period || !valid(period.x) || !valid(period.y)) throw new CoreError('internal', 'The set grid must be own, shared, or fixed with a positive period.');
}

/** The fit of a source on the joint period of its set (the fit of --shared-pixel-size). */
export function jointFit(source: Source, shared: { x: number; y: number }): GridFit {
  return fitSource(source, null, AUTO_OPTIONS, { sharedPeriod: shared });
}

/**
 * The fit of one source of a set. `own` is the automatic fit of the source alone and `joint` its fit on the
 * joint period, or null when the set has no joint period; then the shared mode gives the own fit.
 * A fixed period is used exactly; the phase is still detected.
 */
export function fitSetSource(source: Source, grid: SetGrid, own: GridFit, joint: GridFit | null): GridFit {
  switch (grid.kind) {
    case 'own':
      return own;
    case 'shared':
      return joint ?? own;
    case 'fixed':
      return fitSource(source, null, { ...AUTO_OPTIONS, fixedPeriod: grid.period });
  }
}

function meanCoherence(fit: GridFit): number {
  return (fit.axes.x.coherence + fit.axes.y.coherence) / 2;
}

/**
 * 'shared' when two or more sources have a joint fit, each own fit of quality 3 is within
 * PARAMS.set.sharedTolerance of the joint period on both axes, and the lower median source keeps at least
 * PARAMS.set.minSharedKeep of its own grid coherence under the joint period; else 'own'.
 * A source that is native resolution alone keeps nothing, because a joint period never fits it.
 */
export function suggestedSetGrid(fits: Array<{ own: GridFit; joint: GridFit | null }>): 'own' | 'shared' {
  if (fits.length < 2 || fits.some((entry) => entry.joint === null)) return 'own';
  const near = (own: AxisFit, joint: AxisFit) => Math.abs(own.period - joint.period) <= PARAMS.set.sharedTolerance * joint.period;
  const goodAgree = fits.every(({ own, joint }) => own.quality < 3 || (near(own.axes.x, (joint as GridFit).axes.x) && near(own.axes.y, (joint as GridFit).axes.y)));
  if (!goodAgree) return 'own';
  const keeps = fits
    .map(({ own, joint }) => {
      if (own.notes.includes('native-resolution')) return 0;
      const ownCoherence = meanCoherence(own);
      return ownCoherence > 0 ? meanCoherence(joint as GridFit) / ownCoherence : 1;
    })
    .sort((a, b) => a - b);
  return keeps[Math.floor((keeps.length - 1) / 2)] >= PARAMS.set.minSharedKeep ? 'shared' : 'own';
}

/** The flat tile colors before the palette merge. */
export function sampleSource(source: Source, fit: GridFit, onProgress?: (ratio: number) => void): Sprite {
  return sampleCells(source.image, fit.grid, onProgress);
}

export function mergeSprite(raw: Sprite, merge: MergeOptions): { sprite: Sprite; palette: Uint32Array } {
  return mergePalette(raw, merge);
}

export interface ReferenceTiles { sprite: Sprite; flat: boolean }

/** A reference with few colors is a clean sprite: each pixel is a tile. Other references give the tiles of their automatic grid. */
export function referenceTiles(source: Source): ReferenceTiles {
  if (source.edges.colorCount <= PARAMS.pitch.nativeMaxColors) return { sprite: spriteFromRaster(source.image), flat: true };
  return { sprite: sampleSource(source, fitSource(source, null, AUTO_OPTIONS)), flat: false };
}

/** The colors of a reference with their counts. AI art gets its own palette merge first. */
export function referencePalette(reference: ReferenceTiles, merge: MergeOptions): ColorCount[] {
  const sprite = reference.flat ? reference.sprite : mergePalette(reference.sprite, { strength: merge.strength }).sprite;
  return listPalette(sprite.pixels);
}

/** The source with each cell drawn as a uniform square block, for the before/after comparison. */
export function alignSource(source: Source, fit: GridFit): RasterImage {
  return alignedImage(source.image, fit.grid, alignedBlock(fit.axes.x.period, fit.axes.y.period, fit.cols, fit.rows));
}

/**
 * The PNG of a sprite, always one image pixel per tile: the grid defines what one pixel is.
 * `optimize` gives the smallest lossless PNG; without it the output is plain RGBA8.
 */
export function exportSprite(sprite: Sprite, options: { optimize?: boolean } = {}): Uint8Array {
  const side = Math.max(sprite.cols, sprite.rows);
  if (side > PARAMS.limits.maxExportSide) {
    throw new CoreError('too-large', `The export would be ${side} pixels wide or high; the limit is ${PARAMS.limits.maxExportSide}.`);
  }
  const image = spriteToRaster(sprite);
  return options.optimize ? encodePngSmallest(image) : encodePng(image);
}
