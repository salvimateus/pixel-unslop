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
