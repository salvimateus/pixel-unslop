import { blue, green, red } from '../core/color.ts';
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
  gridHalo: '--stage-grid-halo',
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

export function strokeGrid(ctx: CanvasRenderingContext2D, path: Path2D, dpr: number, color: string, halo: boolean, width = 1): void {
  if (halo) {
    ctx.strokeStyle = STAGE_COLORS.gridHalo;
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
