import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { TRANSPARENT, fromHex, pack, toHex } from '../core/color.ts';
import { decodeRaster, isPng } from '../core/png.ts';
import { listPalette } from '../core/sprite.ts';
import { CliError } from './errors.ts';

export function readInput(path: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CliError('file-not-found', `File not found: ${path}`);
    if (code === 'EISDIR') throw new CliError('read-failed', `The path is a folder, not a file: ${path}`);
    throw new CliError('read-failed', `Cannot read ${path}: ${(error as Error).message}`);
  }
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isPng(data)) throw new CliError('not-an-image', `Not a PNG file: ${path}. The CLI accepts PNG input only.`);
  return data;
}

/** Writes a file. Without `overwrite`, an existing file is an error and stays as it is. */
export function writeOutput(path: string, bytes: Uint8Array | string, overwrite: boolean): void {
  try {
    writeFileSync(path, bytes, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new CliError('output-exists', `The output exists: ${path}. Add --overwrite to replace it.`);
    if (code === 'ENOENT') throw new CliError('write-failed', `The output folder does not exist: ${dirname(path)}`);
    throw new CliError('write-failed', `Cannot write ${path}: ${(error as Error).message}`);
  }
}

export function checkFolder(path: string): void {
  let isFolder = false;
  try {
    isFolder = statSync(path).isDirectory();
  } catch {
    throw new CliError('file-not-found', `The folder does not exist: ${path}`);
  }
  if (!isFolder) throw new CliError('usage', `Not a folder: ${path}`);
}

/** `<folder>/<input name><suffix>.png`, next to the input unless a folder is given. */
export function derivedPath(input: string, suffix: string, folder?: string): string {
  const name = basename(input, extname(input));
  return join(folder ?? dirname(resolve(input)), `${name}${suffix}.png`);
}

export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** A palette file: a text file with one color per line, or a PNG whose opaque colors are the palette. */
export function readPalette(path: string): Uint32Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(code === 'ENOENT' ? 'file-not-found' : 'read-failed', `Cannot read the palette ${path}: ${(error as Error).message}`);
  }
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(data)) {
    const image = decodeRaster(data);
    const pixels = new Uint32Array(image.width * image.height);
    for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
      const d = image.data;
      pixels[i] = d[o + 3] < 128 ? TRANSPARENT : pack(d[o], d[o + 1], d[o + 2]);
    }
    const colors = listPalette(pixels).map((entry) => entry.color);
    if (colors.length === 0) throw new CliError('bad-palette', `The palette image has no opaque color: ${path}`);
    return Uint32Array.from(colors);
  }
  const colors: number[] = [];
  const lines = bytes.toString('utf8').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/[;,].*$/, '').trim();
    if (line === '' || line.startsWith('//')) return;
    const color = fromHex(line);
    if (color === null) throw new CliError('bad-palette', `Line ${index + 1} of ${path} is not a color: "${raw.trim()}"`);
    if (!colors.includes(color)) colors.push(color);
  });
  if (colors.length === 0) throw new CliError('bad-palette', `The palette file has no color: ${path}`);
  return Uint32Array.from(colors);
}

export function paletteText(colors: ArrayLike<number>): string {
  let text = '';
  for (let i = 0; i < colors.length; i++) text += `${toHex(colors[i])}\n`;
  return text;
}
