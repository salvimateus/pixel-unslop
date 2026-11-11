import { PARAMS } from '../core/params.ts';
import type { GridFit, RasterImage } from '../core/types.ts';

const CHECKER_DARK = 48;
const CHECKER_LIGHT = 72;
const LINE: [number, number, number] = [255, 0, 255];
const LINE_ALT: [number, number, number] = [0, 255, 0];

/** Upscale factor so that one art pixel is at least minCellSide pixels, within the size limit. */
export function previewScale(image: RasterImage, fit: GridFit): number {
  const { minCellSide, maxSide } = PARAMS.preview;
  const period = Math.min(fit.axes.x.period, fit.axes.y.period);
  const wanted = Math.max(1, Math.ceil(minCellSide / Math.max(period, 1e-6)));
  const limit = Math.max(1, Math.floor(maxSide / Math.max(image.width, image.height)));
  return Math.min(wanted, limit);
}

/**
 * The source upscaled (nearest neighbor) over a dark checkerboard, with the fitted grid drawn as
 * 1-pixel lines. Lines alternate magenta and green so that each cell edge is easy to count.
 */
export function gridPreview(image: RasterImage, fit: GridFit): RasterImage {
  const k = previewScale(image, fit);
  const width = image.width * k;
  const height = image.height * k;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < width; x++) {
      const s = (sy * image.width + Math.floor(x / k)) * 4;
      const o = (y * width + x) * 4;
      const back = ((x >> 3) + (y >> 3)) & 1 ? CHECKER_LIGHT : CHECKER_DARK;
      const a = image.data[s + 3] / 255;
      data[o] = Math.round(image.data[s] * a + back * (1 - a));
      data[o + 1] = Math.round(image.data[s + 1] * a + back * (1 - a));
      data[o + 2] = Math.round(image.data[s + 2] * a + back * (1 - a));
      data[o + 3] = 255;
    }
  }
  const paint = (x: number, y: number, color: [number, number, number]) => {
    const o = (y * width + x) * 4;
    data[o] = color[0];
    data[o + 1] = color[1];
    data[o + 2] = color[2];
  };
  fit.grid.x.forEach((bound, index) => {
    const x = Math.round(bound * k);
    if (x < 0 || x >= width) return;
    const color = index % 2 === 0 ? LINE : LINE_ALT;
    for (let y = 0; y < height; y++) paint(x, y, color);
  });
  fit.grid.y.forEach((bound, index) => {
    const y = Math.round(bound * k);
    if (y < 0 || y >= height) return;
    const color = index % 2 === 0 ? LINE : LINE_ALT;
    for (let x = 0; x < width; x++) paint(x, y, color);
  });
  return { width, height, data };
}
