import type { CellGrid, GridFit, Selection } from '../core/types.ts';
import { TUNING } from '../app/tuning.ts';
import { clamp, type Camera, type Point } from './camera.ts';
import type { CanvasBox } from './canvas-box.ts';
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

export type Axis = 'x' | 'y';

/** A grid line: `index` is the bound index on its axis. */
export interface GridLine {
  axis: Axis;
  index: number;
}

/** The line marks of the "Ajustar linhas" mode. */
export interface LineMarks {
  hover: GridLine | null;
  selected: GridLine | null;
  dragging: boolean;
}

/** Bounds at `offset + k * period` that cover [0, length]: the grid that a pixel size gives before the fit answers. */
export function regularBounds(offset: number, period: number, length: number): Float64Array {
  const first = offset - Math.ceil(offset / period) * period;
  const count = Math.max(1, Math.ceil((length - first) / period - 1e-9));
  return Float64Array.from({ length: count + 1 }, (_, k) => first + k * period);
}

/**
 * The lines next to a cell whose size is off the period by more than a share of it. A flexible grid drifts a
 * little everywhere, so the cell sizes tell the lines that really moved, not the distance to a fixed lattice.
 */
function movedBounds(bounds: Float64Array, period: number): Float64Array {
  const limit = period * TUNING.grid.movedLineShare;
  const off = (i: number) => i > 0 && i < bounds.length && Math.abs(bounds[i] - bounds[i - 1] - period) > limit;
  const moved: number[] = [];
  for (let i = 0; i < bounds.length; i++) if (off(i) || off(i + 1)) moved.push(bounds[i]);
  return Float64Array.from(moved);
}

/** The zoomed detail of the panel: a canvas that the scene draws on each frame. */
interface DetailView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** The CSS size and the exact physical size of the canvas. */
  box: CanvasBox;
}

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
  /** A grid drawn before the fit answers (live pixel size) or during a line drag. It wins over the fit. */
  private preview: CellGrid | null = null;
  private previewCell = 0;
  private movedX: Float64Array = new Float64Array(0);
  private movedY: Float64Array = new Float64Array(0);
  /** While the pixel size slider is pressed: the grid shows at any zoom, with the loupe when cells are small. */
  private pressing = false;
  private lineMarks: LineMarks = { hover: null, selected: null, dragging: false };
  private scanStart = -1;
  private flashStart = -1;
  private dragBox: Selection | null = null;
  private loupeAt: Point | null = null;
  private settle: BoxSettle | null = null;
  private lockAfterScan = false;
  /** An effect asked for before the stage attached the scene. */
  private pendingEffect: FitEffect | null = null;
  private detail: DetailView | null = null;
  /** A Ctrl drag: the grid of the fit, its moved lines included, drawn at this offset until the worker answers. */
  private shift: { x: number; y: number } | null = null;
  private shifted: { grid: CellGrid; movedX: Float64Array; movedY: Float64Array } | null = null;
  /** The square that the user marked; the grid keeps one cell on it, and that cell is outlined. */
  private mark: Selection | null = null;
  /** The image point that the detail shows: the pointer over the image, else the center of the view. */
  private focus: Point | null = null;
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
    if (!this.host) return 0;
    if (this.preview && this.previewCell > 0) return this.previewCell * this.host.camera.zoom;
    if (!this.fit) return 0;
    return Math.min(this.fit.axes.x.period, this.fit.axes.y.period) * this.host.camera.zoom;
  }

  /** The grid on screen now: the preview while one exists, else the fit, at the offset of a Ctrl drag. */
  get grid(): CellGrid | null {
    return this.preview ?? this.shifted?.grid ?? this.fit?.grid ?? null;
  }

  /** Moves the full grid as one rigid body, the moved lines of the flexible grid too; null ends the move. */
  setShift(shift: { x: number; y: number } | null): void {
    this.shift = shift;
    this.updateShifted();
    this.host?.invalidate();
  }

  private updateShifted(): void {
    const fit = this.fit;
    const shift = this.shift;
    if (!fit || !shift) {
      this.shifted = null;
      return;
    }
    const by = (bounds: Float64Array, d: number) => bounds.map((v) => v + d);
    this.shifted = { grid: { x: by(fit.grid.x, shift.x), y: by(fit.grid.y, shift.y) }, movedX: by(this.movedX, shift.x), movedY: by(this.movedY, shift.y) };
  }

  /** Shows a grid at once, before the worker answers. `cell` is its smaller cell side in source pixels. */
  setPreview(grid: CellGrid | null, cell = 0): void {
    this.preview = grid;
    this.previewCell = cell;
    if (grid) this.scanStart = -1;
    this.host?.invalidate();
  }

  /** Gives the scene the canvas of the zoomed detail, with its box; null removes it. */
  setDetail(canvas: HTMLCanvasElement | null, box: CanvasBox | null = null): void {
    const ctx = canvas?.getContext('2d') ?? null;
    this.detail = canvas && ctx && box ? { canvas, ctx, box } : null;
    if (!this.detail || !this.host) return;
    this.drawDetail();
  }

  setMark(mark: Selection | null): void {
    if (mark === this.mark) return;
    this.mark = mark;
    this.host?.invalidate();
  }

  /** The cell of the grid on screen under the center of the marked square. */
  private markedCell(): Selection | null {
    const grid = this.grid;
    const mark = this.mark;
    if (!grid || !mark) return null;
    const col = findCell(grid.x, mark.x + mark.w / 2 + (this.shift?.x ?? 0));
    const row = findCell(grid.y, mark.y + mark.h / 2 + (this.shift?.y ?? 0));
    if (col < 0 || row < 0) return null;
    return { x: grid.x[col], y: grid.y[row], w: grid.x[col + 1] - grid.x[col], h: grid.y[row + 1] - grid.y[row] };
  }

  /** The image point of the zoomed detail; null follows the center of the view. */
  setFocus(point: Point | null): void {
    if (point === this.focus || (point && this.focus && point.x === this.focus.x && point.y === this.focus.y)) return;
    this.focus = point;
    this.host?.invalidate();
  }

  setPressing(on: boolean): void {
    if (on === this.pressing) return;
    this.pressing = on;
    this.host?.invalidate();
  }

  setLineMarks(marks: LineMarks): void {
    this.lineMarks = marks;
    this.host?.invalidate();
  }

  /** The grid line under a screen point, or null. Only the lines inside the image can be taken. */
  lineAt(sx: number, sy: number): GridLine | null {
    const host = this.host;
    const grid = this.grid;
    if (!host || !grid) return null;
    const { camera } = host;
    const p = camera.screenToImage(sx, sy);
    if (p.x < 0 || p.y < 0 || p.x > this.contentW || p.y > this.contentH) return null;
    const reach = TUNING.grid.lineHitPx / camera.zoom;
    let best: GridLine | null = null;
    let bestDistance = reach;
    for (const axis of ['x', 'y'] as const) {
      const bounds = grid[axis];
      const at = axis === 'x' ? p.x : p.y;
      for (let i = 0; i < bounds.length; i++) {
        const distance = Math.abs(bounds[i] - at);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = { axis, index: i };
        }
      }
    }
    return best;
  }

  setFit(fit: GridFit, effect: FitEffect): void {
    this.fit = fit;
    this.movedX = movedBounds(fit.grid.x, fit.axes.x.period);
    this.movedY = movedBounds(fit.grid.y, fit.axes.y.period);
    this.updateShifted();
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
    if (this.dragBox && this.loupeAt) this.drawLoupe(fx, this.loupeAt, false);
    else if (this.pressing && this.cellScreenSize() < TUNING.grid.minCellPx) this.drawLoupe(fx, { x: camera.viewW / 2, y: camera.viewH / 2 }, true);
    this.drawDetail();
    return alive;
  }

  /** The smaller cell side of the grid on screen now, in source pixels. */
  private sourceCell(): number {
    if (this.preview && this.previewCell > 0) return this.previewCell;
    return this.fit ? Math.min(this.fit.axes.x.period, this.fit.axes.y.period) : 1;
  }

  /** The art around the focus point at a zoom where one art pixel is large, with the grid on it. */
  private drawDetail(): void {
    const detail = this.detail;
    const host = this.host;
    if (!detail || !host) return;
    const { ctx } = detail;
    const { cssW: w, cssH: h, pxW, pxH } = detail.box;
    const { camera } = host;
    // The backing store equals the box in physical pixels: the browser shows it with no resampling.
    const dpr = pxW / w;
    if (detail.canvas.width !== pxW || detail.canvas.height !== pxH) {
      detail.canvas.width = pxW;
      detail.canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, pxH / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const view = this.focus ?? camera.screenToImage(camera.viewW / 2, camera.viewH / 2);
    const center = { x: clamp(view.x, 0, this.contentW), y: clamp(view.y, 0, this.contentH) };
    const zoom = clamp(TUNING.grid.detailCellPx / Math.max(this.sourceCell(), 1e-6), TUNING.grid.detailMinZoom, TUNING.grid.detailMaxZoom);
    const box: Rect = { x: 0, y: 0, w, h };
    this.drawMagnified(ctx, box, { zoom, panX: w / 2 - center.x * zoom, panY: h / 2 - center.y * zoom }, dpr);
    drawCross(ctx, w / 2, h / 2);
  }

  /** The image and the grid inside `box`, at the zoom and pan of `map`: the loupe and the zoomed detail share it. */
  private drawMagnified(target: CanvasRenderingContext2D, box: Rect, map: ViewMap, dpr: number): void {
    target.save();
    target.beginPath();
    target.rect(box.x, box.y, box.w, box.h);
    target.clip();
    target.fillStyle = checkerPattern(target);
    target.fillRect(box.x, box.y, box.w, box.h);
    target.imageSmoothingEnabled = map.zoom < 1;
    target.drawImage(this.bitmap, map.panX, map.panY, this.contentW * map.zoom, this.contentH * map.zoom);
    target.imageSmoothingEnabled = false;
    const grid = this.grid;
    if (grid) {
      strokeGrid(target, gridPath(grid.x, grid.y, map, box, dpr), dpr, STAGE_COLORS.gridFit, true, 1, STAGE_COLORS.gridFitHalo);
      const movedX = this.shifted?.movedX ?? this.movedX;
      const movedY = this.shifted?.movedY ?? this.movedY;
      if (!this.preview && (movedX.length > 0 || movedY.length > 0)) {
        strokeGrid(target, gridPath(movedX, movedY, map, box, dpr), dpr, STAGE_COLORS.teal, false);
      }
      if (!this.dragBox) drawMarkedCell(target, this.markedCell(), map);
    }
    target.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, clip: Rect, rect: Rect, now: number): boolean {
    const host = this.host;
    const fit = this.fit;
    const grid = this.grid;
    if (!host || !fit || !grid) return false;
    const { dpr } = host;
    const scan = progress(now, this.scanStart, TUNING.grid.scanMs);
    const flash = 1 - progress(now, this.flashStart, TUNING.grid.flashMs);
    const cell = this.cellScreenSize();
    const visible = cell >= TUNING.grid.minCellPx || this.pressing;

    if (visible) {
      const path = gridPath(grid.x, grid.y, host.camera, clip, dpr);
      ctx.save();
      if (scan < 1) {
        const scanY = rect.y + rect.h * scan;
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, Math.max(0, scanY - clip.y));
        ctx.clip();
      }
      // A dense grid keeps the image readable with thinner, fainter lines.
      if (cell < TUNING.grid.minCellPx) ctx.globalAlpha = clamp(cell / TUNING.grid.minCellPx, TUNING.grid.denseAlphaMin, 1);
      strokeGrid(ctx, path, dpr, STAGE_COLORS.gridFit, cell >= TUNING.grid.fitHaloMinCellPx, 1, STAGE_COLORS.gridFitHalo);
      ctx.globalAlpha = 1;
      // Lines that the flexible grid moved off the regular spacing, only where cells are large enough to tell.
      const movedX = this.shifted?.movedX ?? this.movedX;
      const movedY = this.shifted?.movedY ?? this.movedY;
      if (!this.preview && cell >= TUNING.grid.minCellPx && (movedX.length > 0 || movedY.length > 0)) {
        strokeGrid(ctx, gridPath(movedX, movedY, host.camera, clip, dpr), dpr, STAGE_COLORS.teal, false);
      }
      this.drawLineMarks(ctx, grid, clip, dpr);
      if (!this.settle && !this.dragBox) drawMarkedCell(ctx, this.markedCell(), host.camera);
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

  /** The hovered, selected or dragged line of the "Ajustar linhas" mode, drawn over the grid. */
  private drawLineMarks(ctx: CanvasRenderingContext2D, grid: CellGrid, clip: Rect, dpr: number): void {
    const host = this.host;
    if (!host) return;
    const { hover, selected, dragging } = this.lineMarks;
    const mark = (line: GridLine | null, color: string, width: number) => {
      if (!line) return;
      const value = grid[line.axis][line.index];
      if (value === undefined) return;
      const xs = line.axis === 'x' ? Float64Array.of(value) : new Float64Array(0);
      const ys = line.axis === 'y' ? Float64Array.of(value) : new Float64Array(0);
      strokeGrid(ctx, gridPath(xs, ys, host.camera, clip, dpr), dpr, color, true, width);
    };
    if (hover && (hover.axis !== selected?.axis || hover.index !== selected?.index)) mark(hover, STAGE_COLORS.white, 2);
    mark(selected, STAGE_COLORS.accent, dragging ? 3 : 2);
  }

  /** The magnifier: at the cursor while a box is dragged, or fixed at the view center while the slider is pressed. */
  private drawLoupe(fx: CanvasRenderingContext2D, at: Point, centered: boolean): void {
    const host = this.host;
    if (!host) return;
    const { camera, dpr } = host;
    const { size, offset, magnify, maxZoom } = TUNING.loupe;
    let x = centered ? at.x - size / 2 : at.x + offset;
    let y = centered ? at.y - size / 2 : at.y - offset - size;
    if (!centered && x + size > camera.viewW - 8) x = at.x - offset - size;
    if (!centered && y < 8) y = at.y + offset;
    x = clamp(x, 8, Math.max(8, camera.viewW - size - 8));
    y = clamp(y, 8, Math.max(8, camera.viewH - size - 8));
    const box: Rect = { x, y, w: size, h: size };

    const cell = this.cellScreenSize() / Math.max(camera.zoom, 1e-6);
    const zoom = centered
      ? clamp(TUNING.grid.loupeCellPx / Math.max(cell, 1e-6), camera.zoom * 1.5, maxZoom)
      : Math.max(camera.zoom * 1.5, Math.min(camera.zoom * magnify, maxZoom));
    const center = camera.screenToImage(at.x, at.y);
    const map: ViewMap = { zoom, panX: x + size / 2 - center.x * zoom, panY: y + size / 2 - center.y * zoom };

    fx.fillStyle = STAGE_COLORS.shadow;
    fx.fillRect(x + 6, y + 6, size, size);
    this.drawMagnified(fx, box, map, dpr);
    fx.save();
    fx.beginPath();
    fx.rect(x, y, size, size);
    fx.clip();
    if (this.dragBox) {
      const b = this.dragBox;
      fx.strokeStyle = STAGE_COLORS.accent;
      fx.lineWidth = 2;
      fx.strokeRect(map.panX + b.x * zoom, map.panY + b.y * zoom, b.w * zoom, b.h * zoom);
    }
    drawCross(fx, x + size / 2, y + size / 2);
    fx.restore();
    fx.strokeStyle = STAGE_COLORS.accent;
    fx.lineWidth = 3;
    fx.strokeRect(x - 1.5, y - 1.5, size + 3, size + 3);
  }
}

/** The outline of the marked cell: an accent line over a dark one, so it shows on any art. */
function drawMarkedCell(ctx: CanvasRenderingContext2D, cell: Selection | null, map: ViewMap): void {
  if (!cell) return;
  const x = map.panX + cell.x * map.zoom;
  const y = map.panY + cell.y * map.zoom;
  const w = cell.w * map.zoom;
  const h = cell.h * map.zoom;
  ctx.save();
  ctx.strokeStyle = STAGE_COLORS.shadow;
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = STAGE_COLORS.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/** A small white cross with a dark outline, so it shows on any art. */
function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.fillStyle = STAGE_COLORS.shadow;
  ctx.fillRect(cx - 6, cy - 1.5, 12, 3);
  ctx.fillRect(cx - 1.5, cy - 6, 3, 12);
  ctx.fillStyle = STAGE_COLORS.white;
  ctx.fillRect(cx - 5, cy - 0.5, 10, 1);
  ctx.fillRect(cx - 0.5, cy - 5, 1, 10);
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
