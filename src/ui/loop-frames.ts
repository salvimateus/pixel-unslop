import type { Sprite } from '../core/types.ts';
import { bakeSprite } from './stage-renderer.ts';

export interface LoopFramesParams {
  frames: readonly Sprite[];
  /** A change bakes the frames again, also when the list is the same object. */
  version: number;
  fps: number;
  playing: boolean;
}

/**
 * Svelte action: plays frames in a loop on a canvas at one canvas pixel per tile. CSS scales it with pixelated rendering.
 * Each frame is baked once; the clock runs from an anchor time, so the rate does not follow the display rate.
 * A rebake, an fps change and a pause keep the shown frame. It plays only with two or more frames.
 */
export function loopFrames(canvas: HTMLCanvasElement, params: LoopFramesParams) {
  let current = params;
  let baked: HTMLCanvasElement[] = [];
  let shown = 0;
  let anchor = 0;
  let raf = 0;

  const paint = (index: number): void => {
    shown = index;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const frame = baked[index];
    if (!frame) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(frame, 0, 0);
  };

  const tick = (now: number): void => {
    const index = Math.floor(((now - anchor) * current.fps) / 1000) % baked.length;
    if (index !== shown) paint(index);
    raf = requestAnimationFrame(tick);
  };

  const run = (): void => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (!current.playing || baked.length < 2 || current.fps <= 0) return;
    anchor = performance.now() - (shown * 1000) / current.fps;
    raf = requestAnimationFrame(tick);
  };

  const bake = (): void => {
    baked = current.frames.map((sprite) => bakeSprite(sprite));
    paint(shown < baked.length ? shown : 0);
  };

  bake();
  run();

  return {
    update(next: LoopFramesParams): void {
      const rebake = next.frames !== current.frames || next.version !== current.version;
      const restart = rebake || next.fps !== current.fps || next.playing !== current.playing;
      current = next;
      if (rebake) bake();
      if (restart) run();
    },
    destroy(): void {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
