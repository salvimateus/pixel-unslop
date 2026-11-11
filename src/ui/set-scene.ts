import type { Sprite } from '../core/types.ts';
import { layoutSet, ratioLabel, isWholeStep, type ImageSet, type SetBox, type SetLayout, type SetObject } from '../app/image-set.svelte.ts';
import { TUNING } from '../app/tuning.ts';
import type { Camera, Point } from './camera.ts';
import type { PreviewBackground } from './clean-scene.ts';
import {
  STAGE_COLORS,
  checkerPattern,
  drawFrame,
  easeOutBack,
  easeOutCubic,
  gridPath,
  intersect,
  progress,
  sparkColors,
  strokeGrid,
  viewRect,
  type Rect,
  type Scene,
  type StageHost,
} from './stage-renderer.ts';

export interface SetLabels {
  height: (height: number) => string;
  empty: string;
  reference: string;
}

interface SpriteCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  sprite: Sprite | null;
}

interface Ring {
  id: number;
  start: number;
}

/** Where a content point of one object moved after a new layout, so the stage keeps it in place. */
export interface LayoutAnchor {
  from: Point;
  to: Point;
}

const LABEL_FONT = '600 12px system-ui, sans-serif';
const LABEL_H = 20;
const LABEL_GAP = 6;

/**
 * The set screen: the objects side by side on one ground line over the common grid, with a resize handle,
 * a height label and a ratio badge per object. Content units are pixels of the common grid.
 */
export class SetScene implements Scene {
  readonly maxZoom = TUNING.zoom.setMax;
  background: PreviewBackground = 'checker';
  selectedId: number | null = null;
  private host: StageHost | null = null;
  private readonly set: ImageSet;
  private readonly labels: SetLabels;
  /** The layout that the camera knows. A drag keeps it, so the content size stays still. */
  private frame: SetLayout;
  /** The layout drawn now: equal to `frame`, except during a drag. */
  private live: SetLayout;
  private ids: number[] = [];
  private boundsX = new Float64Array(0);
  private boundsY = new Float64Array(0);
  private readonly canvases = new Map<number, SpriteCanvas>();
  private readonly pops = new Map<number, number>();
  private readonly burstDone = new Set<number>();
  private pendingPops: number[] = [];
  private ring: Ring | null = null;
  private hoverId: number | null = null;
  private hoverHandle = false;
  private dragId: number | null = null;
  /** The object that a drag on its body moves along the ground line. */
  private moveId: number | null = null;
  /** The decoded source file of each object, for "Ver original"; null while it decodes. */
  private readonly originals = new Map<number, ImageBitmap | null>();
  /** 0 shows the results, 1 the originals; it moves to `originalTarget`. */
  private originalMix = 0;
  private originalTarget = 0;
  private originalFrom = 0;
  private originalStart = -1;
  private disposed = false;

  constructor(set: ImageSet, labels: SetLabels) {
    this.set = set;
    this.labels = labels;
    this.frame = set.layout;
    this.live = set.layout;
    this.ids = set.objects.map((object) => object.id);
    this.pendingPops = [...this.ids];
    this.updateBounds();
    this.loadOriginals();
  }

  /** Frees the decoded originals. */
  dispose(): void {
    this.disposed = true;
    for (const bitmap of this.originals.values()) bitmap?.close();
    this.originals.clear();
  }

  /** "Ver original": each object shows the part of its source image that its result covers. */
  setOriginal(on: boolean): void {
    const target = on ? 1 : 0;
    if (target === this.originalTarget) return;
    this.originalTarget = target;
    this.originalFrom = this.originalMix;
    this.originalStart = performance.now();
    if (!this.host || this.host.reducedMotion) {
      this.originalMix = target;
      this.originalStart = -1;
    }
    this.host?.invalidate();
  }

  private loadOriginals(): void {
    for (const [id, bitmap] of this.originals) {
      if (this.ids.includes(id)) continue;
      bitmap?.close();
      this.originals.delete(id);
    }
    for (const object of this.set.objects) {
      if (this.originals.has(object.id)) continue;
      const id = object.id;
      this.originals.set(id, null);
      createImageBitmap(new Blob([object.bytes]))
        .then((bitmap) => {
          if (this.disposed || !this.originals.has(id)) {
            bitmap.close();
            return;
          }
          this.originals.set(id, bitmap);
          if (this.originalMix > 0) this.host?.invalidate();
        })
        .catch(() => this.originals.delete(id));
    }
  }

  get contentW(): number {
    return this.frame.contentW;
  }

  get contentH(): number {
    return this.frame.contentH;
  }

  get zoom(): number {
    return this.host?.camera.zoom ?? 1;
  }

  attach(host: StageHost | null): void {
    this.host = host;
    if (host) this.startPops(this.pendingPops);
    this.pendingPops = [];
  }

  initialZoom(camera: Camera): number {
    return camera.fitZoom();
  }

  /**
   * Takes the committed layout of the set. Returns the objects that are new, and where the content point
   * of `prefer` (or of the first object that stays) moved, for `Stage.syncContent`.
   */
  refresh(prefer: number | null): { added: number[]; anchor: LayoutAnchor | null } {
    const oldBoxes = new Map(this.ids.map((id, i) => [id, this.live.boxes[i]] as const));
    this.frame = this.set.layout;
    this.live = this.frame;
    this.ids = this.set.objects.map((object) => object.id);
    this.updateBounds();
    for (const id of this.canvases.keys()) if (!this.ids.includes(id)) this.canvases.delete(id);
    this.loadOriginals();

    const added = this.ids.filter((id) => !oldBoxes.has(id));
    const anchorId = prefer !== null && oldBoxes.has(prefer) && this.ids.includes(prefer) ? prefer : this.ids.find((id) => oldBoxes.has(id));
    let anchor: LayoutAnchor | null = null;
    if (anchorId !== undefined) {
      const before = oldBoxes.get(anchorId);
      const after = this.frame.boxes[this.ids.indexOf(anchorId)];
      if (before && after) anchor = { from: { x: before.x, y: before.y + before.h }, to: { x: after.x, y: after.y + after.h } };
    }
    if (this.host) this.startPops(added);
    else this.pendingPops.push(...added);
    this.host?.invalidate();
    return { added, anchor };
  }

  /** Lays the objects out again during a drag, on the spacing of the frame. */
  updateLive(): void {
    this.live = layoutSet(this.set.dims(), this.frame, this.set.places(), this.set.hiddenFlags());
    if (Math.ceil(this.live.contentW) + 1 > this.boundsX.length) this.updateBounds();
    this.host?.invalidate();
  }

  /** A move of one object: it draws on top, and with less opacity while it overlaps another object. */
  beginMove(id: number): void {
    this.moveId = id;
    this.host?.invalidate();
  }

  endMove(): void {
    this.moveId = null;
    this.host?.invalidate();
  }

  beginDrag(id: number): void {
    this.dragId = id;
    this.host?.invalidate();
  }

  endDrag(): void {
    this.dragId = null;
    this.host?.invalidate();
  }

  setHover(id: number | null, handle: boolean): void {
    if (id === this.hoverId && handle === this.hoverHandle) return;
    this.hoverId = id;
    this.hoverHandle = handle;
    this.host?.invalidate();
  }

  /** A short ring around the handle when it snaps to a whole size. */
  flashHandle(id: number): void {
    if (!this.host || this.host.reducedMotion) return;
    this.ring = { id, start: performance.now() };
    this.host.invalidate();
  }

  boxOf(id: number): SetBox | null {
    const index = this.ids.indexOf(id);
    return index < 0 ? null : (this.live.boxes[index] ?? null);
  }

  hitHandle(sx: number, sy: number): number | null {
    const half = TUNING.set.handleHitPx / 2;
    return this.findFromTop((object, rect) => object.output !== null && !object.reference && Math.abs(sx - (rect.x + rect.w)) <= half && Math.abs(sy - rect.y) <= half);
  }

  hitWarning(sx: number, sy: number): number | null {
    const half = TUNING.set.warnBadgePx / 2;
    return this.findFromTop((object, rect) => isWeak(object) && Math.abs(sx - rect.x) <= half && Math.abs(sy - rect.y) <= half);
  }

  hitBackground(sx: number, sy: number): number | null {
    const half = TUNING.set.warnBadgePx / 2;
    return this.findFromTop((object, rect) => {
      if (!object.backgroundKept) return false;
      const x = rect.x + backgroundBadgeOffset(object);
      return Math.abs(sx - x) <= half && Math.abs(sy - rect.y) <= half;
    });
  }

  hitObject(sx: number, sy: number): number | null {
    return this.findFromTop((_, rect) => sx >= rect.x && sx <= rect.x + rect.w && sy >= rect.y && sy <= rect.y + rect.h);
  }

  draw(ctx: CanvasRenderingContext2D, fx: CanvasRenderingContext2D, now: number): boolean {
    const host = this.host;
    if (!host) return false;
    const { camera, dpr } = host;
    const zoom = camera.zoom;
    const rect: Rect = { x: camera.panX, y: camera.panY, w: Math.max(this.frame.contentW, this.live.contentW) * zoom, h: this.frame.contentH * zoom };
    const clip = intersect(rect, viewRect(camera));
    let alive = false;

    drawFrame(ctx, rect, dpr);
    if (!clip) return this.pops.size > 0;
    ctx.fillStyle = this.background === 'checker' ? checkerPattern(ctx) : this.background === 'dark' ? STAGE_COLORS.previewDark : STAGE_COLORS.previewLight;
    ctx.fillRect(clip.x, clip.y, clip.w, clip.h);

    const groundY = camera.panY + this.live.groundY * zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(rect.x, groundY, rect.w, rect.y + rect.h - groundY);
    ctx.globalAlpha = 1;

    const objects = this.set.objects;
    const rects = this.screenRects(camera);
    const order = this.drawOrder();
    if (this.dragId !== null) this.drawGuide(ctx, rect, rects[this.ids.indexOf(this.dragId)]);
    ctx.imageSmoothingEnabled = false;
    alive = this.stepOriginal(now) || alive;
    for (const i of order) if (!objects[i].hidden) alive = this.drawObject(ctx, objects[i], rects[i], groundY, now, this.overlapAlpha(i, rects)) || alive;

    if (zoom >= TUNING.set.gridMinCellPx) {
      const path = gridPath(this.boundsX, this.boundsY, camera, clip, dpr);
      const color = zoom >= TUNING.grid.minCellPx ? STAGE_COLORS.gridSoft : STAGE_COLORS.gridFaint;
      strokeGrid(ctx, path, dpr, color, zoom >= TUNING.grid.haloMinCellPx);
    }
    ctx.fillStyle = STAGE_COLORS.accent;
    ctx.fillRect(rect.x, Math.round(groundY * dpr) / dpr - 1, rect.w, 2);
    ctx.restore();

    for (const i of order) if (!objects[i].hidden) this.drawMarks(ctx, objects[i], rects[i]);
    this.drawLabels(ctx, objects, rects, groundY);
    alive = this.drawRing(fx, rects, now) || alive;
    return alive;
  }

  private findFromTop(test: (object: SetObject, rect: Rect) => boolean): number | null {
    const host = this.host;
    if (!host) return null;
    const objects = this.set.objects;
    const rects = this.screenRects(host.camera);
    const order = this.drawOrder();
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      if (rects[i] && !objects[i].hidden && test(objects[i], rects[i])) return objects[i].id;
    }
    return null;
  }

  /** List order, with the selected object and then the moved one on top: hits follow the same order. */
  private drawOrder(): number[] {
    const order = this.set.objects.map((_, i) => i);
    for (const id of [this.selectedId, this.moveId]) {
      const index = id === null ? -1 : this.ids.indexOf(id);
      if (index < 0) continue;
      order.splice(order.indexOf(index), 1);
      order.push(index);
    }
    return order;
  }

  /** The moved object shows the objects below it while it overlaps one of them. */
  private overlapAlpha(index: number, rects: Rect[]): number {
    if (this.moveId === null || this.ids[index] !== this.moveId) return 1;
    const a = rects[index];
    if (!a) return 1;
    const objects = this.set.objects;
    const overlaps = rects.some((b, i) => i !== index && b && !objects[i]?.hidden && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    return overlaps ? TUNING.set.overlapAlpha : 1;
  }

  private screenRects(camera: Camera): Rect[] {
    const zoom = camera.zoom;
    return this.live.boxes.map((box) => ({ x: camera.panX + box.x * zoom, y: camera.panY + box.y * zoom, w: box.w * zoom, h: box.h * zoom }));
  }

  private updateBounds(): void {
    const width = Math.ceil(Math.max(this.frame.contentW, this.live.contentW));
    this.boundsX = Float64Array.from({ length: width + 1 }, (_, i) => i);
    this.boundsY = Float64Array.from({ length: Math.ceil(this.frame.contentH) + 1 }, (_, i) => i);
  }

  private startPops(ids: readonly number[]): void {
    const host = this.host;
    if (!host || host.reducedMotion || ids.length === 0) return;
    const now = performance.now();
    ids.forEach((id, i) => this.pops.set(id, now + i * 70));
    host.invalidate();
  }

  private spriteCanvas(object: SetObject): HTMLCanvasElement | null {
    const sprite = object.output;
    if (!sprite) return null;
    let entry = this.canvases.get(object.id);
    if (!entry) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      entry = { canvas, ctx, sprite: null };
      this.canvases.set(object.id, entry);
    }
    if (entry.sprite !== sprite) {
      if (entry.canvas.width !== sprite.cols || entry.canvas.height !== sprite.rows) {
        entry.canvas.width = sprite.cols;
        entry.canvas.height = sprite.rows;
      }
      const image = entry.ctx.createImageData(sprite.cols, sprite.rows);
      new Uint32Array(image.data.buffer).set(sprite.pixels);
      entry.ctx.putImageData(image, 0, 0);
      entry.sprite = sprite;
    }
    return entry.canvas;
  }

  private drawObject(ctx: CanvasRenderingContext2D, object: SetObject, rect: Rect | undefined, groundY: number, now: number, alpha = 1): boolean {
    if (!rect) return false;
    const start = this.pops.get(object.id);
    let alive = false;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (start !== undefined) {
      const t = progress(now, start, TUNING.set.popMs);
      if (t >= 1) {
        this.pops.delete(object.id);
        this.burstDone.delete(object.id);
      } else {
        alive = true;
        const scale = Math.max(0.001, easeOutBack(t));
        const cx = rect.x + rect.w / 2;
        ctx.globalAlpha = alpha * Math.min(1, t * 3);
        ctx.translate(cx, groundY);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -groundY);
        if (t > 0 && !this.burstDone.has(object.id)) {
          this.burstDone.add(object.id);
          this.burst(cx, groundY);
        }
      }
    }
    const canvas = this.spriteCanvas(object);
    if (canvas) {
      const mix = this.originalMix;
      const base = ctx.globalAlpha;
      if (mix < 1) {
        ctx.globalAlpha = base * (1 - mix);
        ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h);
      }
      if (mix > 0) {
        ctx.globalAlpha = base * mix;
        this.drawOriginal(ctx, object, rect);
      }
      ctx.globalAlpha = base;
    } else {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = STAGE_COLORS.danger;
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(0, rect.w - 2), Math.max(0, rect.h - 2));
      ctx.setLineDash([]);
    }
    ctx.restore();
    return alive;
  }

  /** Moves the mix of "Ver original" toward its target. Returns true while it still moves. */
  private stepOriginal(now: number): boolean {
    if (this.originalStart < 0) return false;
    const t = progress(now, this.originalStart, TUNING.set.originalFadeMs);
    this.originalMix = this.originalFrom + (this.originalTarget - this.originalFrom) * t;
    if (t >= 1) this.originalStart = -1;
    return t < 1;
  }

  /** The part of the source image under the trimmed tiles of the object, in the box of its result. */
  private drawOriginal(ctx: CanvasRenderingContext2D, object: SetObject, rect: Rect): void {
    const bitmap = this.originals.get(object.id);
    const trim = object.trim;
    if (!bitmap || !trim) return;
    const xs = object.fit.grid.x;
    const ys = object.fit.grid.y;
    const sx = xs[trim.col];
    const sy = ys[trim.row];
    const sw = xs[trim.col + trim.cols] - sx;
    const sh = ys[trim.row + trim.rows] - sy;
    if (!(sw > 0) || !(sh > 0)) return;
    ctx.imageSmoothingEnabled = rect.w < sw;
    ctx.drawImage(bitmap, sx, sy, sw, sh, rect.x, rect.y, rect.w, rect.h);
    ctx.imageSmoothingEnabled = false;
  }

  private burst(x: number, y: number): void {
    const host = this.host;
    if (!host) return;
    host.particles.burst(x, y, {
      count: 3,
      colors: sparkColors(),
      speed: [60, 200],
      angle: -Math.PI / 2,
      spread: Math.PI * 0.8,
      gravity: 500,
      life: [0.25, TUNING.particles.sparkLifeS],
      size: [2, 4],
    });
  }

  /** A dashed line at the top of the dragged object, to compare its height with the others. */
  private drawGuide(ctx: CanvasRenderingContext2D, frame: Rect, rect: Rect | undefined): void {
    if (!rect) return;
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = STAGE_COLORS.teal;
    ctx.lineWidth = 1;
    const y = Math.round(rect.y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(frame.x, y);
    ctx.lineTo(frame.x + frame.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawMarks(ctx: CanvasRenderingContext2D, object: SetObject, rect: Rect | undefined): void {
    if (!rect) return;
    const selected = object.id === this.selectedId;
    const hovered = object.id === this.hoverId;
    const dragging = object.id === this.dragId;
    if (selected || dragging) {
      ctx.strokeStyle = STAGE_COLORS.shadow;
      ctx.lineWidth = 4;
      ctx.strokeRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
      ctx.strokeStyle = STAGE_COLORS.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
    } else if (hovered) {
      ctx.strokeStyle = STAGE_COLORS.gridLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x - 2.5, rect.y - 2.5, rect.w + 5, rect.h + 5);
    }
    if (object.reference) {
      this.drawLock(ctx, rect.x + rect.w, rect.y);
      return;
    }
    if (object.output) this.drawHandle(ctx, rect.x + rect.w, rect.y, selected || dragging, hovered && this.hoverHandle);
    if (isWeak(object)) this.drawWarning(ctx, rect.x, rect.y);
    if (object.backgroundKept) this.drawBackgroundBadge(ctx, rect.x + backgroundBadgeOffset(object), rect.y);
  }

  /** A padlock where the handle of a normal piece is: a reference never changes size. */
  private drawLock(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const size = TUNING.set.warnBadgePx;
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(left + 2, top + 2, size, size);
    ctx.fillStyle = STAGE_COLORS.teal;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = STAGE_COLORS.panel;
    ctx.fillRect(left + 4, top + 8, size - 8, size - 11);
    ctx.fillRect(left + 6, top + 3, 2, 5);
    ctx.fillRect(left + size - 8, top + 3, 2, 5);
    ctx.fillRect(left + 6, top + 3, size - 12, 2);
    ctx.fillStyle = STAGE_COLORS.teal;
    ctx.fillRect(left + size / 2 - 1, top + 10, 2, 3);
  }

  /** A small picture glyph (frame, sun, hill): the scenery behind the object was not removed. */
  private drawBackgroundBadge(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const size = TUNING.set.warnBadgePx;
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(left + 2, top + 2, size, size);
    ctx.fillStyle = STAGE_COLORS.danger;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = STAGE_COLORS.white;
    ctx.fillRect(left + 3, top + 3, size - 6, size - 6);
    ctx.fillStyle = STAGE_COLORS.danger;
    ctx.fillRect(left + 5, top + 5, 3, 3);
    ctx.fillRect(left + 4, top + size - 7, size - 8, 3);
    ctx.fillRect(left + 7, top + size - 9, 5, 2);
  }

  private drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean, hot: boolean): void {
    const size = TUNING.set.handlePx + (hot || active ? 2 : 0);
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(left + 2, top + 2, size, size);
    ctx.fillStyle = active ? STAGE_COLORS.accent : hot ? STAGE_COLORS.teal : STAGE_COLORS.white;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = STAGE_COLORS.panel;
    ctx.fillRect(left + 3, top + 3, size - 6, size - 6);
    ctx.fillStyle = active ? STAGE_COLORS.accent : hot ? STAGE_COLORS.teal : STAGE_COLORS.white;
    ctx.fillRect(left + size / 2 - 1, top + size / 2 - 1, 2, 2);
  }

  private drawWarning(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const size = TUNING.set.warnBadgePx;
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(left + 2, top + 2, size, size);
    ctx.fillStyle = STAGE_COLORS.yellow;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = STAGE_COLORS.panel;
    ctx.fillRect(left + size / 2 - 1, top + 4, 2, size - 11);
    ctx.fillRect(left + size / 2 - 1, top + size - 6, 2, 2);
  }

  /** The height and the ratio badge under each object. Labels that would touch move to a second row. */
  private drawLabels(ctx: CanvasRenderingContext2D, objects: readonly SetObject[], rects: Rect[], groundY: number): void {
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const rowEnds = [-Infinity, -Infinity];
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const rect = rects[i];
      if (!rect || object.hidden) continue;
      const prepared = object.prepared;
      const text = object.output ? this.labels.height(object.height) : this.labels.empty;
      const badge = object.reference ? this.labels.reference : prepared && object.output ? ratioLabel(object.step, prepared.rows, object.height) : null;
      const textW = ctx.measureText(text).width + 14;
      const badgeW = badge ? ctx.measureText(badge).width + 12 : 0;
      const width = textW + (badge ? badgeW + 4 : 0);
      const left = Math.round(rect.x + rect.w / 2 - width / 2);
      const row = left > rowEnds[0] + LABEL_GAP ? 0 : left > rowEnds[1] + LABEL_GAP ? 1 : 0;
      rowEnds[row] = left + width;
      const top = Math.round(groundY + 10 + row * (LABEL_H + 6));
      const emphasis = object.id === this.selectedId || object.id === this.dragId;

      ctx.fillStyle = STAGE_COLORS.shadow;
      ctx.fillRect(left + 2, top + 2, width, LABEL_H);
      ctx.fillStyle = STAGE_COLORS.panel;
      ctx.fillRect(left, top, textW, LABEL_H);
      ctx.strokeStyle = emphasis ? STAGE_COLORS.accent : object.output ? STAGE_COLORS.panelEdge : STAGE_COLORS.danger;
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, textW - 1, LABEL_H - 1);
      ctx.fillStyle = STAGE_COLORS.white;
      ctx.fillText(text, left + 7, top + LABEL_H / 2 + 1);
      if (badge) {
        const bx = left + textW + 4;
        const exact = isWholeStep(object.step);
        ctx.fillStyle = object.reference ? STAGE_COLORS.teal : Math.abs(object.step - 1) < 1e-9 ? STAGE_COLORS.panelEdge : exact ? STAGE_COLORS.accent : STAGE_COLORS.yellow;
        ctx.fillRect(bx, top, badgeW, LABEL_H);
        ctx.fillStyle = STAGE_COLORS.panel;
        ctx.fillText(badge, bx + 6, top + LABEL_H / 2 + 1);
      }
    }
  }

  private drawRing(fx: CanvasRenderingContext2D, rects: Rect[], now: number): boolean {
    const ring = this.ring;
    if (!ring) return false;
    const t = progress(now, ring.start, TUNING.set.snapRingMs);
    const rect = rects[this.ids.indexOf(ring.id)];
    if (t >= 1 || !rect) {
      this.ring = null;
      return false;
    }
    const half = TUNING.set.handlePx / 2 + 14 * easeOutCubic(t);
    fx.globalAlpha = 1 - t;
    fx.strokeStyle = STAGE_COLORS.accent;
    fx.lineWidth = 2;
    fx.strokeRect(rect.x + rect.w - half, rect.y - half, half * 2, half * 2);
    fx.globalAlpha = 1;
    return true;
  }
}

function isWeak(object: SetObject): boolean {
  return !object.reference && object.fit.quality === 1;
}

/** The background badge sits right of the weak-grid badge when both show. */
function backgroundBadgeOffset(object: SetObject): number {
  return isWeak(object) ? TUNING.set.warnBadgePx + 4 : 0;
}
