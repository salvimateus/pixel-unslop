import { alignedBlock, alignedImage, sampleCells } from './cells.ts';
import { computeProfiles, type EdgeProfiles } from './edge-profile.ts';
import { CoreError } from './errors.ts';
import { fitGrid, type FitExtras } from './grid.ts';
import { mergePalette } from './palette.ts';
import { PARAMS } from './params.ts';
import { decodeImage, encodePng, validateImage } from './png.ts';
import type { MergeOptions } from './protocol.ts';
import { scaleNearest } from './sprite.ts';
import type { GridFit, GridOptions, RasterImage, Selection, Sprite } from './types.ts';

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

/** The flat tile colors before the palette merge. */
export function sampleSource(source: Source, fit: GridFit, onProgress?: (ratio: number) => void): Sprite {
  return sampleCells(source.image, fit.grid, onProgress);
}

export function mergeSprite(raw: Sprite, merge: MergeOptions): { sprite: Sprite; palette: Uint32Array } {
  return mergePalette(raw, merge);
}

/** The source with each cell drawn as a uniform square block, for the before/after comparison. */
export function alignSource(source: Source, fit: GridFit): RasterImage {
  return alignedImage(source.image, fit.grid, alignedBlock(fit.axes.x.period, fit.axes.y.period, fit.cols, fit.rows));
}

/** Integer upscale factor checked against the export limit. */
export function checkScale(sprite: Sprite, scale: number): number {
  if (!Number.isInteger(scale) || scale < 1) throw new CoreError('internal', `The scale must be a whole number of 1 or more (got ${scale}).`);
  const side = Math.max(sprite.cols, sprite.rows) * scale;
  if (side > PARAMS.limits.maxExportSide) {
    throw new CoreError('too-large', `The export would be ${side} pixels wide or high; the limit is ${PARAMS.limits.maxExportSide}.`);
  }
  return scale;
}

export function exportSprite(sprite: Sprite, scale: number): Uint8Array {
  return encodePng(scaleNearest(sprite, checkScale(sprite, scale)));
}
