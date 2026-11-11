import { TRANSPARENT } from '../core/color.ts';
import { CoreError } from '../core/errors.ts';
import { mapToPalette } from '../core/palette.ts';
import { PARAMS } from '../core/params.ts';
import { borderBackground, floodRegion, heightLimit, heightStep, indicesOfColor, resampleSprite, trimSprite } from '../core/sprite.ts';
import type { Sprite } from '../core/types.ts';
import { usage } from './errors.ts';

/** One sprite operation, applied in the order given on the command line. */
export type Operation =
  | { kind: 'set'; x: number; y: number; color: number }
  | { kind: 'erase'; x: number; y: number }
  | { kind: 'fill'; x: number; y: number; color: number }
  | { kind: 'swap'; from: number; to: number }
  | { kind: 'erase-color'; color: number }
  | { kind: 'erase-background' }
  | { kind: 'palette'; colors: Uint32Array }
  | { kind: 'resize'; height: number };

function tileIndex(sprite: Sprite, x: number, y: number, flag: string): number {
  if (x >= sprite.cols || y >= sprite.rows) {
    throw usage(`${flag}: tile ${x},${y} is outside the sprite (${sprite.cols} x ${sprite.rows}, origin 0,0 at the top left).`);
  }
  return y * sprite.cols + x;
}

/** Resizes to `height` rows with the area vote; the width keeps the proportion. */
export function resizeToHeight(sprite: Sprite, height: number): { sprite: Sprite; step: number } {
  const limit = heightLimit(sprite.cols, sprite.rows);
  if (height > limit) {
    throw new CoreError(
      'too-large',
      `--height ${height}: the largest height for this ${sprite.cols} x ${sprite.rows} sprite is ${limit} (at most ${PARAMS.sizing.maxEnlargement} times the height, and within the export limits).`,
    );
  }
  const step = heightStep(sprite.rows, height);
  return { sprite: resampleSprite(sprite, step), step };
}

/** The crop to the box of the opaque tiles, with a CLI message for a sprite that has none. */
export function cropToOpaque(sprite: Sprite): Sprite {
  try {
    return trimSprite(sprite);
  } catch (error) {
    if (error instanceof CoreError && error.code === 'empty-image') {
      throw new CoreError('empty-image', 'The result has no opaque tile, so it cannot be cropped. Add --no-trim to keep the full transparent frame.');
    }
    throw error;
  }
}

function paint(sprite: Sprite, indices: ArrayLike<number>, color: number): Sprite {
  const pixels = sprite.pixels.slice();
  for (let i = 0; i < indices.length; i++) pixels[indices[i]] = color;
  return { cols: sprite.cols, rows: sprite.rows, pixels };
}

export function applyOperation(sprite: Sprite, operation: Operation): Sprite {
  switch (operation.kind) {
    case 'set':
      return paint(sprite, [tileIndex(sprite, operation.x, operation.y, '--set')], operation.color);
    case 'erase':
      return paint(sprite, [tileIndex(sprite, operation.x, operation.y, '--erase')], TRANSPARENT);
    case 'fill': {
      const start = tileIndex(sprite, operation.x, operation.y, '--fill');
      return paint(sprite, floodRegion(sprite, start).indices, operation.color);
    }
    case 'swap':
      return paint(sprite, indicesOfColor(sprite.pixels, operation.from), operation.to);
    case 'erase-color':
      return paint(sprite, indicesOfColor(sprite.pixels, operation.color), TRANSPARENT);
    case 'erase-background':
      return paint(sprite, borderBackground(sprite), TRANSPARENT);
    case 'palette':
      return mapToPalette(sprite, operation.colors);
    case 'resize':
      return resizeToHeight(sprite, operation.height).sprite;
  }
}

export function applyOperations(sprite: Sprite, operations: Operation[]): Sprite {
  return operations.reduce(applyOperation, sprite);
}
