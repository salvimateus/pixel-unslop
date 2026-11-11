import { TRANSPARENT, fromHex } from '../core/color.ts';
import { PARAMS } from '../core/params.ts';
import { usage } from './errors.ts';

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function parseNumber(text: string, flag: string): number {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) throw usage(`${flag}: "${text}" is not a number.`);
  return Number(trimmed);
}

export function parsePositive(text: string, flag: string): number {
  const value = parseNumber(text, flag);
  if (!(value > 0)) throw usage(`${flag}: the value must be above 0 (got ${text}).`);
  return value;
}

export function parseWhole(text: string, flag: string, min: number): number {
  const value = parseNumber(text, flag);
  if (!Number.isInteger(value) || value < min) throw usage(`${flag}: the value must be a whole number of ${min} or more (got ${text}).`);
  return value;
}

/** `n` or `WxH`, in source pixels. */
export function parsePixelSize(text: string): { x: number; y: number } {
  const parts = text.toLowerCase().split('x');
  if (parts.length === 1) {
    const size = parsePositive(parts[0], '--pixel-size');
    return { x: size, y: size };
  }
  if (parts.length === 2) return { x: parsePositive(parts[0], '--pixel-size'), y: parsePositive(parts[1], '--pixel-size') };
  throw usage(`--pixel-size: use a number or WxH (got ${text}).`);
}

/** `x,y` with float values. */
export function parseOffset(text: string): { x: number; y: number } {
  const parts = text.split(',');
  if (parts.length !== 2) throw usage(`--offset: use x,y (got ${text}).`);
  return { x: parseNumber(parts[0], '--offset'), y: parseNumber(parts[1], '--offset') };
}

export type ScaleChoice = number | 'original';

export function parseScale(text: string, allowOriginal: boolean): ScaleChoice {
  if (allowOriginal && text.trim().toLowerCase() === 'original') return 'original';
  return parseWhole(text, '--scale', 1);
}

export function parseCleanup(text: string): number {
  const presets = PARAMS.palette.presets;
  const key = text.trim().toLowerCase();
  if (key === 'off' || key === 'light' || key === 'normal' || key === 'strong') return presets[key];
  const value = parseNumber(text, '--cleanup');
  if (value < 0) throw usage(`--cleanup: the value must be 0 or more (got ${text}).`);
  return value;
}

/** `#rrggbb`, `#rgb` or `transparent`. */
export function parseColor(text: string, flag: string): number {
  if (text.trim().toLowerCase() === 'transparent') return TRANSPARENT;
  const color = fromHex(text);
  if (color === null) throw usage(`${flag}: "${text}" is not a color. Use #rrggbb or transparent.`);
  return color;
}

/** `from=to`. */
export function parseSwap(text: string, flag: string): { from: number; to: number } {
  const parts = text.split('=');
  if (parts.length !== 2) throw usage(`${flag}: use from=to (got ${text}).`);
  return { from: parseColor(parts[0], flag), to: parseColor(parts[1], flag) };
}

/** `x,y` tile coordinates. */
export function parseTile(text: string, flag: string): { x: number; y: number } {
  const parts = text.split(',');
  if (parts.length !== 2) throw usage(`${flag}: use x,y (got ${text}).`);
  return { x: parseWhole(parts[0], flag, 0), y: parseWhole(parts[1], flag, 0) };
}

/** `x,y=color`. */
export function parseTileColor(text: string, flag: string): { x: number; y: number; color: number } {
  const index = text.indexOf('=');
  if (index < 0) throw usage(`${flag}: use x,y=color (got ${text}).`);
  return { ...parseTile(text.slice(0, index), flag), color: parseColor(text.slice(index + 1), flag) };
}
