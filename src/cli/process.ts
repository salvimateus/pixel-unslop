import { toHex } from '../core/color.ts';
import { applyColorMap, combinedColors, matchColors, matchToReference, mergePalette, mergeShared, paletteOf, type ColorCount } from '../core/palette.ts';
import { fitSource, sampleSource, sharedPeriodOf, sourceFromPng, type Source } from '../core/pipeline.ts';
import { heightLimit, listPalette, trimSprite, wholeHeights } from '../core/sprite.ts';
import type { ElasticMode, GridFit, GridOptions, Selection, Sprite } from '../core/types.ts';
import { toCliError, type CliError } from './errors.ts';
import { readInput } from './files.ts';
import { applyOperations, cropToOpaque, resizeToHeight, type Operation } from './operations.ts';

export interface CleanSettings {
  pixelSize?: { x: number; y: number };
  exact: boolean;
  offset?: { x: number; y: number };
  elastic: ElasticMode;
  sharedPixelSize: boolean;
  strength: number;
  maxColors?: number;
  sharedPalette: boolean;
  /** The colors of --reference with their counts, applied right after the palette merge. */
  reference?: ColorCount[];
  /** Applied in this order after the palette merge and the reference: --palette, --erase-background, then each --swap. */
  operations: Operation[];
  /** Crop each result to the box of its opaque tiles, after the operations (the default; false with --no-trim). */
  trim: boolean;
  /** Target height per input, parallel to the inputs; null keeps the height. */
  heights: Array<number | null>;
}

/** The box of the opaque tiles, before the resize: the output size unless --no-trim. */
export interface ObjectSize { cols: number; rows: number }
export interface Resize { fromRows: number; height: number; step: number }

export interface Processed { input: string; source: Source; fit: GridFit; sprite: Sprite; object: ObjectSize | null; resize: Resize | null }
export interface Failed { input: string; error: CliError }
export type Outcome = Processed | Failed;

export function isFailed(outcome: Outcome): outcome is Failed {
  return 'error' in outcome;
}

function gridOptions(settings: CleanSettings): GridOptions {
  const options: GridOptions = { elastic: settings.elastic };
  if (settings.exact && settings.pixelSize) options.fixedPeriod = settings.pixelSize;
  if (settings.offset) options.nudge = settings.offset;
  return options;
}

function selectionOf(settings: CleanSettings): Selection | null {
  if (!settings.pixelSize || settings.exact) return null;
  return { x: 0, y: 0, w: settings.pixelSize.x, h: settings.pixelSize.y };
}

/** Runs the full clean pipeline on each input. A failed input does not stop the others. */
export function processInputs(inputs: string[], settings: CleanSettings): { outcomes: Outcome[]; sharedPeriod: { x: number; y: number } | null } {
  const loaded: Array<{ input: string; source: Source } | Failed> = inputs.map((input) => {
    try {
      return { input, source: sourceFromPng(readInput(input)) };
    } catch (error) {
      return { input, error: toCliError(error) };
    }
  });
  const sources = loaded.filter((entry): entry is { input: string; source: Source } => !('error' in entry));

  let sharedPeriod: { x: number; y: number } | null = null;
  if (settings.sharedPixelSize && !settings.pixelSize) sharedPeriod = sharedPeriodOf(sources.map((entry) => entry.source));

  const options = gridOptions(settings);
  const selection = selectionOf(settings);
  // WxH with two different values is an explicit request for non-square art pixels.
  const nonSquare = !!settings.pixelSize && settings.pixelSize.x !== settings.pixelSize.y;
  const fitted: Array<{ input: string; source: Source; fit: GridFit; raw: Sprite } | Failed> = loaded.map((entry) => {
    if ('error' in entry) return entry;
    try {
      const fit = fitSource(entry.source, selection, options, { sharedPeriod: sharedPeriod ?? undefined, nonSquare, typedSize: true });
      return { ...entry, fit, raw: sampleSource(entry.source, fit) };
    } catch (error) {
      return { input: entry.input, error: toCliError(error) };
    }
  });

  const merge = { strength: settings.strength, maxColors: settings.maxColors };
  const good = fitted.filter((entry): entry is { input: string; source: Source; fit: GridFit; raw: Sprite } => !('error' in entry));
  const merged = new Map<string, Sprite>();
  if (settings.sharedPalette) {
    const sprites = mergeShared(good.map((entry) => entry.raw), merge);
    good.forEach((entry, i) => merged.set(entry.input, sprites[i]));
  } else {
    for (const entry of good) merged.set(entry.input, mergePalette(entry.raw, merge).sprite);
  }
  const reference = settings.reference;
  if (reference) {
    const sprites = good.map((entry) => merged.get(entry.input) as Sprite);
    // One map for all inputs, so a shared color cannot take two reference colors.
    const shared = settings.sharedPalette ? matchColors(combinedColors(sprites), reference) : null;
    good.forEach((entry, i) => merged.set(entry.input, shared ? applyColorMap(sprites[i], shared) : matchToReference(sprites[i], reference)));
  }

  const outcomes = fitted.map((entry, index): Outcome => {
    if ('error' in entry) return entry;
    try {
      let sprite = applyOperations(merged.get(entry.input) as Sprite, settings.operations);
      let object: ObjectSize | null = null;
      let resize: Resize | null = null;
      if (settings.trim) {
        sprite = cropToOpaque(sprite);
        object = { cols: sprite.cols, rows: sprite.rows };
      } else if (sprite.pixels.some((color) => color !== 0)) {
        const box = trimSprite(sprite);
        object = { cols: box.cols, rows: box.rows };
      }
      const height = settings.heights[index] ?? null;
      if (height !== null) {
        const fromRows = sprite.rows;
        const resized = resizeToHeight(sprite, height);
        sprite = resized.sprite;
        resize = { fromRows, height, step: resized.step };
      }
      return { input: entry.input, source: entry.source, fit: entry.fit, sprite, object, resize };
    } catch (error) {
      return { input: entry.input, error: toCliError(error) };
    }
  });
  return { outcomes, sharedPeriod };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function fitReport(fit: GridFit) {
  return {
    cols: fit.cols,
    rows: fit.rows,
    pixelSize: { x: round(fit.axes.x.period), y: round(fit.axes.y.period) },
    offset: { x: round(fit.axes.x.offset), y: round(fit.axes.y.offset) },
    coherence: { x: round(fit.axes.x.coherence), y: round(fit.axes.y.coherence) },
    elastic: { x: fit.axes.x.adapted, y: fit.axes.y.adapted },
    quality: fit.quality,
    notes: fit.notes,
  };
}

/** The trimmed size and the height of each whole reduction (the values that --height accepts as 1/k). */
export function objectReport(object: ObjectSize | null) {
  if (!object) return null;
  const reductions: Record<string, number> = {};
  for (const size of wholeHeights(object.rows, heightLimit(object.cols, object.rows))) {
    if (size.step > 1) reductions[`1/${size.step}`] = size.height;
  }
  return { cols: object.cols, rows: object.rows, reductions };
}

export function resizeReport(resize: Resize | null) {
  return resize ? { fromRows: resize.fromRows, height: resize.height, step: round(resize.step) } : null;
}

export function paletteReport(sprite: Sprite) {
  return listPalette(sprite.pixels).map((entry) => ({ color: toHex(entry.color), count: entry.count }));
}

export function transparentCount(sprite: Sprite): number {
  let count = 0;
  for (const color of sprite.pixels) if (color === 0) count++;
  return count;
}

/** Colors of several sprites, sorted by the summed count descending, then by value ascending. */
export function combinedPalette(sprites: Sprite[]): Uint32Array {
  if (sprites.length === 1) return paletteOf(sprites[0]);
  const counts = new Map<number, number>();
  for (const sprite of sprites) for (const { color, count } of listPalette(sprite.pixels)) counts.set(color, (counts.get(color) ?? 0) + count);
  return Uint32Array.from([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([color]) => color));
}

export function hexList(colors: ArrayLike<number>): string[] {
  return Array.from(colors, (color) => toHex(color));
}
