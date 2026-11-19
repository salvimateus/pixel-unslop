import type { FrameOffset } from '../core/frames.ts';
import type { Sprite } from '../core/types.ts';
import { TUNING } from '../app/tuning.ts';
import type { Camera } from './camera.ts';
import type { PreviewBackground } from './clean-scene.ts';
import {
  bakeSprite,
  checkerPattern,
  contentRect,
  drawFrame,
  easeOutBack,
  easeOutCubic,
  ghostTint,
  intersect,
  progress,
  shatterTiles,
  sparkColors,
  STAGE_COLORS,
  viewRect,
  type GhostKind,
  type Rect,
  type Scene,
  type StageHost,
} from './stage-renderer.ts';

/** The frames that a scene plays: all of the same size, read on demand. */
export interface AnimSource {
  count: number;
  cols: number;
  rows: number;
  frameOf(index: number): Sprite | null;
  /**
   * A stand-in for a frame that is not there yet, drawn over the frame box: the video frame at one pixel per tile.
   * Without a frame and a stand-in, the scene keeps the last frame it drew.
   */
  previewOf?(index: number): CanvasImageSource | null;
}

/** Baked frames that a scene keeps; the oldest go first. */
const BAKED_LIMIT = 48;
const GHOST_LIMIT = 8;

function remember<T>(map: Map<number, T>, index: number, value: T, limit: number): void {
  map.set(index, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Plays equal-size frames in a loop on the stage. Each frame is baked once into its own canvas, so a tick is
 * one `drawImage` (two with the onion ghost, a tinted bake drawn over the frame). The clock is the time since the anchor, so the frame rate does
 * not depend on the display rate.
 */
export class AnimScene implements Scene {
  readonly maxZoom = TUNING.anim.maxZoom;
  contentW = 1;
  contentH = 1;
  background: PreviewBackground = 'checker';
  onion = false;
  ghostOf: (index: number) => number | null = (index) => (this.source.count < 2 ? null : (index - 1 + this.source.count) % this.source.count);
  /** The move in whole tiles of the ghost over shown frame `index`; null or no function draws it in place. */
  ghostShift: ((index: number) => FrameOffset | null) | null = null;
  onframe: ((index: number) => void) | null = null;

  protected host: StageHost | null = null;
  private source: AnimSource;
  private baked = new Map<number, HTMLCanvasElement>();
  private ghosts = new Map<number, HTMLCanvasElement>();
  private ghostKind: GhostKind = 'previous';
  /** The last frame drawn, kept on screen while the next one is on its way. */
  private lastDrawn: HTMLCanvasElement | null = null;
  private current = 0;
  private fps: number;
  private isPlaying = false;
  private anchor = 0;
  private popStart = -1;
  /** A bake of tiles drawn over one frame (the tiles that a click erases), and the frame it belongs to. */
  private mask: { canvas: HTMLCanvasElement; index: number } | null = null;
  private maskFlash: { canvas: HTMLCanvasElement; start: number } | null = null;

  constructor(source: AnimSource, fps: number) {
    this.source = source;
    this.fps = Math.max(1, fps);
    this.contentW = Math.max(1, source.cols);
    this.contentH = Math.max(1, source.rows);
  }

  get index(): number {
    return this.current;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  attach(host: StageHost | null): void {
    this.host = host;
  }

  initialZoom(camera: Camera): number {
    // A whole zoom keeps every art pixel the same size on screen.
    const fit = camera.fitZoom();
    return fit >= 1 ? Math.floor(fit) : fit;
  }

  /** New frames. Returns true when the content size changed: the caller then syncs the stage. */
  setSource(source: AnimSource): boolean {
    this.source = source;
    this.baked.clear();
    this.ghosts.clear();
    this.lastDrawn = null;
    this.mask = null;
    if (this.current >= source.count) this.current = Math.max(0, source.count - 1);
    const width = Math.max(1, source.cols);
    const height = Math.max(1, source.rows);
    const resized = width !== this.contentW || height !== this.contentH;
    this.contentW = width;
    this.contentH = height;
    if (this.isPlaying) this.anchorAt(performance.now());
    this.host?.invalidate();
    return resized;
  }

  /** The same frames with new pixels. */
  refresh(): void {
    this.baked.clear();
    this.ghosts.clear();
    this.lastDrawn = null;
    this.host?.invalidate();
  }

  /** Frames arrived or left: the frames that were missing are read again on the next draw. */
  invalidate(): void {
    this.host?.invalidate();
  }

  setFps(fps: number): void {
    const next = Math.max(1, fps);
    if (next === this.fps) return;
    this.fps = next;
    if (this.isPlaying) this.anchorAt(performance.now());
  }

  setPlaying(on: boolean): void {
    if (on === this.isPlaying) return;
    this.isPlaying = on && this.source.count > 1;
    if (this.isPlaying) this.anchorAt(performance.now());
    this.host?.invalidate();
  }

  seek(index: number): void {
    const count = this.source.count;
    if (count === 0) return;
    const next = Math.min(count - 1, Math.max(0, Math.round(index)));
    if (next === this.current) return;
    this.current = next;
    if (this.isPlaying) this.anchorAt(performance.now());
    this.host?.invalidate();
  }

  step(delta: number): void {
    const count = this.source.count;
    if (count === 0) return;
    this.seek((((this.current + Math.round(delta)) % count) + count) % count);
  }

  /** The juice of an added frame: the frame springs a little and sparks fly from it. */
  pop(): void {
    const host = this.host;
    if (!host || host.reducedMotion) return;
    this.popStart = performance.now();
    const rect = contentRect(host.camera);
    host.particles.burst(rect.x + rect.w / 2, rect.y + rect.h / 2, {
      count: TUNING.anim.addSparks,
      colors: sparkColors(),
      speed: [160, 360],
      life: [0.35, TUNING.particles.sparkLifeS],
      size: [3, 6],
      jitter: Math.min(rect.w, rect.h) / 4,
    });
    host.invalidate();
  }

  /** The tint of the ghost. The ghost bakes are kept by frame only, so a new kind bakes them again. */
  setGhostKind(kind: GhostKind): void {
    if (kind === this.ghostKind) return;
    this.ghostKind = kind;
    this.ghosts.clear();
    this.host?.invalidate();
  }

  /** Tiles over frame `index` at `TUNING.clean.removeMaskAlpha`, or null. */
  setMask(canvas: HTMLCanvasElement | null, index = this.current): void {
    if (canvas === this.mask?.canvas && index === this.mask?.index) return;
    this.mask = canvas ? { canvas, index } : null;
    this.host?.invalidate();
  }

  /** Erased tiles of the shown frame: they fall as particles in their old color and flash once. None with reduced motion. */
  shatter(indices: ArrayLike<number>, oldPixels: Uint32Array, flash: HTMLCanvasElement | null): void {
    const host = this.host;
    if (!host || host.reducedMotion) return;
    shatterTiles(host, this.contentW, indices, oldPixels);
    if (flash) this.maskFlash = { canvas: flash, start: performance.now() };
    host.invalidate();
  }

  private anchorAt(now: number): void {
    this.anchor = now - (this.current * 1000) / this.fps;
  }

  private canvasOf(index: number): HTMLCanvasElement | null {
    const known = this.baked.get(index);
    if (known) return known;
    const sprite = this.source.frameOf(index);
    if (!sprite || sprite.cols !== this.contentW || sprite.rows !== this.contentH) return null;
    const canvas = bakeSprite(sprite);
    remember(this.baked, index, canvas, BAKED_LIMIT);
    return canvas;
  }

  private ghostCanvasOf(index: number): HTMLCanvasElement | null {
    const known = this.ghosts.get(index);
    if (known) return known;
    const sprite = this.source.frameOf(index);
    if (!sprite || sprite.cols !== this.contentW || sprite.rows !== this.contentH) return null;
    const canvas = bakeSprite(sprite, ghostTint(this.ghostKind));
    remember(this.ghosts, index, canvas, GHOST_LIMIT);
    return canvas;
  }

  /** The ghost over the frame box, moved by its shift and cut to the box. `rect` is scaled during a pop. */
  private drawGhost(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, rect: Rect): void {
    const shift = this.ghostShift?.(this.current) ?? null;
    ctx.globalAlpha = TUNING.anim.ghostAlpha;
    if (!shift || (shift.x === 0 && shift.y === 0)) {
      ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h);
    } else {
      const zoom = rect.w / this.contentW;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.drawImage(canvas, rect.x + shift.x * zoom, rect.y + shift.y * zoom, rect.w, rect.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  draw(ctx: CanvasRenderingContext2D, fx: CanvasRenderingContext2D, now: number): boolean {
    const host = this.host;
    if (!host) return false;
    const count = this.source.count;
    if (this.isPlaying && count > 1) {
      const next = Math.floor(((now - this.anchor) * this.fps) / 1000) % count;
      if (next !== this.current) {
        this.current = next;
        this.onframe?.(next);
      }
    }
    let alive = this.isPlaying;
    const { camera, dpr } = host;
    let rect = contentRect(camera);
    if (this.popStart >= 0) {
      const t = progress(now, this.popStart, TUNING.anim.popMs);
      if (t >= 1) this.popStart = -1;
      else {
        alive = true;
        const scale = 0.94 + 0.06 * easeOutBack(t);
        rect = { x: rect.x + (rect.w * (1 - scale)) / 2, y: rect.y + (rect.h * (1 - scale)) / 2, w: rect.w * scale, h: rect.h * scale };
      }
    }
    drawFrame(ctx, rect, dpr);
    const clip = intersect(rect, viewRect(camera));
    if (!clip) return alive;
    ctx.fillStyle = this.background === 'checker' ? checkerPattern(ctx) : this.background === 'dark' ? STAGE_COLORS.previewDark : STAGE_COLORS.previewLight;
    ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
    if (count === 0) return alive;
    ctx.imageSmoothingEnabled = false;
    const frame = this.canvasOf(this.current);
    if (frame) {
      ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h);
      this.lastDrawn = frame;
    } else {
      const preview = this.source.previewOf?.(this.current) ?? null;
      if (preview) ctx.drawImage(preview, rect.x, rect.y, rect.w, rect.h);
      else if (this.lastDrawn) ctx.drawImage(this.lastDrawn, rect.x, rect.y, rect.w, rect.h);
    }
    if (this.onion) {
      const ghost = this.ghostOf(this.current);
      const canvas = ghost === null || ghost === this.current ? null : this.ghostCanvasOf(ghost);
      if (canvas) this.drawGhost(ctx, canvas, rect);
    }
    const mask = this.mask;
    if (mask && mask.index === this.current && mask.canvas.width === this.contentW && mask.canvas.height === this.contentH) {
      ctx.globalAlpha = TUNING.clean.removeMaskAlpha;
      ctx.drawImage(mask.canvas, rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
    }
    const flash = this.maskFlash;
    if (flash) {
      const t = progress(now, flash.start, TUNING.clean.popMs * 1.5);
      if (t >= 1 || flash.canvas.width !== this.contentW || flash.canvas.height !== this.contentH) this.maskFlash = null;
      else {
        alive = true;
        fx.imageSmoothingEnabled = false;
        fx.globalAlpha = 1 - easeOutCubic(t);
        fx.drawImage(flash.canvas, rect.x, rect.y, rect.w, rect.h);
        fx.globalAlpha = 1;
      }
    }
    return alive;
  }
}
