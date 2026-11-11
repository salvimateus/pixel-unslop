import { resolve } from 'node:path';
import { encodePng } from '../core/png.ts';
import { exportSprite } from '../core/pipeline.ts';
import { PARAMS } from '../core/params.ts';
import type { ElasticMode } from '../core/types.ts';
import { CliError, errorLine, toCliError, usage } from './errors.ts';
import { checkFolder, derivedPath, paletteText, readPalette, samePath, writeOutput } from './files.ts';
import type { Operation } from './operations.ts';
import { gridPreview } from './preview.ts';
import {
  combinedPalette,
  fitReport,
  hexList,
  isFailed,
  paletteReport,
  processInputs,
  transparentCount,
  type CleanSettings,
  type Processed,
} from './process.ts';
import { parseCleanup, parseOffset, parsePixelSize, parseScale, parseSwap, parseWhole, type ScaleChoice } from './values.ts';

/** Options shared by `clean` and `inspect`, for node:util parseArgs. */
export const PIPELINE_OPTIONS = {
  'pixel-size': { type: 'string' },
  exact: { type: 'boolean' },
  offset: { type: 'string' },
  elastic: { type: 'string' },
  'shared-pixel-size': { type: 'boolean' },
  cleanup: { type: 'string' },
  'max-colors': { type: 'string' },
  palette: { type: 'string' },
  'shared-palette': { type: 'boolean' },
  'erase-background': { type: 'boolean' },
  swap: { type: 'string', multiple: true },
  'grid-preview': { type: 'string' },
  overwrite: { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

export const CLEAN_OPTIONS = {
  ...PIPELINE_OPTIONS,
  output: { type: 'string', short: 'o' },
  'out-dir': { type: 'string' },
  'write-palette': { type: 'string' },
  scale: { type: 'string' },
} as const;

type PipelineValues = {
  'pixel-size'?: string;
  exact?: boolean;
  offset?: string;
  elastic?: string;
  'shared-pixel-size'?: boolean;
  cleanup?: string;
  'max-colors'?: string;
  palette?: string;
  'shared-palette'?: boolean;
  'erase-background'?: boolean;
  swap?: string[];
};

export function settingsFrom(values: PipelineValues): CleanSettings {
  const elastic = (values.elastic ?? 'auto').toLowerCase();
  if (elastic !== 'auto' && elastic !== 'on' && elastic !== 'off') throw usage(`--elastic: use auto, on or off (got ${values.elastic}).`);
  if (values.exact && !values['pixel-size']) throw usage('--exact needs --pixel-size.');
  const operations: Operation[] = [];
  if (values.palette) operations.push({ kind: 'palette', colors: readPalette(values.palette) });
  if (values['erase-background']) operations.push({ kind: 'erase-background' });
  for (const swap of values.swap ?? []) operations.push({ kind: 'swap', ...parseSwap(swap, '--swap') });
  return {
    pixelSize: values['pixel-size'] ? parsePixelSize(values['pixel-size']) : undefined,
    exact: !!values.exact,
    offset: values.offset ? parseOffset(values.offset) : undefined,
    elastic: elastic as ElasticMode,
    sharedPixelSize: !!values['shared-pixel-size'],
    strength: values.cleanup ? parseCleanup(values.cleanup) : PARAMS.palette.presets.normal,
    maxColors: values['max-colors'] ? parseWhole(values['max-colors'], '--max-colors', 1) : undefined,
    sharedPalette: !!values['shared-palette'],
    operations,
  };
}

/** With one input, `path` is the preview file; with several, it is a folder for `<name>-grid.png` files. */
export function previewPaths(inputs: string[], path: string | undefined): Map<string, string> {
  const paths = new Map<string, string>();
  if (!path) return paths;
  if (inputs.length === 1) {
    paths.set(inputs[0], resolve(path));
    return paths;
  }
  checkFolder(path);
  for (const input of inputs) paths.set(input, derivedPath(input, '-grid', resolve(path)));
  return paths;
}

export function writePreview(entry: Processed, path: string, overwrite: boolean): void {
  writeOutput(path, encodePng(gridPreview(entry.source.image, entry.fit)), overwrite);
}

function scaleFor(choice: ScaleChoice, entry: Processed): number {
  if (choice !== 'original') return choice;
  return Math.max(1, Math.round((entry.fit.axes.x.period + entry.fit.axes.y.period) / 2));
}

export interface CommandResult { exitCode: 0 | 1; json: unknown; lines: string[]; errors: string[] }

export function runClean(inputs: string[], values: PipelineValues & {
  output?: string;
  'out-dir'?: string;
  'write-palette'?: string;
  scale?: string;
  'grid-preview'?: string;
  overwrite?: boolean;
}): CommandResult {
  if (inputs.length === 0) throw usage('clean needs at least one input PNG file.');
  if (values.output && inputs.length > 1) throw usage('-o/--output works with one input only. Use --out-dir for several inputs.');
  if (values.output && values['out-dir']) throw usage('Use -o/--output or --out-dir, not both.');
  if (values['out-dir']) checkFolder(values['out-dir']);
  const settings = settingsFrom(values);
  const scaleChoice = values.scale ? parseScale(values.scale, true) : 1;
  const overwrite = !!values.overwrite;
  const previews = previewPaths(inputs, values['grid-preview']);

  const { outcomes, sharedPeriod } = processInputs(inputs, settings);
  const lines: string[] = [];
  const errors: string[] = [];
  const results: unknown[] = [];
  const written = new Set<string>();
  const done: Processed[] = [];

  for (const outcome of outcomes) {
    if (isFailed(outcome)) {
      results.push({ input: resolve(outcome.input), ok: false, error: { code: outcome.error.code, message: outcome.error.message } });
      errors.push(errorLine(outcome.error, outcome.input));
      continue;
    }
    try {
      const scale = scaleFor(scaleChoice, outcome);
      const { sprite, fit } = outcome;
      const suffix = `-pixel-${sprite.cols}x${sprite.rows}${scale > 1 ? `-x${scale}` : ''}`;
      const output = values.output ? resolve(values.output) : derivedPath(outcome.input, suffix, values['out-dir'] ? resolve(values['out-dir']) : undefined);
      if (samePath(output, outcome.input)) throw new CliError('output-exists', `The output would replace the input: ${output}`);
      if (written.has(output)) throw new CliError('output-exists', `Two inputs would write the same output: ${output}`);
      writeOutput(output, exportSprite(sprite, scale), overwrite);
      written.add(output);
      const preview = previews.get(outcome.input);
      if (preview) writePreview(outcome, preview, overwrite);
      done.push(outcome);
      const palette = paletteReport(sprite);
      results.push({
        input: resolve(outcome.input),
        ok: true,
        output,
        width: sprite.cols * scale,
        height: sprite.rows * scale,
        scale,
        grid: fitReport(fit),
        colors: palette.length,
        transparentTiles: transparentCount(sprite),
        palette,
        gridPreview: preview ?? null,
      });
      const notes = fit.notes.length > 0 ? `, notes: ${fit.notes.join(' ')}` : '';
      lines.push(
        `${outcome.input} -> ${output} (${sprite.cols}x${sprite.rows} tiles, pixel size ${fit.axes.x.period.toFixed(2)}x${fit.axes.y.period.toFixed(2)}, quality ${fit.quality}/3, ${palette.length} colors, scale ${scale}${notes})`,
      );
      if (preview) lines.push(`  grid preview: ${preview}`);
    } catch (error) {
      const failure = toCliError(error);
      results.push({ input: resolve(outcome.input), ok: false, error: { code: failure.code, message: failure.message } });
      errors.push(errorLine(failure, outcome.input));
    }
  }

  let paletteFile: { path: string; colors: string[] } | null = null;
  if (values['write-palette'] && done.length > 0) {
    const colors = combinedPalette(done.map((entry) => entry.sprite));
    const path = resolve(values['write-palette']);
    try {
      writeOutput(path, paletteText(colors), overwrite);
      paletteFile = { path, colors: hexList(colors) };
      lines.push(`palette: ${path} (${colors.length} colors)`);
    } catch (error) {
      const failure = toCliError(error);
      errors.push(errorLine(failure));
      results.push({ input: null, ok: false, error: { code: failure.code, message: failure.message } });
    }
  }

  const ok = errors.length === 0;
  return {
    exitCode: ok ? 0 : 1,
    lines,
    errors,
    json: {
      ok,
      command: 'clean',
      sharedPixelSize: sharedPeriod ? { x: Math.round(sharedPeriod.x * 10000) / 10000, y: Math.round(sharedPeriod.y * 10000) / 10000 } : null,
      results,
      paletteFile,
    },
  };
}
