import { resolve } from 'node:path';
import { errorLine, toCliError, usage } from './errors.ts';
import { previewPaths, settingsFrom, writePreview, type CommandResult } from './clean.ts';
import { fitReport, isFailed, paletteReport, processInputs, transparentCount } from './process.ts';

export function runInspect(
  inputs: string[],
  values: Parameters<typeof settingsFrom>[0] & { 'grid-preview'?: string; overwrite?: boolean },
): CommandResult {
  if (inputs.length === 0) throw usage('inspect needs at least one input PNG file.');
  const settings = settingsFrom(values);
  const previews = previewPaths(inputs, values['grid-preview']);
  const { outcomes, sharedPeriod } = processInputs(inputs, settings);
  const lines: string[] = [];
  const errors: string[] = [];
  const results: unknown[] = [];
  for (const outcome of outcomes) {
    if (isFailed(outcome)) {
      results.push({ input: resolve(outcome.input), ok: false, error: { code: outcome.error.code, message: outcome.error.message } });
      errors.push(errorLine(outcome.error, outcome.input));
      continue;
    }
    const { source, fit, sprite } = outcome;
    let preview: string | null = previews.get(outcome.input) ?? null;
    try {
      if (preview) writePreview(outcome, preview, !!values.overwrite);
    } catch (error) {
      const failure = toCliError(error);
      errors.push(errorLine(failure));
      preview = null;
    }
    const palette = paletteReport(sprite);
    const grid = fitReport(fit);
    results.push({
      input: resolve(outcome.input),
      ok: true,
      width: source.image.width,
      height: source.image.height,
      grid,
      colors: palette.length,
      transparentTiles: transparentCount(sprite),
      palette,
      gridPreview: preview,
    });
    lines.push(`${outcome.input}`);
    lines.push(`  image: ${source.image.width}x${source.image.height} px`);
    lines.push(`  tiles: ${fit.cols}x${fit.rows}`);
    lines.push(`  pixel size: x ${grid.pixelSize.x} px, y ${grid.pixelSize.y} px`);
    lines.push(`  offset: x ${grid.offset.x} px, y ${grid.offset.y} px`);
    lines.push(`  coherence: x ${grid.coherence.x}, y ${grid.coherence.y}`);
    lines.push(`  elastic: x ${grid.elastic.x}, y ${grid.elastic.y}`);
    lines.push(`  quality: ${fit.quality}/3${fit.notes.length > 0 ? `, notes: ${fit.notes.join(' ')}` : ''}`);
    lines.push(`  palette (${palette.length}): ${palette.map((entry) => `${entry.color}x${entry.count}`).join(' ')}`);
    if (preview) lines.push(`  grid preview: ${preview}`);
  }
  if (sharedPeriod) lines.unshift(`shared pixel size: x ${sharedPeriod.x.toFixed(4)} px, y ${sharedPeriod.y.toFixed(4)} px`);
  const ok = errors.length === 0;
  return {
    exitCode: ok ? 0 : 1,
    lines,
    errors,
    json: {
      ok,
      command: 'inspect',
      sharedPixelSize: sharedPeriod ? { x: Math.round(sharedPeriod.x * 10000) / 10000, y: Math.round(sharedPeriod.y * 10000) / 10000 } : null,
      results,
    },
  };
}
