import type { CellGrid } from '../core/types.ts';
import { PARAMS } from '../core/params.ts';
import { quantile } from '../core/edge-profile.ts';
import type { Axis } from './grid-scene.ts';

/** Grid line edits of the "Ajustar linhas" mode. Each edit returns a new grid and leaves the input as it is. */

/** The image and the regular period that an edit fills free space with, per axis. */
export interface GridFrame {
  width: number;
  height: number;
  period: { x: number; y: number };
}

function lengthOf(frame: GridFrame, axis: Axis): number {
  return axis === 'x' ? frame.width : frame.height;
}

function withAxis(grid: CellGrid, axis: Axis, bounds: Float64Array): CellGrid {
  return axis === 'x' ? { x: bounds, y: grid.y.slice() } : { x: grid.x.slice(), y: bounds };
}

/**
 * Makes the lines of one axis a grid that the core accepts: cells whose center left the image go away, and a
 * free strip at either end as wide as the cell next to it gets new cells of about `period`. The core rejects a
 * grid that breaks these rules and keeps its earlier fit, so every edit must end here.
 */
export function coverAxis(lines: readonly number[], length: number, period: number): Float64Array {
  const gap = PARAMS.manualGrid.minSpacing;
  const step = Math.max(gap, period);
  const bounds = lines.slice();
  while (bounds.length > 2 && (bounds[0] + bounds[1]) / 2 < 0) bounds.shift();
  while (bounds.length > 2 && (bounds[bounds.length - 2] + bounds[bounds.length - 1]) / 2 >= length) bounds.pop();
  // A new cell is narrower than twice the strip, so its center stays inside the image.
  while (bounds[0] > 0 && bounds[0] >= bounds[1] - bounds[0]) bounds.unshift(bounds[0] - Math.min(step, bounds[0] * 1.98));
  for (let end = length - bounds[bounds.length - 1]; end > 0 && end >= bounds[bounds.length - 1] - bounds[bounds.length - 2]; end = length - bounds[bounds.length - 1]) {
    bounds.push(bounds[bounds.length - 1] + Math.min(step, end * 1.98));
  }
  return Float64Array.from(bounds);
}

/** The place where a line can go: between its neighbors with the smallest spacing, and an outer line keeps its cell center inside the image. */
export function lineRange(grid: CellGrid, axis: Axis, index: number, length: number): { min: number; max: number } {
  const bounds = grid[axis];
  const gap = PARAMS.manualGrid.minSpacing;
  const last = bounds.length - 1;
  return {
    min: index > 0 ? bounds[index - 1] + gap : -bounds[1],
    max: index < last ? bounds[index + 1] - gap : 2 * length - bounds[last - 1] - gap,
  };
}

/** Moves one line only. */
export function moveLine(grid: CellGrid, axis: Axis, index: number, value: number, frame: GridFrame): CellGrid {
  const length = lengthOf(frame, axis);
  const { min, max } = lineRange(grid, axis, index, length);
  const bounds = Array.from(grid[axis]);
  bounds[index] = Math.min(max, Math.max(min, value));
  return withAxis(grid, axis, coverAxis(bounds, length, frame.period[axis]));
}

/**
 * Moves a line and every line after it by the same distance, so the later cells keep their sizes. A drag of the
 * first line moves the full grid. Lines that leave the image go away, and free space gets lines at the period.
 */
export function pushLines(grid: CellGrid, axis: Axis, index: number, value: number, frame: GridFrame): CellGrid {
  const bounds = grid[axis];
  const length = lengthOf(frame, axis);
  const gap = PARAMS.manualGrid.minSpacing;
  // The pushed line stays inside the image (the first line within half of it), so lines always stay on the image.
  const min = index > 0 ? bounds[index - 1] + gap : bounds[0] - length / 2;
  const max = index > 0 ? Math.max(min, length) : bounds[0] + length / 2;
  const delta = Math.min(max, Math.max(min, value)) - bounds[index];
  const next: number[] = Array.from(bounds.subarray(0, index));
  for (let j = index; j < bounds.length; j++) {
    const moved = bounds[j] + delta;
    next.push(moved);
    if (moved >= length) break;
  }
  return withAxis(grid, axis, coverAxis(next, length, frame.period[axis]));
}

/** Removes an inner line; the outer two lines of an axis stay, so the grid always covers the image. */
export function removeLine(grid: CellGrid, axis: Axis, index: number, frame: GridFrame): CellGrid | null {
  const bounds = grid[axis];
  if (index <= 0 || index >= bounds.length - 1) return null;
  const next = [...bounds.subarray(0, index), ...bounds.subarray(index + 1)];
  return withAxis(grid, axis, coverAxis(next, lengthOf(frame, axis), frame.period[axis]));
}

/** Adds a line at `value` when it keeps the smallest spacing to both neighbors. */
export function addLine(grid: CellGrid, axis: Axis, value: number, frame: GridFrame): CellGrid | null {
  const bounds = grid[axis];
  const gap = PARAMS.manualGrid.minSpacing;
  let at = 0;
  while (at < bounds.length && bounds[at] < value) at++;
  if (at === 0 || at === bounds.length) return null;
  if (value - bounds[at - 1] < gap || bounds[at] - value < gap) return null;
  const next = [...bounds.subarray(0, at), value, ...bounds.subarray(at)];
  return withAxis(grid, axis, coverAxis(next, lengthOf(frame, axis), frame.period[axis]));
}

/** The cell under a point: its size on each axis, or null outside the grid. */
export function cellAt(grid: CellGrid, x: number, y: number): { w: number; h: number } | null {
  const span = (bounds: Float64Array, value: number) => {
    for (let i = 0; i < bounds.length - 1; i++) if (value >= bounds[i] && value < bounds[i + 1]) return bounds[i + 1] - bounds[i];
    return null;
  };
  const w = span(grid.x, x);
  const h = span(grid.y, y);
  return w === null || h === null ? null : { w, h };
}

/** The edge strength above which a boundary of the drawing counts as strong, per axis. */
export function strongEdge(profile: Float64Array): number {
  return profile.length > 0 ? quantile(profile, 0.9) * 0.5 : Infinity;
}

/**
 * The strongest edge of the drawing within `radius` source pixels of `value`, or `value` when none is strong.
 * `profile[i]` is the edge between source pixel i and i + 1, at the position i + 1.
 */
export function snapToEdge(profile: Float64Array, threshold: number, value: number, radius: number): number {
  const from = Math.max(0, Math.ceil(value - radius) - 1);
  const to = Math.min(profile.length - 1, Math.floor(value + radius) - 1);
  let best = value;
  let bestStrength = threshold;
  let bestDistance = Infinity;
  for (let i = from; i <= to; i++) {
    const position = i + 1;
    const distance = Math.abs(position - value);
    if (distance > radius) continue;
    const strength = profile[i];
    if (strength > bestStrength || (strength === bestStrength && distance < bestDistance)) {
      best = position;
      bestStrength = strength;
      bestDistance = distance;
    }
  }
  return best;
}
