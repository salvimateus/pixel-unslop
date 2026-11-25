import type { TileBox } from '../core/sprite.ts';
import type { Selection } from '../core/types.ts';
import { STAGE_COLORS, type Rect } from './stage-renderer.ts';

/** A resizable box on the stage: its 8 handles, their hit test, the drag math and the shared drawing. */

export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type BoxPart = BoxHandle | 'inside';

export const HANDLES: ReadonlyArray<{ id: BoxHandle; fx: number; fy: number }> = [
  { id: 'nw', fx: 0, fy: 0 },
  { id: 'n', fx: 0.5, fy: 0 },
  { id: 'ne', fx: 1, fy: 0 },
  { id: 'e', fx: 1, fy: 0.5 },
  { id: 'se', fx: 1, fy: 1 },
  { id: 's', fx: 0.5, fy: 1 },
  { id: 'sw', fx: 0, fy: 1 },
  { id: 'w', fx: 0, fy: 0.5 },
];

export const RESIZE_CURSORS: Record<BoxHandle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export function cursorOf(part: BoxPart | null): string {
  return part === null ? 'default' : part === 'inside' ? 'move' : RESIZE_CURSORS[part];
}

export function sameTileBox(a: TileBox, b: TileBox): boolean {
  return a.col === b.col && a.row === b.row && a.cols === b.cols && a.rows === b.rows;
}

/** The part of a screen box under a screen point: the nearest handle within `reach` (null reach: no handles), the inside, or null. */
export function hitBox(rect: Rect, sx: number, sy: number, reach: number | null): BoxPart | null {
  if (reach !== null) {
    let best: BoxHandle | null = null;
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

/** The edges after a move (inside) or a resize by a handle; every side keeps at least `min`. */
function dragEdges(left: number, top: number, right: number, bottom: number, part: BoxPart, dx: number, dy: number, min: number) {
  if (part === 'inside') return { left: left + dx, top: top + dy, right: right + dx, bottom: bottom + dy };
  if (part.includes('w')) left = Math.min(right - min, left + dx);
  if (part.includes('e')) right = Math.max(left + min, right + dx);
  if (part.includes('n')) top = Math.min(bottom - min, top + dy);
  if (part.includes('s')) bottom = Math.max(top + min, bottom + dy);
  return { left, top, right, bottom };
}

/** A tile box after a move or a resize by whole tiles; every side keeps at least 1 tile. */
export function draggedTileBox(start: TileBox, part: BoxPart, dx: number, dy: number): TileBox {
  const e = dragEdges(start.col, start.row, start.col + start.cols, start.row + start.rows, part, dx, dy, 1);
  return { col: e.left, row: e.top, cols: e.right - e.left, rows: e.bottom - e.top };
}

/** A source-pixel box after a move or a resize; every side keeps at least `min`. */
export function draggedSelection(start: Selection, part: BoxPart, dx: number, dy: number, min: number): Selection {
  const e = dragEdges(start.x, start.y, start.x + start.w, start.y + start.h, part, dx, dy, min);
  return { x: e.left, y: e.top, w: e.right - e.left, h: e.bottom - e.top };
}

export interface BoxEdges { x: number; y: number; right: number; bottom: number }

/** The sides of a screen box on whole device pixels; `out` is reused when given. */
export function crispEdges(rect: Rect, dpr: number, out: BoxEdges = { x: 0, y: 0, right: 0, bottom: 0 }): BoxEdges {
  out.x = Math.round(rect.x * dpr) / dpr;
  out.y = Math.round(rect.y * dpr) / dpr;
  out.right = Math.round((rect.x + rect.w) * dpr) / dpr;
  out.bottom = Math.round((rect.y + rect.h) * dpr) / dpr;
  return out;
}

/** Dims the view outside a box, as 4 bands. */
export function dimOutside(ctx: CanvasRenderingContext2D, view: Rect, edges: BoxEdges, alpha: number): void {
  if (alpha <= 0) return;
  const { x, y, right, bottom } = edges;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = STAGE_COLORS.previewDark;
  const top = Math.max(view.y, Math.min(view.h, y));
  const low = Math.min(view.h, Math.max(view.y, bottom));
  ctx.fillRect(0, 0, view.w, top);
  ctx.fillRect(0, low, view.w, view.h - low);
  ctx.fillRect(0, top, Math.max(0, Math.min(view.w, x)), low - top);
  const from = Math.max(0, Math.min(view.w, right));
  ctx.fillRect(from, top, view.w - from, low - top);
  ctx.globalAlpha = 1;
}

export const BOX_DASH = [6, 4];

/** The outline of a box: an accent line (white when dashed) over a dark one, plus an optional flash on top. */
export function strokeBox(ctx: CanvasRenderingContext2D, edges: BoxEdges, dashed: boolean, flash: number): void {
  const x = edges.x - 1;
  const y = edges.y - 1;
  const w = edges.right - edges.x + 2;
  const h = edges.bottom - edges.y + 2;
  ctx.lineWidth = 4;
  ctx.strokeStyle = STAGE_COLORS.shadow;
  if (dashed) ctx.setLineDash(BOX_DASH);
  ctx.strokeRect(x, y, w, h);
  ctx.lineWidth = 2;
  ctx.strokeStyle = dashed ? STAGE_COLORS.white : STAGE_COLORS.accent;
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  if (flash > 0) {
    ctx.globalAlpha = flash;
    ctx.strokeStyle = STAGE_COLORS.gridFlash;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }
}

/** A square handle with a drop shadow, of side `size`, centered on x, y. */
export function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, active: boolean, hot: boolean): void {
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

/** The 8 handles of a screen box, of side `size`; the active and the hovered handle grow by `grow`. */
export function drawHandles(ctx: CanvasRenderingContext2D, rect: Rect, size: number, grow: number, active: BoxPart | null, hover: BoxPart | null): void {
  for (const handle of HANDLES) {
    const isActive = active === handle.id;
    const isHot = hover === handle.id;
    drawHandle(ctx, rect.x + rect.w * handle.fx, rect.y + rect.h * handle.fy, size + (isActive || isHot ? grow : 0), isActive, isHot);
  }
}

const LABEL_FONT = '600 12px system-ui, sans-serif';
const LABEL_GAP = 6;
const LABEL_H = 20;

/**
 * A short text in a small pill above a screen box, or inside its top edge when the top inset would cover it.
 * `lift` keeps it clear of the handles; `scale` grows the pill about its center, for a pop.
 */
export function drawBoxLabel(ctx: CanvasRenderingContext2D, rect: Rect, text: string, topInset: number, lift: number, accent: boolean, scale = 1): void {
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const width = Math.ceil(ctx.measureText(text).width) + 12;
  const cx = Math.round(rect.x + rect.w / 2);
  const above = rect.y - LABEL_GAP - LABEL_H - lift;
  const y = Math.round(above >= topInset ? above : Math.max(topInset, rect.y) + LABEL_GAP + lift);
  const left = cx - Math.round(width / 2);
  const scaled = scale !== 1;
  if (scaled) {
    ctx.save();
    ctx.translate(cx, y + LABEL_H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -(y + LABEL_H / 2));
  }
  ctx.fillStyle = STAGE_COLORS.shadow;
  ctx.fillRect(left + 2, y + 2, width, LABEL_H);
  ctx.fillStyle = STAGE_COLORS.panel;
  ctx.fillRect(left, y, width, LABEL_H);
  ctx.strokeStyle = accent ? STAGE_COLORS.accent : STAGE_COLORS.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, y + 0.5, width - 1, LABEL_H - 1);
  ctx.fillStyle = STAGE_COLORS.white;
  ctx.fillText(text, cx, y + LABEL_H / 2 + 0.5);
  if (scaled) ctx.restore();
}
