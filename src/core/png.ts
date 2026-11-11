import { decode, encode, hasPngSignature, type DecodedPng } from 'fast-png';
import { CoreError, errorMessage } from './errors.ts';
import { PARAMS } from './params.ts';
import type { RasterImage } from './types.ts';

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && hasPngSignature(bytes);
}

function checkSize(width: number, height: number): void {
  const { minSide, maxPixels } = PARAMS.limits;
  if (width < minSide || height < minSide) {
    throw new CoreError('too-small', `The image is ${width} x ${height}; each side must be at least ${minSide} pixels.`);
  }
  if (width * height > maxPixels) {
    throw new CoreError('too-large', `The image has ${width * height} pixels; the limit is ${maxPixels}.`);
  }
}

/** Rejects sizes outside the limits and fully transparent images. */
export function validateImage(image: RasterImage): RasterImage {
  checkSize(image.width, image.height);
  const data = image.data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return image;
  throw new CoreError('empty-image', 'The image is fully transparent.');
}

/** Decodes any PNG color type and bit depth to RGBA8. Checks only the largest area. */
export function decodeRaster(bytes: Uint8Array): RasterImage {
  if (!isPng(bytes)) throw new CoreError('not-an-image', 'The data is not a PNG file.');
  let png: DecodedPng;
  try {
    png = decode(bytes);
  } catch (error) {
    throw new CoreError('decode-failed', `The PNG file is damaged: ${errorMessage(error)}`);
  }
  const { width, height } = png;
  if (width <= 0 || height <= 0) throw new CoreError('decode-failed', 'The PNG file has no pixels.');
  if (width * height > PARAMS.limits.maxPixels) {
    throw new CoreError('too-large', `The image has ${width * height} pixels; the limit is ${PARAMS.limits.maxPixels}.`);
  }
  return { width, height, data: toRgba8(png) };
}

/** Decodes a PNG for cleaning: rejects sizes outside the limits and fully transparent images. */
export function decodeImage(bytes: Uint8Array): RasterImage {
  return validateImage(decodeRaster(bytes));
}

function toRgba8(png: DecodedPng): Uint8ClampedArray {
  const { width, height, depth, channels, data } = png;
  const out = new Uint8ClampedArray(width * height * 4);
  const max = (1 << depth) - 1;
  const lineSamples = depth < 8 ? Math.ceil((width * depth * channels) / 8) : width * channels;
  const expected = depth < 8 ? lineSamples * height : width * height * channels;
  if (data.length < expected) throw new CoreError('decode-failed', 'The PNG pixel data is shorter than its size.');

  const sample = (row: number, index: number): number => {
    if (depth >= 8) return data[row * lineSamples + index];
    const bit = index * depth;
    const byte = data[row * lineSamples + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (value: number) => (depth === 8 ? value : Math.round((value * 255) / max));

  const palette = png.palette;
  const key = png.transparency;
  if (palette) {
    if (channels !== 1) throw new CoreError('decode-failed', 'The indexed PNG has an invalid channel count.');
    for (let y = 0, o = 0; y < height; y++) {
      for (let x = 0; x < width; x++, o += 4) {
        const entry = palette[sample(y, x)];
        if (!entry) throw new CoreError('decode-failed', 'The PNG uses a palette index out of range.');
        out[o] = entry[0];
        out[o + 1] = entry[1];
        out[o + 2] = entry[2];
        out[o + 3] = entry.length > 3 ? entry[3] : 255;
      }
    }
    return out;
  }

  for (let y = 0, o = 0; y < height; y++) {
    for (let x = 0; x < width; x++, o += 4) {
      const base = x * channels;
      if (channels === 1 || channels === 2) {
        const raw = sample(y, base);
        const gray = to8(raw);
        out[o] = gray;
        out[o + 1] = gray;
        out[o + 2] = gray;
        if (channels === 2) out[o + 3] = to8(sample(y, base + 1));
        else out[o + 3] = key && key.length >= 1 && raw === key[0] ? 0 : 255;
      } else if (channels === 3 || channels === 4) {
        const r = sample(y, base);
        const g = sample(y, base + 1);
        const b = sample(y, base + 2);
        out[o] = to8(r);
        out[o + 1] = to8(g);
        out[o + 2] = to8(b);
        if (channels === 4) out[o + 3] = to8(sample(y, base + 3));
        else out[o + 3] = key && key.length >= 3 && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      } else {
        throw new CoreError('decode-failed', `The PNG has an unsupported channel count (${channels}).`);
      }
    }
  }
  return out;
}

/** RGBA8 PNG. The same image always gives the same bytes. */
export function encodePng(image: RasterImage): Uint8Array {
  return encode({
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    depth: 8,
    channels: 4,
  });
}

/** zlib levels that the smallest encoder tries; on these images a lower level sometimes compresses better. */
const SMALLEST_LEVELS = [9, 3] as const;

/** At or above this many pixels only the first level and palette order are tried, so a large export stays fast. */
const MANY_CANDIDATES_BELOW = 1_000_000;

type PaletteOrder = 'count' | 'scan';
type Level = (typeof SMALLEST_LEVELS)[number];

interface ColorStats {
  /** Distinct RGBA values, packed as r | g << 8 | b << 16 | a << 24 (unsigned). */
  colors: number[];
  counts: Map<number, number>;
  /** Index of the first pixel of each color, in scan order. */
  first: Map<number, number>;
}

function rgbaKey(data: Uint8ClampedArray, o: number): number {
  return (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
}

/** Stops counting above `limit` colors, because no palette can hold more. */
function colorStats(image: RasterImage, limit: number): ColorStats | null {
  const counts = new Map<number, number>();
  const first = new Map<number, number>();
  const colors: number[] = [];
  const { data } = image;
  for (let i = 0, o = 0; o < data.length; i++, o += 4) {
    const key = rgbaKey(data, o);
    const count = counts.get(key);
    if (count === undefined) {
      if (colors.length === limit) return null;
      colors.push(key);
      counts.set(key, 1);
      first.set(key, i);
    } else {
      counts.set(key, count + 1);
    }
  }
  return { colors, counts, first };
}

/**
 * Palette order: the entries that are not fully opaque come first, because tRNS holds the alpha values of
 * the first entries only. Within each group: 'count' sorts by count descending, then by value ascending;
 * 'scan' sorts by the first pixel in scan order.
 */
function paletteOrder(stats: ColorStats, order: PaletteOrder): number[] {
  const opaqueLast = (color: number) => (color >>> 24 === 255 ? 1 : 0);
  return [...stats.colors].sort((a, b) => {
    const group = opaqueLast(a) - opaqueLast(b);
    if (group !== 0) return group;
    if (order === 'scan') return (stats.first.get(a) as number) - (stats.first.get(b) as number);
    return (stats.counts.get(b) as number) - (stats.counts.get(a) as number) || a - b;
  });
}

function indexDepth(colorCount: number): 1 | 2 | 4 | 8 {
  if (colorCount <= 2) return 1;
  if (colorCount <= 4) return 2;
  if (colorCount <= 16) return 4;
  return 8;
}

/** Packed palette indices, `depth` bits per pixel, each row padded to a whole byte. */
function indexedSamples(image: RasterImage, palette: number[], depth: 1 | 2 | 4 | 8): Uint8Array {
  const { width, height, data } = image;
  const index = new Map<number, number>();
  palette.forEach((color, i) => index.set(color, i));
  const lineBytes = Math.ceil((width * depth) / 8);
  const packed = new Uint8Array(lineBytes * height);
  const perByte = 8 / depth;
  for (let y = 0, o = 0; y < height; y++) {
    const line = y * lineBytes;
    for (let x = 0; x < width; x++, o += 4) {
      const value = index.get(rgbaKey(data, o)) as number;
      packed[line + Math.floor(x / perByte)] |= value << (8 - depth * ((x % perByte) + 1));
    }
  }
  return packed;
}

function paletteEntries(palette: number[]): number[][] {
  const withAlpha = palette.some((color) => color >>> 24 !== 255);
  return palette.map((color) => {
    const rgb = [color & 0xff, (color >>> 8) & 0xff, (color >>> 16) & 0xff];
    return withAlpha ? [...rgb, color >>> 24] : rgb;
  });
}

function rgbSamples(image: RasterImage): Uint8Array {
  const { data } = image;
  const samples = new Uint8Array((data.length / 4) * 3);
  for (let i = 0, o = 0; o < data.length; i += 3, o += 4) {
    samples[i] = data[o];
    samples[i + 1] = data[o + 1];
    samples[i + 2] = data[o + 2];
  }
  return samples;
}

/**
 * The smallest lossless PNG of a fixed list of candidates, each at zlib level 9 and 3: indexed at the smallest
 * bit depth and at 8 bits for each palette order (when 256 colors or fewer), truecolor without alpha (when every
 * pixel is opaque) and truecolor with alpha. The plain encodePng output is also a candidate, so the result is
 * never larger. Every RGBA value decodes exactly as given. On equal sizes the plain output wins, then the earlier
 * candidate in this list, so the bytes are fixed.
 */
export function encodePngSmallest(image: RasterImage): Uint8Array {
  const { width, height } = image;
  const many = width * height < MANY_CANDIDATES_BELOW;
  const levels: readonly Level[] = many ? SMALLEST_LEVELS : [SMALLEST_LEVELS[0]];
  const layouts: Array<{ data: Uint8Array; depth: 1 | 2 | 4 | 8; channels: number; palette?: number[][] }> = [];
  const stats = colorStats(image, 256);
  if (stats) {
    const depth = indexDepth(stats.colors.length);
    const orders: PaletteOrder[] = many ? ['count', 'scan'] : ['count'];
    for (const order of orders) {
      const palette = paletteOrder(stats, order);
      const entries = paletteEntries(palette);
      layouts.push({ data: indexedSamples(image, palette, depth), depth, channels: 1, palette: entries });
      if (depth < 8 && many) layouts.push({ data: indexedSamples(image, palette, 8), depth: 8, channels: 1, palette: entries });
    }
  }
  let opaque = true;
  for (let o = 3; o < image.data.length && opaque; o += 4) opaque = image.data[o] === 255;
  if (opaque) layouts.push({ data: rgbSamples(image), depth: 8, channels: 3 });
  layouts.push({ data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), depth: 8, channels: 4 });

  let best = encodePng(image);
  for (const layout of layouts) {
    for (const level of levels) {
      const bytes = encode({ width, height, ...layout }, { zlib: { level } });
      if (bytes.length < best.length) best = bytes;
    }
  }
  return best;
}
