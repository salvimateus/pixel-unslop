import { TRANSPARENT } from '../core/color.ts';
import { mapToPalette } from '../core/palette.ts';
import { borderBackground, floodRegion, indicesOfColor } from '../core/sprite.ts';
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
  | { kind: 'palette'; colors: Uint32Array };

function tileIndex(sprite: Sprite, x: number, y: number, flag: string): number {
  if (x >= sprite.cols || y >= sprite.rows) {
    throw usage(`${flag}: tile ${x},${y} is outside the sprite (${sprite.cols} x ${sprite.rows}, origin 0,0 at the top left).`);
  }
  return y * sprite.cols + x;
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
  }
}

export function applyOperations(sprite: Sprite, operations: Operation[]): Sprite {
  return operations.reduce(applyOperation, sprite);
}
