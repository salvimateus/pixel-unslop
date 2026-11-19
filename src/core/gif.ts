import { TRANSPARENT, alpha, blue, green, red } from './color.ts';
import { CoreError } from './errors.ts';
import { PARAMS } from './params.ts';
import type { Sprite } from './types.ts';

/** Largest number of opaque colors: a GIF table holds 256 entries, and one can be the transparent slot. */
export const GIF_MAX_COLORS = 255;
/** Browsers play delays below 2 centiseconds as 10, so 50 fps is the fastest real GIF. */
export const GIF_MAX_FPS = 50;

export interface GifOptions {
  /** One delay per frame, in centiseconds. */
  delays: readonly number[];
  /** Whole number of 1 or more: each tile becomes scale x scale image pixels. */
  scale: number;
  /** A packed opaque color that fills the transparent tiles, or null to keep them transparent. */
  background: number | null;
}

const MAX_CODES = 4096;

/** Centisecond delays for `fps` (clamped to GIF_MAX_FPS). Rounding errors carry to the next frame, so the loop length stays exact. */
export function gifDelays(count: number, fps: number): number[] {
  if (!Number.isFinite(fps) || fps <= 0) throw new CoreError('internal', `The frame rate must be a positive number (got ${fps}).`);
  const rate = Math.min(fps, GIF_MAX_FPS);
  const at = (i: number) => Math.round((i * 100) / rate);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => Math.max(2, at(i + 1) - at(i)));
}

class ByteSink {
  private bytes = new Uint8Array(1024);
  length = 0;

  private room(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  byte(value: number): void {
    this.room(1);
    this.bytes[this.length++] = value & 0xff;
  }

  word(value: number): void {
    this.byte(value);
    this.byte(value >>> 8);
  }

  text(value: string): void {
    for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
  }

  data(values: Uint8Array): void {
    this.room(values.length);
    this.bytes.set(values, this.length);
    this.length += values.length;
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** Packs LZW codes LSB first into 255-byte data sub-blocks. */
class CodeWriter {
  private readonly block = new Uint8Array(255);
  private fill = 0;
  private bits = 0;
  private count = 0;

  private readonly sink: ByteSink;

  constructor(sink: ByteSink) {
    this.sink = sink;
  }

  code(value: number, width: number): void {
    this.bits |= value << this.count;
    this.count += width;
    while (this.count >= 8) {
      this.push(this.bits & 0xff);
      this.bits >>>= 8;
      this.count -= 8;
    }
  }

  private push(value: number): void {
    this.block[this.fill++] = value;
    if (this.fill === 255) this.flushBlock();
  }

  private flushBlock(): void {
    if (this.fill === 0) return;
    this.sink.byte(this.fill);
    this.sink.data(this.block.subarray(0, this.fill));
    this.fill = 0;
  }

  /** Writes the last partial byte, the last sub-block and the block terminator. */
  end(): void {
    if (this.count > 0) this.push(this.bits & 0xff);
    this.bits = 0;
    this.count = 0;
    this.flushBlock();
    this.sink.byte(0);
  }
}

/**
 * GIF LZW over a stream of palette indices, one image at a time. The dictionary is a table keyed by prefix code and
 * index; a generation stamp clears it in O(1), so one encoder serves every frame.
 */
class LzwEncoder {
  private readonly minCodeSize: number;
  private readonly clear: number;
  private readonly stop: number;
  private width = 0;
  private next = 0;
  private prefix = -1;
  private generation = 0;
  private readonly stamps = new Uint32Array(MAX_CODES * 256);
  private readonly codes = new Uint16Array(MAX_CODES * 256);
  private writer: CodeWriter | null = null;

  constructor(minCodeSize: number) {
    this.minCodeSize = minCodeSize;
    this.clear = 1 << minCodeSize;
    this.stop = this.clear + 1;
  }

  private reset(): void {
    this.generation++;
    this.width = this.minCodeSize + 1;
    this.next = this.stop + 1;
  }

  begin(sink: ByteSink): void {
    sink.byte(this.minCodeSize);
    this.writer = new CodeWriter(sink);
    this.reset();
    this.prefix = -1;
    this.writer.code(this.clear, this.width);
  }

  push(index: number): void {
    const writer = this.writer as CodeWriter;
    if (this.prefix < 0) {
      this.prefix = index;
      return;
    }
    const key = (this.prefix << 8) | index;
    if (this.stamps[key] === this.generation) {
      this.prefix = this.codes[key];
      return;
    }
    writer.code(this.prefix, this.width);
    if (this.next === MAX_CODES) {
      writer.code(this.clear, this.width);
      this.reset();
    } else {
      // The decoder adds each entry one code later, so the width grows when the entry that needs it is made.
      if (this.next >= 1 << this.width) this.width++;
      this.stamps[key] = this.generation;
      this.codes[key] = this.next++;
    }
    this.prefix = index;
  }

  end(): void {
    const writer = this.writer as CodeWriter;
    if (this.prefix >= 0) writer.code(this.prefix, this.width);
    // The decoder adds one more entry on the last code; the end code must use the width that entry gives.
    if (this.prefix >= 0 && this.next < MAX_CODES && this.next >= 1 << this.width) this.width++;
    writer.code(this.stop, this.width);
    writer.end();
    this.writer = null;
  }
}

function checkFrames(frames: readonly Sprite[], options: GifOptions): { cols: number; rows: number; scale: number } {
  if (frames.length === 0) throw new CoreError('internal', 'A GIF needs at least one frame.');
  const { cols, rows } = frames[0];
  if (cols < 1 || rows < 1) throw new CoreError('internal', 'The frames of a GIF must have at least one tile.');
  if (frames.some((frame) => frame.cols !== cols || frame.rows !== rows || frame.pixels.length !== cols * rows)) {
    throw new CoreError('internal', 'The frames of a GIF must have the same size.');
  }
  if (!options.delays || options.delays.length !== frames.length) {
    throw new CoreError('internal', `A GIF needs one delay per frame (${frames.length} frames, ${options.delays?.length ?? 0} delays).`);
  }
  const scale = options.scale;
  if (!Number.isInteger(scale) || scale < 1) throw new CoreError('internal', `The GIF scale must be a whole number of 1 or more (got ${scale}).`);
  const background = options.background;
  if (background !== null && (!Number.isInteger(background) || alpha(background) !== 0xff)) {
    throw new CoreError('internal', 'The GIF background must be an opaque color or null.');
  }
  const side = Math.max(cols, rows) * scale;
  if (side > PARAMS.limits.maxExportSide) {
    throw new CoreError('too-large', `The GIF would be ${side} pixels wide or high; the limit is ${PARAMS.limits.maxExportSide}.`);
  }
  return { cols, rows, scale };
}

/**
 * An animated GIF89a of equal-size frames, looped forever. One global color table; with no background, index 0 is
 * the transparent slot when a tile is transparent, and each frame clears to it before the next one (disposal 2).
 */
export function encodeGif(frames: readonly Sprite[], options: GifOptions): Uint8Array {
  const { cols, rows, scale } = checkFrames(frames, options);
  const fill = options.background;

  // Colors in order of first use, so the table does not depend on counts.
  const index = new Map<number, number>();
  const palette: number[] = [];
  let transparent = false;
  for (const frame of frames) {
    for (let i = 0; i < frame.pixels.length; i++) {
      let color = frame.pixels[i];
      if (color === TRANSPARENT) {
        if (fill === null) {
          transparent = true;
          continue;
        }
        color = fill;
      }
      if (index.has(color)) continue;
      if (palette.length === GIF_MAX_COLORS) {
        throw new CoreError('internal', `A GIF holds at most ${GIF_MAX_COLORS} colors.`);
      }
      index.set(color, palette.length);
      palette.push(color);
    }
  }
  const offset = transparent ? 1 : 0;
  const entries = palette.length + offset;
  let tableBits = 2;
  while (1 << tableBits < entries) tableBits++;
  const minCodeSize = tableBits;

  const width = cols * scale;
  const height = rows * scale;
  const sink = new ByteSink();
  sink.text('GIF89a');
  sink.word(width);
  sink.word(height);
  sink.byte(0x80 | ((tableBits - 1) << 4) | (tableBits - 1));
  sink.byte(0);
  sink.byte(0);
  for (let i = 0; i < 1 << tableBits; i++) {
    const color = i >= offset && i - offset < palette.length ? palette[i - offset] : 0;
    sink.byte(red(color));
    sink.byte(green(color));
    sink.byte(blue(color));
  }

  sink.byte(0x21);
  sink.byte(0xff);
  sink.byte(11);
  sink.text('NETSCAPE2.0');
  sink.byte(3);
  sink.byte(1);
  sink.word(0);
  sink.byte(0);

  const lzw = new LzwEncoder(minCodeSize);
  const sourceRow = new Uint8Array(cols);
  const row = new Uint8Array(width);
  frames.forEach((frame, f) => {
    const delay = Math.min(0xffff, Math.max(0, Math.round(Number(options.delays[f]) || 0)));
    sink.byte(0x21);
    sink.byte(0xf9);
    sink.byte(4);
    sink.byte(transparent ? (2 << 2) | 1 : 1 << 2);
    sink.word(delay);
    sink.byte(0);
    sink.byte(0);

    sink.byte(0x2c);
    sink.word(0);
    sink.word(0);
    sink.word(width);
    sink.word(height);
    sink.byte(0);

    lzw.begin(sink);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const color = frame.pixels[y * cols + x];
        if (color === TRANSPARENT && fill === null) sourceRow[x] = 0;
        else sourceRow[x] = (index.get(color === TRANSPARENT ? (fill as number) : color) as number) + offset;
      }
      for (let x = 0; x < width; x++) row[x] = sourceRow[Math.floor(x / scale)];
      for (let k = 0; k < scale; k++) for (let x = 0; x < width; x++) lzw.push(row[x]);
    }
    lzw.end();
  });

  sink.byte(0x3b);
  return sink.result();
}
