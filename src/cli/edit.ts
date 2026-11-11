import { resolve } from 'node:path';
import { exportSprite } from '../core/pipeline.ts';
import { decodeRaster } from '../core/png.ts';
import { spriteFromRaster } from '../core/sprite.ts';
import { CliError, usage } from './errors.ts';
import { derivedPath, readInput, readPalette, samePath, writeOutput } from './files.ts';
import { applyOperations, type Operation } from './operations.ts';
import type { CommandResult } from './clean.ts';
import { paletteReport, transparentCount } from './process.ts';
import { parseColor, parseScale, parseSwap, parseTile, parseTileColor, parseWhole } from './values.ts';

export const EDIT_OPTIONS = {
  set: { type: 'string', multiple: true },
  erase: { type: 'string', multiple: true },
  fill: { type: 'string', multiple: true },
  swap: { type: 'string', multiple: true },
  'erase-color': { type: 'string', multiple: true },
  'erase-background': { type: 'boolean', multiple: true },
  palette: { type: 'string', multiple: true },
  'from-scale': { type: 'string' },
  scale: { type: 'string' },
  output: { type: 'string', short: 'o' },
  overwrite: { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

/** An option token of parseArgs, in command line order. */
export interface OptionToken { name: string; value?: string }

/** The edit operations, in the order of the command line. */
export function operationsFrom(tokens: OptionToken[]): Operation[] {
  const operations: Operation[] = [];
  for (const { name, value = '' } of tokens) {
    switch (name) {
      case 'set':
        operations.push({ kind: 'set', ...parseTileColor(value, '--set') });
        break;
      case 'erase':
        operations.push({ kind: 'erase', ...parseTile(value, '--erase') });
        break;
      case 'fill':
        operations.push({ kind: 'fill', ...parseTileColor(value, '--fill') });
        break;
      case 'swap':
        operations.push({ kind: 'swap', ...parseSwap(value, '--swap') });
        break;
      case 'erase-color':
        operations.push({ kind: 'erase-color', color: parseColor(value, '--erase-color') });
        break;
      case 'erase-background':
        operations.push({ kind: 'erase-background' });
        break;
      case 'palette':
        operations.push({ kind: 'palette', colors: readPalette(value) });
        break;
    }
  }
  return operations;
}

export function runEdit(
  inputs: string[],
  values: { 'from-scale'?: string; scale?: string; output?: string; overwrite?: boolean },
  tokens: OptionToken[],
): CommandResult {
  if (inputs.length !== 1) throw usage('edit needs exactly one input sprite PNG file.');
  const input = inputs[0];
  const operations = operationsFrom(tokens);
  const blockSize = values['from-scale'] ? parseWhole(values['from-scale'], '--from-scale', 1) : 1;
  const scale = values.scale ? (parseScale(values.scale, false) as number) : 1;
  const image = decodeRaster(readInput(input));
  if (image.width % blockSize !== 0 || image.height % blockSize !== 0) {
    throw usage(`--from-scale ${blockSize}: the image (${image.width}x${image.height}) is not a whole number of ${blockSize}x${blockSize} blocks.`);
  }
  const sprite = applyOperations(spriteFromRaster(image, blockSize), operations);
  const output = values.output ? resolve(values.output) : derivedPath(input, '-edited');
  if (samePath(output, input) && !values.overwrite) {
    throw new CliError('output-exists', `The output is the input: ${output}. Add --overwrite to replace it.`);
  }
  writeOutput(output, exportSprite(sprite, scale), !!values.overwrite);
  const palette = paletteReport(sprite);
  return {
    exitCode: 0,
    lines: [`${input} -> ${output} (${sprite.cols}x${sprite.rows} tiles, ${operations.length} operations, ${palette.length} colors, scale ${scale})`],
    errors: [],
    json: {
      ok: true,
      command: 'edit',
      input: resolve(input),
      output,
      cols: sprite.cols,
      rows: sprite.rows,
      scale,
      width: sprite.cols * scale,
      height: sprite.rows * scale,
      operations: operations.length,
      colors: palette.length,
      transparentTiles: transparentCount(sprite),
      palette,
    },
  };
}
