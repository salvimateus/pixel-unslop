import { toHex } from '../core/color.ts';
import { mergePalette, mergeShared, paletteOf } from '../core/palette.ts';
import { fitSource, sampleSource, sourceFromPng, type Source } from '../core/pipeline.ts';
import { detectPeriods } from '../core/pitch.ts';
import { listPalette } from '../core/sprite.ts';
import type { ElasticMode, GridFit, GridOptions, Selection, Sprite } from '../core/types.ts';
import { toCliError, type CliError } from './errors.ts';
import { readInput } from './files.ts';
import { applyOperations, type Operation } from './operations.ts';

export interface CleanSettings {
  pixelSize?: { x: number; y: number };
  exact: boolean;
  offset?: { x: number; y: number };
  elastic: ElasticMode;
  sharedPixelSize: boolean;
  strength: number;
  maxColors?: number;
  sharedPalette: boolean;
  /** Applied in this order after the palette merge: --palette, --erase-background, then each --swap. */
  operations: Operation[];
}

export interface Processed { input: string; source: Source; fit: GridFit; sprite: Sprite }
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
  if (settings.sharedPixelSize && !settings.pixelSize && sources.length > 0) {
    sharedPeriod = detectPeriods(
      sources.map((entry) => entry.source.edges.x),
      sources.map((entry) => entry.source.edges.y),
    );
  }

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

  const outcomes = fitted.map((entry): Outcome => {
    if ('error' in entry) return entry;
    try {
      const sprite = applyOperations(merged.get(entry.input) as Sprite, settings.operations);
      return { input: entry.input, source: entry.source, fit: entry.fit, sprite };
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
