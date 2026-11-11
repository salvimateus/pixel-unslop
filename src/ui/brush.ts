/**
 * The square footprint of the pencil and the eraser. A brush of `size` covers size x size grid squares. The
 * square under the pointer is the center of an odd size; for an even size it is the upper-left square of the four
 * center squares, so a brush of 2 grows to the right and down from the pointer.
 */

/** The upper-left square of the footprint of a brush at `col`, `row`. */
export function brushOrigin(col: number, row: number, size: number): { col: number; row: number } {
  const back = Math.floor((size - 1) / 2);
  return { col: col - back, row: row - back };
}

/** The footprint clipped to the sprite, as a box of squares; null when no square of it is inside. */
export function brushBox(col: number, row: number, size: number, cols: number, rows: number): { col: number; row: number; w: number; h: number } | null {
  const origin = brushOrigin(col, row, size);
  const left = Math.max(0, origin.col);
  const top = Math.max(0, origin.row);
  const right = Math.min(cols, origin.col + size);
  const bottom = Math.min(rows, origin.row + size);
  return right > left && bottom > top ? { col: left, row: top, w: right - left, h: bottom - top } : null;
}

/**
 * The sprite indices of one stamp of the brush that are not in `seen` yet; they go into `seen`. A stroke keeps one
 * `seen` for all its stamps, so it never changes one square two times.
 */
export function stampIndices(col: number, row: number, size: number, cols: number, rows: number, seen: Uint8Array): number[] {
  const box = brushBox(col, row, size, cols, rows);
  if (!box) return [];
  const out: number[] = [];
  for (let y = box.row; y < box.row + box.h; y++) {
    const start = y * cols;
    for (let x = box.col; x < box.col + box.w; x++) {
      const index = start + x;
      if (seen[index]) continue;
      seen[index] = 1;
      out.push(index);
    }
  }
  return out;
}
