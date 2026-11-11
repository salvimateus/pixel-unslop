import { TUNING } from '../app/tuning.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Tile {
  col: number;
  row: number;
}

interface ZoomTarget {
  zoom: number;
  screenX: number;
  screenY: number;
  imageX: number;
  imageY: number;
}

/**
 * Zoom and pan math between screen space (CSS pixels of the stage) and content space
 * (source pixels on the Grade screen, tiles on the Limpar screen). `zoom` is screen pixels per content unit.
 */
export class Camera {
  viewW = 1;
  viewH = 1;
  contentW = 1;
  contentH = 1;
  zoom = 1;
  panX = 0;
  panY = 0;
  minZoom = 0.05;
  maxZoom = 64;
  private target: ZoomTarget | null = null;

  get animating(): boolean {
    return this.target !== null;
  }

  /** Keeps the view center in place when the stage changes size. */
  setViewport(width: number, height: number): void {
    this.panX += (width - this.viewW) / 2;
    this.panY += (height - this.viewH) / 2;
    if (this.target) {
      this.target.screenX += (width - this.viewW) / 2;
      this.target.screenY += (height - this.viewH) / 2;
    }
    this.viewW = width;
    this.viewH = height;
  }

  setContent(width: number, height: number, maxZoom: number): void {
    this.contentW = Math.max(1, width);
    this.contentH = Math.max(1, height);
    this.maxZoom = maxZoom;
    this.minZoom = Math.min(1, this.fitZoom() * TUNING.zoom.minFitRatio);
  }

  /** The zoom that shows all the content with the stage padding. */
  fitZoom(): number {
    const pad = TUNING.stage.fitPadding;
    const zx = Math.max(1, this.viewW - pad * 2) / this.contentW;
    const zy = Math.max(1, this.viewH - pad * 2) / this.contentH;
    return Math.min(zx, zy);
  }

  /** Centers the content at the given zoom (the fit zoom when omitted). */
  fit(zoom = this.fitZoom()): void {
    this.minZoom = Math.min(1, this.fitZoom() * TUNING.zoom.minFitRatio);
    this.target = null;
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.panX = (this.viewW - this.contentW * this.zoom) / 2;
    this.panY = (this.viewH - this.contentH * this.zoom) / 2;
  }

  /** Zooms by `factor` and keeps the content point under (screenX, screenY) in place. */
  zoomAt(screenX: number, screenY: number, factor: number, animate = true): void {
    const base = this.target?.zoom ?? this.zoom;
    const zoom = clamp(base * factor, this.minZoom, this.maxZoom);
    const anchor = this.target
      ? { x: this.target.imageX + (screenX - this.target.screenX) / this.target.zoom, y: this.target.imageY + (screenY - this.target.screenY) / this.target.zoom }
      : this.screenToImage(screenX, screenY);
    this.target = { zoom, screenX, screenY, imageX: anchor.x, imageY: anchor.y };
    if (!animate) this.finishZoom();
  }

  zoomAtCenter(factor: number): void {
    this.zoomAt(this.viewW / 2, this.viewH / 2, factor);
  }

  /** Advances the smooth zoom. Returns true while it still moves. */
  step(dt: number): boolean {
    const target = this.target;
    if (!target) return false;
    const k = 1 - Math.exp(-TUNING.zoom.smoothing * dt);
    const logZoom = Math.log(this.zoom) + (Math.log(target.zoom) - Math.log(this.zoom)) * k;
    this.zoom = Math.exp(logZoom);
    if (Math.abs(Math.log(target.zoom / this.zoom)) < 0.002) this.zoom = target.zoom;
    this.panX = target.screenX - target.imageX * this.zoom;
    this.panY = target.screenY - target.imageY * this.zoom;
    this.clampPan();
    if (this.zoom === target.zoom) this.target = null;
    return this.target !== null;
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    if (this.target) {
      this.target.screenX += dx;
      this.target.screenY += dy;
    }
    this.clampPan();
  }

  screenToImage(screenX: number, screenY: number): Point {
    return { x: (screenX - this.panX) / this.zoom, y: (screenY - this.panY) / this.zoom };
  }

  imageToScreen(x: number, y: number): Point {
    return { x: this.panX + x * this.zoom, y: this.panY + y * this.zoom };
  }

  /** The tile under a screen point when one content unit is one tile, or null outside the content. */
  tileAt(screenX: number, screenY: number): Tile | null {
    const p = this.screenToImage(screenX, screenY);
    const col = Math.floor(p.x);
    const row = Math.floor(p.y);
    if (col < 0 || row < 0 || col >= this.contentW || row >= this.contentH) return null;
    return { col, row };
  }

  private finishZoom(): void {
    const target = this.target;
    if (!target) return;
    this.zoom = target.zoom;
    this.panX = target.screenX - target.imageX * this.zoom;
    this.panY = target.screenY - target.imageY * this.zoom;
    this.target = null;
    this.clampPan();
  }

  /** Part of the content always stays in view, so the user cannot lose the image. */
  private clampPan(): void {
    const keepX = Math.min(this.viewW, this.contentW * this.zoom) * TUNING.stage.panKeepVisible;
    const keepY = Math.min(this.viewH, this.contentH * this.zoom) * TUNING.stage.panKeepVisible;
    this.panX = clamp(this.panX, keepX - this.contentW * this.zoom, this.viewW - keepX);
    this.panY = clamp(this.panY, keepY - this.contentH * this.zoom, this.viewH - keepY);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
