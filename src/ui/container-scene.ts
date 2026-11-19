import type { TileBox } from '../core/sprite.ts';
import { TUNING } from '../app/tuning.ts';
import { AnimScene, type AnimSource } from './anim-scene.ts';
import { progress, snap, STAGE_COLORS, viewRect, type Rect } from './stage-renderer.ts';

export type ContainerHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type ContainerPart = ContainerHandle | 'inside';

/**
 * What the container allows on the shown frame: `resize` on the first timeline entry (move and handles),
 * `move` on another entry (its content moves under the box), `preview` on a frame out of the timeline (dashed, no drag).
 */
export type ContainerMode = 'resize' | 'move' | 'preview';

export interface ContainerLabels {
  size: (cols: number, rows: number) => string;
}

const HANDLES: ReadonlyArray<{ id: ContainerHandle; fx: number; fy: number }> = [
  { id: 'nw', fx: 0, fy: 0 },
  { id: 'n', fx: 0.5, fy: 0 },
  { id: 'ne', fx: 1, fy: 0 },
  { id: 'e', fx: 1, fy: 0.5 },
  { id: 'se', fx: 1, fy: 1 },
  { id: 's', fx: 0.5, fy: 1 },
  { id: 'sw', fx: 0, fy: 1 },
  { id: 'w', fx: 0, fy: 0.5 },
];

const LABEL_FONT = '600 12px system-ui, sans-serif';
const LABEL_GAP = 6;
const LABEL_H = 20;
const DASH = [6, 4];

/** The Frames screen scene: the frame of the cursor, with the crop container over it. */
export class ContainerScene extends AnimScene {
  labels: ContainerLabels;
  private box: TileBox | null = null;
  private mode: ContainerMode = 'preview';
  private hover: ContainerPart | null = null;
  private active: ContainerPart | null = null;
  private flashStart = -1;

  constructor(source: AnimSource, fps: number, labels: ContainerLabels) {
    super(source, fps);
    this.labels = labels;
  }

  /** The container over the shown frame, in tiles of the frame, or null for none. */
  setContainer(box: TileBox | null, mode: ContainerMode): void {
    const same = box === this.box || (box !== null && this.box !== null && box.col === this.box.col && box.row === this.box.row && box.cols === this.box.cols && box.rows === this.box.rows);
    if (same && mode === this.mode) return;
    this.box = box;
    this.mode = mode;
    this.host?.invalidate();
  }

  setHover(part: ContainerPart | null): void {
    if (part === this.hover) return;
    this.hover = part;
    this.host?.invalidate();
  }

  setActive(part: ContainerPart | null): void {
    if (part === this.active) return;
    this.active = part;
    this.host?.invalidate();
  }

  /** A short highlight of the outline when a drag snaps to a new tile. */
  flash(): void {
    const host = this.host;
    if (!host || host.reducedMotion) return;
    this.flashStart = performance.now();
    host.invalidate();
  }

  /** The part of the container under a screen point: a handle (resize mode only), the inside, or null. */
  hit(sx: number, sy: number): ContainerPart | null {
    const rect = this.screenBox();
    if (!rect || this.mode === 'preview') return null;
    if (this.mode === 'resize') {
      const reach = TUNING.anim.handleHitPx;
      let best: ContainerHandle | null = null;
      let bestDistance = Infinity;
      for (const handle of HANDLES) {
        const distance = Math.max(Math.abs(sx - (rect.x + rect.w * handle.fx)), Math.abs(sy - (rect.y + rect.h * handle.fy)));
        if (distance <= reach && distance < bestDistance) {
          best = handle.id;
          bestDistance = distance;
        }
      }
      if (best) return best;
    }
    return sx >= rect.x && sx <= rect.x + rect.w && sy >= rect.y && sy <= rect.y + rect.h ? 'inside' : null;
  }

  private screenBox(): Rect | null {
    const host = this.host;
    const box = this.box;
    if (!host || !box) return null;
    const { camera } = host;
    const p = camera.imageToScreen(box.col, box.row);
    return { x: p.x, y: p.y, w: box.cols * camera.zoom, h: box.rows * camera.zoom };
  }

  draw(ctx: CanvasRenderingContext2D, fx: CanvasRenderingContext2D, now: number): boolean {
    let alive = super.draw(ctx, fx, now);
    const host = this.host;
    const rect = this.screenBox();
    const box = this.box;
    if (!host || !rect || !box) return alive;
    const { camera, dpr } = host;
    const view = viewRect(camera);
    const x = snap(rect.x, dpr) - 0.5 / dpr;
    const y = snap(rect.y, dpr) - 0.5 / dpr;
    const right = Math.round((rect.x + rect.w) * dpr) / dpr;
    const bottom = Math.round((rect.y + rect.h) * dpr) / dpr;

    // The outside of the box, as 4 bands over the view.
    ctx.globalAlpha = TUNING.anim.outsideDim;
    ctx.fillStyle = STAGE_COLORS.previewDark;
    const top = Math.max(view.y, Math.min(view.h, y));
    const low = Math.min(view.h, Math.max(view.y, bottom));
    ctx.fillRect(0, 0, view.w, top);
    ctx.fillRect(0, low, view.w, view.h - low);
    ctx.fillRect(0, top, Math.max(0, Math.min(view.w, x)), low - top);
    const from = Math.max(0, Math.min(view.w, right));
    ctx.fillRect(from, top, view.w - from, low - top);
    ctx.globalAlpha = 1;

    let flash = 0;
    if (this.flashStart >= 0) {
      const t = progress(now, this.flashStart, TUNING.anim.popMs);
      if (t >= 1) this.flashStart = -1;
      else {
        flash = 1 - t;
        alive = true;
      }
    }

    const w = right - x;
    const h = bottom - y;
    const dashed = this.mode === 'preview';
    ctx.lineWidth = 4;
    ctx.strokeStyle = STAGE_COLORS.shadow;
    if (dashed) ctx.setLineDash(DASH);
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = dashed ? STAGE_COLORS.white : STAGE_COLORS.accent;
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.setLineDash([]);
    if (flash > 0) {
      ctx.globalAlpha = flash;
      ctx.strokeStyle = STAGE_COLORS.gridFlash;
      ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
      ctx.globalAlpha = 1;
    }

    if (this.mode === 'resize') {
      for (const handle of HANDLES) this.drawHandle(ctx, rect.x + rect.w * handle.fx, rect.y + rect.h * handle.fy, this.active === handle.id, this.hover === handle.id);
    }
    this.drawLabel(ctx, rect, this.labels.size(box.cols, box.rows), camera.insets.top);
    return alive;
  }

  private drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean, hot: boolean): void {
    const size = TUNING.anim.handlePx + (hot || active ? 2 : 0);
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    const color = active ? STAGE_COLORS.accent : hot ? STAGE_COLORS.teal : STAGE_COLORS.white;
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(left + 2, top + 2, size, size);
    ctx.fillStyle = color;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = STAGE_COLORS.panel;
    ctx.fillRect(left + 3, top + 3, size - 6, size - 6);
  }

  /** The size of the box in a small pill above it; inside its top edge when the top band would cover it. */
  private drawLabel(ctx: CanvasRenderingContext2D, rect: Rect, text: string, topInset: number): void {
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const width = Math.ceil(ctx.measureText(text).width) + 12;
    const cx = Math.round(rect.x + rect.w / 2);
    const above = rect.y - LABEL_GAP - LABEL_H - (this.mode === 'resize' ? TUNING.anim.handlePx / 2 : 0);
    const y = Math.round(above >= topInset ? above : Math.max(topInset, rect.y) + LABEL_GAP + (this.mode === 'resize' ? TUNING.anim.handlePx / 2 : 0));
    const left = cx - Math.round(width / 2);
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(left + 2, y + 2, width, LABEL_H);
    ctx.fillStyle = STAGE_COLORS.panel;
    ctx.fillRect(left, y, width, LABEL_H);
    ctx.strokeStyle = this.mode === 'preview' ? STAGE_COLORS.panelEdge : STAGE_COLORS.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, y + 0.5, width - 1, LABEL_H - 1);
    ctx.fillStyle = STAGE_COLORS.white;
    ctx.fillText(text, cx, y + LABEL_H / 2 + 0.5);
  }
}
