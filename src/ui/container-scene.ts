import type { TileBox } from '../core/sprite.ts';
import { TUNING } from '../app/tuning.ts';
import { AnimScene, type AnimSource } from './anim-scene.ts';
import { crispEdges, dimOutside, drawBoxLabel, drawHandles, hitBox, sameTileBox, strokeBox, type BoxPart } from './box-handles.ts';
import { progress, viewRect, type Rect } from './stage-renderer.ts';

export type ContainerPart = BoxPart;

/**
 * What the container allows on the shown frame: `resize` on the first timeline entry (move and handles),
 * `move` on another entry (its content moves under the box), `preview` on a frame out of the timeline (dashed, no drag).
 */
export type ContainerMode = 'resize' | 'move' | 'preview';

export interface ContainerLabels {
  size: (cols: number, rows: number) => string;
}

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
    const same = box === this.box || (box !== null && this.box !== null && sameTileBox(box, this.box));
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
    return hitBox(rect, sx, sy, this.mode === 'resize' ? TUNING.anim.handleHitPx : null);
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
    const edges = crispEdges(rect, dpr);
    dimOutside(ctx, viewRect(camera), edges, TUNING.anim.outsideDim);

    let flash = 0;
    if (this.flashStart >= 0) {
      const t = progress(now, this.flashStart, TUNING.anim.popMs);
      if (t >= 1) this.flashStart = -1;
      else {
        flash = 1 - t;
        alive = true;
      }
    }

    strokeBox(ctx, edges, this.mode === 'preview', flash);
    const resize = this.mode === 'resize';
    if (resize) drawHandles(ctx, rect, TUNING.anim.handlePx, 2, this.active, this.hover);
    drawBoxLabel(ctx, rect, this.labels.size(box.cols, box.rows), camera.insets.top, resize ? TUNING.anim.handlePx / 2 : 0, this.mode !== 'preview');
    return alive;
  }
}
