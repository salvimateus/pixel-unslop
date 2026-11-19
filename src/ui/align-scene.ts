import type { TileBox } from '../core/sprite.ts';
import type { Sprite } from '../core/types.ts';
import { TUNING } from '../app/tuning.ts';
import type { Camera } from './camera.ts';
import type { PreviewBackground } from './clean-scene.ts';
import { bakeSprite, checkerPattern, drawFrame, intersect, progress, snap, STAGE_COLORS, strokeGrid, viewRect, type Rect, type Scene, type StageHost } from './stage-renderer.ts';

/** Which frame the ghost shows: it sets the tint of the ghost. */
export type GhostKind = 'previous' | 'first';

/** What the Align stage shows: the current frame, the ghost over it, and the cell inside both. */
export interface AlignLayers {
  current: Sprite | null;
  ghost: Sprite | null;
  ghostKind: GhostKind;
  /** The cell inside the sprites, in tiles. */
  inner: TileBox;
}

/** A black mask of the content with the cell cut out: drawn at the dim opacity over everything outside the cell. */
function bakeMask(width: number, height: number, inner: TileBox): HTMLCanvasElement | null {
  if (inner.col <= 0 && inner.row <= 0 && inner.cols >= width && inner.rows >= height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.clearRect(inner.col, inner.row, inner.cols, inner.rows);
  return canvas;
}

/**
 * The Align step: one frame under a faint tinted ghost of another, the area around the cell dimmed, and the guides of
 * the cell (its edges and its vertical center axis). Every layer is baked once per change, so a tick is a few
 * `drawImage` calls and two short paths.
 */
export class AlignScene implements Scene {
  readonly maxZoom = TUNING.anim.maxZoom;
  contentW = 1;
  contentH = 1;
  background: PreviewBackground = 'checker';
  guides = true;

  private host: StageHost | null = null;
  private current: HTMLCanvasElement | null = null;
  private ghost: HTMLCanvasElement | null = null;
  private mask: HTMLCanvasElement | null = null;
  private maskKey = '';
  private inner: TileBox = { col: 0, row: 0, cols: 1, rows: 1 };
  private flashStart = -1;

  constructor(layers: AlignLayers) {
    this.setLayers(layers);
  }

  attach(host: StageHost | null): void {
    this.host = host;
  }

  initialZoom(camera: Camera): number {
    // A whole zoom keeps every art pixel the same size on screen.
    const fit = camera.fitZoom();
    return fit >= 1 ? Math.floor(fit) : fit;
  }

  /** New pictures. Returns true when the content size changed: the caller then syncs the stage, never during a drag. */
  setLayers(layers: AlignLayers): boolean {
    const sprite = layers.current;
    const width = Math.max(1, sprite?.cols ?? this.contentW);
    const height = Math.max(1, sprite?.rows ?? this.contentH);
    const resized = width !== this.contentW || height !== this.contentH;
    this.contentW = width;
    this.contentH = height;
    this.current = sprite ? bakeSprite(sprite) : null;
    const ghost = layers.ghost;
    const tint = { color: layers.ghostKind === 'first' ? STAGE_COLORS.ghostFirst : STAGE_COLORS.ghostPrevious, strength: TUNING.anim.ghostTint };
    this.ghost = ghost && ghost.cols === width && ghost.rows === height ? bakeSprite(ghost, tint) : null;
    this.inner = layers.inner;
    const key = `${width}x${height}|${layers.inner.col},${layers.inner.row},${layers.inner.cols},${layers.inner.rows}`;
    if (key !== this.maskKey) {
      this.maskKey = key;
      this.mask = bakeMask(width, height, layers.inner);
    }
    this.host?.invalidate();
    return resized;
  }

  /** The juice of a frame whose drawing meets the center axis: the axis lights up for a moment. */
  flashAxis(): void {
    const host = this.host;
    if (!host || host.reducedMotion) return;
    this.flashStart = performance.now();
    host.invalidate();
  }

  invalidate(): void {
    this.host?.invalidate();
  }

  draw(ctx: CanvasRenderingContext2D, _fx: CanvasRenderingContext2D, now: number): boolean {
    const host = this.host;
    if (!host) return false;
    const { camera, dpr } = host;
    // The own size of the scene: during a drag the stage keeps the old content size until the drag ends.
    const rect: Rect = { x: camera.panX, y: camera.panY, w: this.contentW * camera.zoom, h: this.contentH * camera.zoom };
    drawFrame(ctx, rect, dpr);
    const clip = intersect(rect, viewRect(camera));
    if (!clip) return this.flashStart >= 0;
    ctx.fillStyle = this.background === 'checker' ? checkerPattern(ctx) : this.background === 'dark' ? STAGE_COLORS.previewDark : STAGE_COLORS.previewLight;
    ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
    ctx.imageSmoothingEnabled = false;
    if (this.current) ctx.drawImage(this.current, rect.x, rect.y, rect.w, rect.h);
    if (this.ghost) {
      ctx.globalAlpha = TUNING.anim.ghostAlpha;
      ctx.drawImage(this.ghost, rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
    }
    if (this.mask) {
      ctx.globalAlpha = TUNING.anim.outsideDim;
      ctx.drawImage(this.mask, rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
    }
    return this.drawGuides(ctx, rect, clip, dpr, now);
  }

  /** The cell edges and the center axis. Returns true while the axis flash runs. */
  private drawGuides(ctx: CanvasRenderingContext2D, rect: Rect, clip: Rect, dpr: number, now: number): boolean {
    let flash = 0;
    if (this.flashStart >= 0) {
      const t = progress(now, this.flashStart, TUNING.anim.axisFlashMs);
      if (t >= 1) this.flashStart = -1;
      else flash = 1 - t;
    }
    if (!this.guides && flash === 0) return false;
    const zoom = rect.w / this.contentW;
    const inner = this.inner;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    if (this.guides) {
      const edges = new Path2D();
      const left = snap(rect.x + inner.col * zoom, dpr);
      const top = snap(rect.y + inner.row * zoom, dpr);
      const right = snap(rect.x + (inner.col + inner.cols) * zoom, dpr);
      const bottom = snap(rect.y + (inner.row + inner.rows) * zoom, dpr);
      edges.rect(left, top, right - left, bottom - top);
      strokeGrid(ctx, edges, dpr, STAGE_COLORS.gridLine, true);
    }
    const axis = new Path2D();
    const x = snap(rect.x + (inner.col + inner.cols / 2) * zoom, dpr);
    axis.moveTo(x, clip.y);
    axis.lineTo(x, clip.y + clip.h);
    if (this.guides) strokeGrid(ctx, axis, dpr, STAGE_COLORS.teal, true, 1.5);
    if (flash > 0) {
      ctx.globalAlpha = flash;
      strokeGrid(ctx, axis, dpr, STAGE_COLORS.gridFlash, true, 1.5 + 3 * flash);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return flash > 0;
  }
}
