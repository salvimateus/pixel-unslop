import type { GridFit, Selection } from '../core/types.ts';
import { TUNING } from '../app/tuning.ts';
import { clamp, type Camera, type Point } from './camera.ts';
import {
  STAGE_COLORS,
  checkerPattern,
  contentRect,
  drawFrame,
  easeOutBack,
  gridPath,
  intersect,
  progress,
  strokeGrid,
  viewRect,
  type Rect,
  type Scene,
  type StageHost,
  type ViewMap,
} from './stage-renderer.ts';

/** `lock` flashes the grid; `scan-lock` scans it in, then flashes it. */
export type FitEffect = 'scan' | 'scan-lock' | 'lock' | 'none';

interface BoxSettle {
  from: Selection;
  to: Selection;
  start: number;
}

/** The Grade screen: the original image, the fitted grid, the user box and the loupe. */
export class GridScene implements Scene {
  readonly contentW: number;
  readonly contentH: number;
  readonly maxZoom = TUNING.zoom.gridMax;
  private readonly bitmap: ImageBitmap;
  private host: StageHost | null = null;
  private fit: GridFit | null = null;
  private scanStart = -1;
  private flashStart = -1;
  private dragBox: Selection | null = null;
  private loupeAt: Point | null = null;
  private settle: BoxSettle | null = null;
  private lockAfterScan = false;
  /** An effect asked for before the stage attached the scene. */
  private pendingEffect: FitEffect | null = null;
  /** Called when the grid flashes, so the screen can play the lock sound. */
  onLock: (() => void) | null = null;

  constructor(bitmap: ImageBitmap, width: number, height: number) {
    this.bitmap = bitmap;
    this.contentW = width;
    this.contentH = height;
  }

  attach(host: StageHost | null): void {
    this.host = host;
    const pending = this.pendingEffect;
    if (host && pending && this.fit) {
      this.pendingEffect = null;
      this.setFit(this.fit, pending);
    }
  }

  initialZoom(camera: Camera): number {
    const fitZoom = camera.fitZoom();
    const period = this.fit ? Math.min(this.fit.axes.x.period, this.fit.axes.y.period) : 1;
    return Math.min(TUNING.zoom.gridFirstCellPx / Math.max(period, 0.0001), fitZoom);
  }

  /** Screen size of the smaller cell side at the current zoom. */
  cellScreenSize(): number {
    if (!this.fit || !this.host) return 0;
    return Math.min(this.fit.axes.x.period, this.fit.axes.y.period) * this.host.camera.zoom;
  }

  setFit(fit: GridFit, effect: FitEffect): void {
    this.fit = fit;
    if (!this.host) {
      this.pendingEffect = effect;
      return;
    }
    const animate = this.host !== null && !this.host.reducedMotion;
    const scan = effect === 'scan' || effect === 'scan-lock';
    const lock = effect === 'lock' || effect === 'scan-lock';
    if (scan && animate) {
      this.scanStart = performance.now();
      this.lockAfterScan = lock;
    } else if (lock) {
      this.lock();
    }
    this.host?.invalidate();
  }

  private lock(): void {
    this.lockAfterScan = false;
    if (this.host && !this.host.reducedMotion) this.flashStart = performance.now();
    this.onLock?.();
    this.host?.invalidate();
  }

  setDrag(box: Selection | null, cursor: Point | null): void {
    this.dragBox = box;
    this.loupeAt = box ? cursor : null;
    if (box) this.settle = null;
    this.host?.invalidate();
  }

  /** Animates the user box to the fitted cell under its center. */
  settleBox(from: Selection): void {
    const to = this.fit ? cellAt(this.fit, from.x + from.w / 2, from.y + from.h / 2) : null;
    this.dragBox = null;
    this.loupeAt = null;
    if (!to) {
      this.settle = null;
    } else {
      const start = this.host?.reducedMotion ? performance.now() - TUNING.grid.boxSettleMs : performance.now();
      this.settle = { from, to, start };
    }
    this.host?.invalidate();
  }

  draw(ctx: CanvasRenderingContext2D, fx: CanvasRenderingContext2D, now: number): boolean {
    const host = this.host;
    if (!host) return false;
    const { camera, dpr } = host;
    const rect = contentRect(camera);
    const clip = intersect(rect, viewRect(camera));

    drawFrame(ctx, rect, dpr);
    if (clip) {
      ctx.fillStyle = checkerPattern(ctx);
      ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
    }
    // Source pixels stay square blocks when enlarged; only a reduced view is smoothed.
    ctx.imageSmoothingEnabled = camera.zoom < 1;
    ctx.drawImage(this.bitmap, rect.x, rect.y, rect.w, rect.h);
    ctx.imageSmoothingEnabled = false;

    let alive = false;
    if (clip && this.fit) alive = this.drawGrid(ctx, clip, rect, now) || alive;
    alive = this.drawBoxes(ctx, camera, now) || alive;
    if (this.dragBox && this.loupeAt) this.drawLoupe(fx, this.loupeAt);
    return alive;
  }

  private drawGrid(ctx: CanvasRenderingContext2D, clip: Rect, rect: Rect, now: number): boolean {
    const host = this.host;
    const fit = this.fit;
    if (!host || !fit) return false;
    const { dpr } = host;
    const scan = progress(now, this.scanStart, TUNING.grid.scanMs);
    const flash = 1 - progress(now, this.flashStart, TUNING.grid.flashMs);
    const cell = this.cellScreenSize();
    const visible = cell >= TUNING.grid.minCellPx;

    if (visible) {
      const path = gridPath(fit.grid.x, fit.grid.y, host.camera, clip, dpr);
      ctx.save();
      if (scan < 1) {
        const scanY = rect.y + rect.h * scan;
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, Math.max(0, scanY - clip.y));
        ctx.clip();
      }
      strokeGrid(ctx, path, dpr, STAGE_COLORS.gridLine, cell >= TUNING.grid.haloMinCellPx);
      if (flash > 0) {
        ctx.globalAlpha = flash;
        strokeGrid(ctx, path, dpr, STAGE_COLORS.gridFlash, false, 2);
      }
      ctx.restore();
    }

    if (flash > 0) {
      ctx.globalAlpha = 0.14 * flash;
      ctx.fillStyle = STAGE_COLORS.gridFlash;
      ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
      ctx.globalAlpha = 1;
    }

    if (scan < 1) {
      const scanY = rect.y + rect.h * scan;
      if (scanY >= clip.y && scanY <= clip.y + clip.h) {
        ctx.fillStyle = STAGE_COLORS.accentFill;
        ctx.fillRect(clip.x, scanY - 18, clip.w, 18);
        ctx.fillStyle = STAGE_COLORS.accent;
        ctx.fillRect(clip.x, scanY - 1.5, clip.w, 3);
      }
    }
    if (scan >= 1 && this.scanStart >= 0) {
      this.scanStart = -1;
      if (this.lockAfterScan) this.lock();
    }
    if (flash <= 0) this.flashStart = -1;
    return scan < 1 || flash > 0;
  }

  private drawBoxes(ctx: CanvasRenderingContext2D, camera: Camera, now: number): boolean {
    if (this.dragBox) {
      drawBox(ctx, toScreen(camera, this.dragBox), 1);
      return false;
    }
    const settle = this.settle;
    if (!settle) return false;
    const { boxSettleMs, boxHoldMs, boxFadeMs } = TUNING.grid;
    const elapsed = now - settle.start;
    const t = easeOutBack(clamp(elapsed / boxSettleMs, 0, 1));
    const box: Selection = {
      x: lerp(settle.from.x, settle.to.x, t),
      y: lerp(settle.from.y, settle.to.y, t),
      w: lerp(settle.from.w, settle.to.w, t),
      h: lerp(settle.from.h, settle.to.h, t),
    };
    const fade = 1 - clamp((elapsed - boxSettleMs - boxHoldMs) / boxFadeMs, 0, 1);
    if (fade <= 0) {
      this.settle = null;
      return false;
    }
    drawBox(ctx, toScreen(camera, box), fade);
    return true;
  }

  private drawLoupe(fx: CanvasRenderingContext2D, at: Point): void {
    const host = this.host;
    if (!host) return;
    const { camera, dpr } = host;
    const { size, offset, magnify, maxZoom } = TUNING.loupe;
    let x = at.x + offset;
    let y = at.y - offset - size;
    if (x + size > camera.viewW - 8) x = at.x - offset - size;
    if (y < 8) y = at.y + offset;
    x = clamp(x, 8, Math.max(8, camera.viewW - size - 8));
    y = clamp(y, 8, Math.max(8, camera.viewH - size - 8));
    const box: Rect = { x, y, w: size, h: size };

    const zoom = Math.max(camera.zoom * 1.5, Math.min(camera.zoom * magnify, maxZoom));
    const center = camera.screenToImage(at.x, at.y);
    const map: ViewMap = { zoom, panX: x + size / 2 - center.x * zoom, panY: y + size / 2 - center.y * zoom };

    fx.fillStyle = STAGE_COLORS.shadow;
    fx.fillRect(x + 6, y + 6, size, size);
    fx.save();
    fx.beginPath();
    fx.rect(x, y, size, size);
    fx.clip();
    fx.fillStyle = checkerPattern(fx);
    fx.fillRect(x, y, size, size);
    fx.imageSmoothingEnabled = false;
    fx.drawImage(this.bitmap, map.panX, map.panY, this.contentW * zoom, this.contentH * zoom);
    if (this.fit) strokeGrid(fx, gridPath(this.fit.grid.x, this.fit.grid.y, map, box, dpr), dpr, STAGE_COLORS.gridLine, true);
    if (this.dragBox) {
      const b = this.dragBox;
      fx.strokeStyle = STAGE_COLORS.accent;
      fx.lineWidth = 2;
      fx.strokeRect(map.panX + b.x * zoom, map.panY + b.y * zoom, b.w * zoom, b.h * zoom);
    }
    fx.fillStyle = STAGE_COLORS.white;
    fx.fillRect(x + size / 2 - 5, y + size / 2 - 0.5, 10, 1);
    fx.fillRect(x + size / 2 - 0.5, y + size / 2 - 5, 1, 10);
    fx.restore();
    fx.strokeStyle = STAGE_COLORS.accent;
    fx.lineWidth = 3;
    fx.strokeRect(x - 1.5, y - 1.5, size + 3, size + 3);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function toScreen(camera: Camera, box: Selection): Rect {
  const p = camera.imageToScreen(box.x, box.y);
  return { x: p.x, y: p.y, w: box.w * camera.zoom, h: box.h * camera.zoom };
}

function drawBox(ctx: CanvasRenderingContext2D, rect: Rect, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = STAGE_COLORS.accentFill;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = STAGE_COLORS.shadow;
  ctx.lineWidth = 4;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = STAGE_COLORS.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  const knob = 6;
  ctx.fillStyle = STAGE_COLORS.accent;
  for (const [cx, cy] of [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ]) {
    ctx.fillRect(cx - knob / 2, cy - knob / 2, knob, knob);
  }
  ctx.restore();
}

function findCell(bounds: Float64Array, value: number): number {
  for (let i = 0; i < bounds.length - 1; i++) if (value >= bounds[i] && value < bounds[i + 1]) return i;
  return -1;
}

function cellAt(fit: GridFit, x: number, y: number): Selection | null {
  const col = findCell(fit.grid.x, x);
  const row = findCell(fit.grid.y, y);
  if (col < 0 || row < 0) return null;
  return { x: fit.grid.x[col], y: fit.grid.y[row], w: fit.grid.x[col + 1] - fit.grid.x[col], h: fit.grid.y[row + 1] - fit.grid.y[row] };
}
