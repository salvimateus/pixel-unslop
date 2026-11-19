import { TRANSPARENT, blue, green, red } from '../core/color.ts';
import { TUNING } from '../app/tuning.ts';
import { borderBackground, opaqueBox, trimOrNull, type RemoveScope } from '../core/sprite.ts';
import type { Sprite } from '../core/types.ts';
import type { Camera } from './camera.ts';
import type { ParticleField } from './particles.ts';

/** What a scene can use from the stage that shows it. */
export interface StageHost {
  readonly camera: Camera;
  readonly particles: ParticleField;
  readonly dpr: number;
  readonly reducedMotion: boolean;
  /** Asks for one more frame. The loop stops when nothing is dirty or alive. */
  invalidate(): void;
}

/** A drawable layer of the stage: the Grade scene or the Limpar scene. */
export interface Scene {
  readonly contentW: number;
  readonly contentH: number;
  readonly maxZoom: number;
  /** The zoom of the first view, given a camera that already knows the viewport. */
  initialZoom(camera: Camera): number;
  attach(host: StageHost | null): void;
  /** Draws one frame on the stage canvas and the effects canvas. Returns true while an animation is alive. */
  draw(ctx: CanvasRenderingContext2D, fx: CanvasRenderingContext2D, now: number): boolean;
}

/** One pointer sample on the stage: screen position (CSS pixels of the stage) and content position. */
export interface StagePointer {
  sx: number;
  sy: number;
  ix: number;
  iy: number;
  shift: boolean;
  /** Alt (Option) is held: a single-line move in "Ajustar linhas". */
  alt: boolean;
  /** Ctrl (Cmd on a Mac) is held: a drag moves the full grid on the Grade screen. */
  ctrl: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewMap {
  zoom: number;
  panX: number;
  panY: number;
}

/** Canvas colors, keyed to the --stage-* tokens of tokens.css. */
const STAGE_TOKENS = {
  gridLine: '--stage-grid-line',
  gridSoft: '--stage-grid-soft',
  gridFaint: '--stage-grid-faint',
  gridHalo: '--stage-grid-halo',
  gridFit: '--stage-grid-fit',
  gridFitHalo: '--stage-grid-fit-halo',
  gridFlash: '--stage-flash',
  accent: '--stage-accent',
  accentFill: '--stage-accent-fill',
  teal: '--stage-teal',
  yellow: '--stage-yellow',
  danger: '--stage-danger',
  white: '--stage-white',
  wave: '--stage-wave',
  shadow: '--stage-shadow',
  checkerA: '--stage-checker-a',
  checkerB: '--stage-checker-b',
  previewDark: '--stage-preview-dark',
  previewLight: '--stage-preview-light',
  panel: '--stage-panel',
  panelEdge: '--stage-panel-edge',
  ghostPrevious: '--stage-ghost-previous',
  ghostFirst: '--stage-ghost-first',
} as const;

export type StageColor = keyof typeof STAGE_TOKENS;

/** Filled from the tokens by loadStageColors() before the first frame. */
export const STAGE_COLORS = Object.fromEntries(Object.keys(STAGE_TOKENS).map((key) => [key, 'transparent'])) as Record<StageColor, string>;

/** Reads the --stage-* tokens once, so the canvas and the CSS share one palette. */
export function loadStageColors(): void {
  const style = getComputedStyle(document.documentElement);
  for (const [key, token] of Object.entries(STAGE_TOKENS) as Array<[StageColor, string]>) {
    const value = style.getPropertyValue(token).trim();
    if (value) STAGE_COLORS[key] = value;
  }
}

const rgbCache = new Map<string, [number, number, number]>();

/** The RGB bytes of a CSS color, resolved once by the canvas itself. */
function cssRgb(color: string): [number, number, number] {
  const cached = rgbCache.get(color);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let rgb: [number, number, number] = [0, 0, 0];
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    rgb = [r, g, b];
  }
  rgbCache.set(color, rgb);
  return rgb;
}

/** The border-connected background of the opaque box, as tiles of the whole sprite: padding or an offset can leave a transparent edge. */
function ghostBackground(sprite: Sprite): Int32Array {
  const box = opaqueBox(sprite);
  const trimmed = trimOrNull(sprite);
  if (!box || !trimmed) return new Int32Array(0);
  const tiles = borderBackground(trimmed);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    tiles[i] = (box.row + Math.floor(tile / box.cols)) * sprite.cols + box.col + (tile % box.cols);
  }
  return tiles;
}

/** Which frame an onion ghost shows: it sets the tint of the ghost. */
export type GhostKind = 'previous' | 'first';

/** The tint of a ghost of this kind for bakeSprite. Read at call time: the colors load after the module. */
export function ghostTint(kind: GhostKind): { color: string; strength: number } {
  return { color: kind === 'first' ? STAGE_COLORS.ghostFirst : STAGE_COLORS.ghostPrevious, strength: TUNING.anim.ghostTint };
}

/**
 * A sprite baked into a canvas of one pixel per tile. With a tint, the bake is a ghost: the background that
 * touches the edge of its opaque box is dropped (scenery stays whole), and every other visible pixel moves toward the tint color
 * by `strength` and keeps its alpha, so the ghost reads apart from the frame at the cost of one bake.
 */
export function bakeSprite(sprite: Sprite, tint?: { color: string; strength: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sprite.cols;
  canvas.height = sprite.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.createImageData(sprite.cols, sprite.rows);
  if (tint) {
    const [tr, tg, tb] = cssRgb(tint.color);
    const k = Math.min(1, Math.max(0, tint.strength));
    const data = image.data;
    const pixels = sprite.pixels;
    const dropped = new Uint8Array(pixels.length);
    for (const tile of ghostBackground(sprite)) dropped[tile] = 1;
    for (let i = 0; i < pixels.length; i++) {
      if (dropped[i] === 1) continue;
      const color = pixels[i];
      const a = color >>> 24;
      if (a === 0) continue;
      const o = i * 4;
      data[o] = red(color) + (tr - red(color)) * k;
      data[o + 1] = green(color) + (tg - green(color)) * k;
      data[o + 2] = blue(color) + (tb - blue(color)) * k;
      data[o + 3] = a;
    }
  } else {
    new Uint32Array(image.data.buffer).set(sprite.pixels);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** The dropper as a CSS cursor, with its tip as the hot spot: a light line on a dark line, for light and dark art. */
export const PICKER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="square"><path d="M14 4l6 6M12.5 6.5l5 5M15 9L6 18H4v-2l9-9" stroke="#000" stroke-width="4"/><path d="M14 4l6 6M12.5 6.5l5 5M15 9L6 18H4v-2l9-9" stroke="#fff" stroke-width="2"/></svg>',
)}") 3 20, crosshair`;

/** The tiles of one layer of a mask bake, in a CSS color at an opacity from 0 to 1. */
interface MaskLayer {
  indices: ArrayLike<number>;
  color: string;
  alpha?: number;
}

/** One canvas pixel per tile: each layer paints its tiles in its color, a later layer over an earlier one, every other tile clear. */
function bakeLayers(cols: number, rows: number, layers: readonly MaskLayer[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, cols);
  canvas.height = Math.max(1, rows);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.createImageData(canvas.width, canvas.height);
  const data = image.data;
  for (const { indices, color, alpha = 1 } of layers) {
    const [r, g, b] = cssRgb(color);
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    for (let i = 0; i < indices.length; i++) {
      const o = indices[i] * 4;
      if (o < 0 || o >= data.length) continue;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** One canvas pixel per tile: the tiles at `indices` in a CSS color, every other tile clear. */
export function bakeMask(cols: number, rows: number, indices: ArrayLike<number>, color: string): HTMLCanvasElement {
  return bakeLayers(cols, rows, [{ indices, color }]);
}

/**
 * The hover preview of a "Remove color" pick, drawn at `TUNING.clean.removeMaskAlpha`: the tiles that go, in the
 * danger color for 'border' and in yellow for 'all', and the tiles of that color that stay, in a fainter teal.
 */
export function bakePickMask(cols: number, rows: number, cleared: ArrayLike<number>, kept: ArrayLike<number>, scope: RemoveScope): HTMLCanvasElement {
  const { removeMaskAlpha, protectMaskAlpha } = TUNING.clean;
  return bakeLayers(cols, rows, [
    { indices: kept, color: STAGE_COLORS.teal, alpha: protectMaskAlpha / removeMaskAlpha },
    { indices: cleared, color: scope === 'all' ? STAGE_COLORS.yellow : STAGE_COLORS.danger },
  ]);
}

/** The flash of a "Remove color" click: the cleared tiles in white and the tiles that the border rule kept in teal. */
export function bakePickFlash(cols: number, rows: number, cleared: ArrayLike<number>, kept: ArrayLike<number>): HTMLCanvasElement {
  return bakeLayers(cols, rows, [
    { indices: kept, color: STAGE_COLORS.teal },
    { indices: cleared, color: STAGE_COLORS.white },
  ]);
}

/** Erased tiles fall as particles in their old color; `cols` is the content width in tiles. Nothing under reduced motion. */
export function shatterTiles(host: StageHost, cols: number, indices: ArrayLike<number>, oldPixels: Uint32Array): void {
  if (host.reducedMotion || indices.length === 0) return;
  const { camera, particles } = host;
  const stride = Math.max(1, Math.ceil(indices.length / TUNING.particles.eraseMaxTiles));
  const side = Math.min(14, Math.max(2, camera.zoom * 0.45));
  for (let i = 0; i < indices.length; i += stride) {
    const index = indices[i];
    const color = oldPixels[index];
    if (color === TRANSPARENT) continue;
    const p = camera.imageToScreen((index % cols) + 0.5, Math.floor(index / cols) + 0.5);
    particles.burst(p.x, p.y, {
      count: TUNING.particles.eraseShards,
      colors: [cssColor(color)],
      speed: [40, 190],
      angle: -Math.PI / 2,
      spread: Math.PI * 0.9,
      life: [0.35, 0.75],
      size: [side * 0.6, side],
      jitter: camera.zoom * 0.6,
    });
  }
  host.invalidate();
}

/** The colors of sparks and confetti: the accents of the theme. */
export function sparkColors(): string[] {
  return [STAGE_COLORS.accent, STAGE_COLORS.teal, STAGE_COLORS.yellow, STAGE_COLORS.white];
}

export function cssColor(packed: number): string {
  return `rgb(${red(packed)} ${green(packed)} ${blue(packed)})`;
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Overshoots the target a little and settles: for rare tactile moments only. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export function progress(now: number, start: number, duration: number): number {
  if (start < 0) return 1;
  return Math.min(1, Math.max(0, (now - start) / duration));
}

export function snap(value: number, dpr: number): number {
  return (Math.round(value * dpr) + 0.5) / dpr;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

export function contentRect(camera: Camera): Rect {
  return { x: camera.panX, y: camera.panY, w: camera.contentW * camera.zoom, h: camera.contentH * camera.zoom };
}

export function viewRect(camera: Camera): Rect {
  return { x: 0, y: 0, w: camera.viewW, h: camera.viewH };
}

/** First index whose bound is at or above `value`. */
function lowerBound(bounds: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One path with the grid lines that cross `clip`. Bounds are in content units. */
export function gridPath(xs: ArrayLike<number>, ys: ArrayLike<number>, map: ViewMap, clip: Rect, dpr: number): Path2D {
  const path = new Path2D();
  const right = clip.x + clip.w;
  const bottom = clip.y + clip.h;
  const xStart = lowerBound(xs, (clip.x - map.panX) / map.zoom);
  for (let i = xStart; i < xs.length; i++) {
    const sx = map.panX + xs[i] * map.zoom;
    if (sx > right) break;
    const px = snap(sx, dpr);
    path.moveTo(px, clip.y);
    path.lineTo(px, bottom);
  }
  const yStart = lowerBound(ys, (clip.y - map.panY) / map.zoom);
  for (let i = yStart; i < ys.length; i++) {
    const sy = map.panY + ys[i] * map.zoom;
    if (sy > bottom) break;
    const py = snap(sy, dpr);
    path.moveTo(clip.x, py);
    path.lineTo(right, py);
  }
  return path;
}

export function strokeGrid(ctx: CanvasRenderingContext2D, path: Path2D, dpr: number, color: string, halo: boolean, width = 1, haloColor = STAGE_COLORS.gridHalo): void {
  if (halo) {
    ctx.strokeStyle = haloColor;
    ctx.lineWidth = (width + 2) / dpr;
    ctx.stroke(path);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width / dpr;
  ctx.stroke(path);
}

const checkerCache = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

/** A checkerboard of 8 CSS pixel squares, for transparent areas. */
export function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  const cached = checkerCache.get(ctx);
  if (cached) return cached;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 16;
  const tileCtx = tile.getContext('2d');
  if (!tileCtx) return STAGE_COLORS.checkerA;
  tileCtx.fillStyle = STAGE_COLORS.checkerA;
  tileCtx.fillRect(0, 0, 16, 16);
  tileCtx.fillStyle = STAGE_COLORS.checkerB;
  tileCtx.fillRect(0, 0, 8, 8);
  tileCtx.fillRect(8, 8, 8, 8);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return STAGE_COLORS.checkerA;
  checkerCache.set(ctx, pattern);
  return pattern;
}

/** A pixel-style frame: a hard drop shadow and a solid outline. */
export function drawFrame(ctx: CanvasRenderingContext2D, rect: Rect, dpr: number): void {
  const x = snap(rect.x, dpr);
  const y = snap(rect.y, dpr);
  const w = Math.round(rect.w * dpr) / dpr;
  const h = Math.round(rect.h * dpr) / dpr;
  ctx.fillStyle = STAGE_COLORS.shadow;
  ctx.fillRect(rect.x + 6, rect.y + 6, rect.w, rect.h);
  ctx.strokeStyle = STAGE_COLORS.panelEdge;
  ctx.lineWidth = 2 / dpr;
  ctx.strokeRect(x - 1, y - 1, w + 1, h + 1);
}
