import type { Sprite } from '../core/types.ts';
import { indicesOfColor } from '../core/sprite.ts';

const HISTORY_LIMIT = 200;

interface Step {
  indices: Int32Array;
  beforeMask: Uint8Array;
  beforeColor: Uint32Array;
  afterColor: Uint32Array;
}

/**
 * User edits as an overlay over the base sprite. A palette merge replaces the base and keeps the overlay,
 * so manual fixes survive a new cleanup strength.
 */
export class EditSession {
  private base: Sprite | null = null;
  private mask = new Uint8Array(0);
  private overlay = new Uint32Array(0);
  private maskCount = 0;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private cache: Sprite | null = null;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get hasEdits(): boolean {
    return this.maskCount > 0;
  }

  get hasBase(): boolean {
    return this.base !== null;
  }

  /** A sprite of other dimensions starts a new session. */
  setBase(sprite: Sprite): void {
    const sameSize = this.base && this.base.cols === sprite.cols && this.base.rows === sprite.rows;
    this.base = sprite;
    if (!sameSize) this.resetOverlay(sprite.cols * sprite.rows);
    this.cache = null;
  }

  clear(): void {
    this.base = null;
    this.resetOverlay(0);
    this.cache = null;
  }

  /** One undo step. `colors` is one color for all indices, or one color per index. Returns the indices that changed. */
  apply(indices: Int32Array, colors: number | Uint32Array): Int32Array {
    const composed = this.composed();
    const size = composed.pixels.length;
    const seen = new Uint8Array(size);
    const changedIndex: number[] = [];
    const changedColor: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (index < 0 || index >= size || seen[index]) continue;
      seen[index] = 1;
      const color = (typeof colors === 'number' ? colors : colors[i]) >>> 0;
      if (composed.pixels[index] === color) continue;
      changedIndex.push(index);
      changedColor.push(color);
    }
    if (changedIndex.length === 0) return new Int32Array(0);

    const step: Step = {
      indices: Int32Array.from(changedIndex),
      beforeMask: Uint8Array.from(changedIndex, (index) => this.mask[index]),
      beforeColor: Uint32Array.from(changedIndex, (index) => this.overlay[index]),
      afterColor: Uint32Array.from(changedColor),
    };
    this.redo_(step);
    this.undoStack.push(step);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    return step.indices;
  }

  /** Returns the indices that changed, or null when there is nothing to undo. */
  undo(): Int32Array | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    for (let i = 0; i < step.indices.length; i++) {
      this.setOverlay(step.indices[i], step.beforeMask[i], step.beforeColor[i]);
    }
    this.cache = null;
    this.redoStack.push(step);
    return step.indices;
  }

  redo(): Int32Array | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.redo_(step);
    this.undoStack.push(step);
    return step.indices;
  }

  /** Replaces one color with another in the whole composed sprite, as one undo step. */
  swapColor(from: number, to: number): Int32Array {
    if (from === to) return new Int32Array(0);
    return this.apply(indicesOfColor(this.composed().pixels, from), to);
  }

  /** Composed pixel = overlay where the mask is set, else base. The result is cached until the next change. */
  composed(): Sprite {
    if (this.cache) return this.cache;
    if (!this.base) return (this.cache = { cols: 0, rows: 0, pixels: new Uint32Array(0) });
    const pixels = this.base.pixels.slice();
    if (this.maskCount > 0) {
      for (let i = 0; i < pixels.length; i++) if (this.mask[i]) pixels[i] = this.overlay[i];
    }
    this.cache = { cols: this.base.cols, rows: this.base.rows, pixels };
    return this.cache;
  }

  private redo_(step: Step): void {
    for (let i = 0; i < step.indices.length; i++) this.setOverlay(step.indices[i], 1, step.afterColor[i]);
    this.cache = null;
  }

  private setOverlay(index: number, masked: number, color: number): void {
    if (masked && !this.mask[index]) this.maskCount++;
    else if (!masked && this.mask[index]) this.maskCount--;
    this.mask[index] = masked;
    this.overlay[index] = color;
  }

  private resetOverlay(size: number): void {
    this.mask = new Uint8Array(size);
    this.overlay = new Uint32Array(size);
    this.maskCount = 0;
    this.undoStack = [];
    this.redoStack = [];
  }
}
