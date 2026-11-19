import type { Sprite } from '../core/types.ts';
import { TUNING } from '../app/tuning.ts';
import type { Camera } from './camera.ts';
import type { PreviewBackground } from './clean-scene.ts';
import { bakeSprite, checkerPattern, contentRect, drawFrame, easeOutBack, intersect, progress, sparkColors, STAGE_COLORS, viewRect, type Scene, type StageHost } from './stage-renderer.ts';

/** The frames that a scene plays: all of the same size, read on demand. */
export interface AnimSource {
  count: number;
  cols: number;
  rows: number;
  frameOf(index: number): Sprite | null;
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
  onframe: ((index: number) => void) | null = null;

  protected host: StageHost | null = null;
  private source: AnimSource;
  private baked = new Map<number, HTMLCanvasElement | null>();
  private ghosts = new Map<number, HTMLCanvasElement | null>();
  private current = 0;
  private fps: number;
  private isPlaying = false;
  private anchor = 0;
  private popStart = -1;

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

  private anchorAt(now: number): void {
    this.anchor = now - (this.current * 1000) / this.fps;
  }

  private canvasOf(index: number): HTMLCanvasElement | null {
    if (this.baked.has(index)) return this.baked.get(index) ?? null;
    const sprite = this.source.frameOf(index);
    const canvas = sprite && sprite.cols === this.contentW && sprite.rows === this.contentH ? bakeSprite(sprite) : null;
    this.baked.set(index, canvas);
    return canvas;
  }

  private ghostCanvasOf(index: number): HTMLCanvasElement | null {
    if (this.ghosts.has(index)) return this.ghosts.get(index) ?? null;
    const sprite = this.source.frameOf(index);
    const fits = sprite && sprite.cols === this.contentW && sprite.rows === this.contentH;
    const canvas = fits ? bakeSprite(sprite, { color: STAGE_COLORS.ghostPrevious, strength: TUNING.anim.ghostTint }) : null;
    this.ghosts.set(index, canvas);
    return canvas;
  }

  draw(ctx: CanvasRenderingContext2D, _fx: CanvasRenderingContext2D, now: number): boolean {
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
    if (frame) ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h);
    if (this.onion) {
      const ghost = this.ghostOf(this.current);
      const canvas = ghost === null || ghost === this.current ? null : this.ghostCanvasOf(ghost);
      if (canvas) {
        ctx.globalAlpha = TUNING.anim.ghostAlpha;
        ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
      }
    }
    return alive;
  }
}
