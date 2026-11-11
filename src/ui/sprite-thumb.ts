import type { Sprite } from '../core/types.ts';

/** Svelte action: draws a sprite into a canvas at one canvas pixel per tile. CSS scales it with pixelated rendering. */
export function spriteThumb(canvas: HTMLCanvasElement, sprite: Sprite | null) {
  let drawn: Sprite | null = null;
  const draw = (next: Sprite | null): void => {
    if (next === drawn) return;
    drawn = next;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!next) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = next.cols;
    canvas.height = next.rows;
    const image = ctx.createImageData(next.cols, next.rows);
    new Uint32Array(image.data.buffer).set(next.pixels);
    ctx.putImageData(image, 0, 0);
  };
  draw(sprite);
  return { update: draw };
}

/** Svelte action: shows the original file of a set object in an image, through an object URL that it frees again. */
export function sourceThumb(image: HTMLImageElement, bytes: ArrayBuffer) {
  let shown: ArrayBuffer | null = null;
  let url = '';
  const show = (next: ArrayBuffer): void => {
    if (next === shown) return;
    shown = next;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([next]));
    image.src = url;
  };
  show(bytes);
  return {
    update: show,
    destroy() {
      if (url) URL.revokeObjectURL(url);
    },
  };
}
