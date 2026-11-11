import type { CellGrid, ElasticMode, GridFit, Selection, Sprite } from '../core/types.ts';
import { TRANSPARENT } from '../core/color.ts';
import { CoreError } from '../core/errors.ts';
import { mapToPalette, unifyPalettes } from '../core/palette.ts';
import { borderBackground, heightLimit, heightStep, listPalette, resampledSize, resampleSprite, trimSprite, wholeHeights } from '../core/sprite.ts';
import { clamp } from '../ui/camera.ts';
import { EditSession } from './edit-session.ts';
import { formatDecimal } from './i18n.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';

const ERASE_KEY = 'setEraseBg';
const EPS = 1e-9;

/** The grid inputs of one object, so "Editar" can fit the object again exactly as before. */
export interface FitInputs {
  selection: Selection | null;
  fixedPeriod: { x: number; y: number } | null;
  /** Grid lines placed by hand, applied after the fit. */
  grid: CellGrid | null;
  nudge: { x: number; y: number };
  elastic: ElasticMode;
}

export const DEFAULT_FIT_INPUTS: FitInputs = { selection: null, fixedPeriod: null, grid: null, nudge: { x: 0, y: 0 }, elastic: 'auto' };

export type SetGridMode = 'own' | 'shared';

/**
 * The grid of the set. `own`: each piece has its own automatic grid. `shared`: one pixel size for all pieces,
 * detected from all of them (`typed` false) or typed by the user (`typed` true).
 */
export interface SetGridState {
  mode: SetGridMode;
  period: { x: number; y: number } | null;
  typed: boolean;
}

/**
 * The size of one object on the common grid. A whole size keeps its step (the same 1/k or kx) when the
 * trimmed height changes; a free size keeps its height.
 */
export type SetSize = { kind: 'whole'; step: number } | { kind: 'free'; height: number };

export interface SetObject {
  readonly id: number;
  /** File name without the extension. */
  readonly name: string;
  /** The file bytes, kept to load the object again. Never transferred. */
  readonly bytes: ArrayBuffer;
  /** A final asset shown only to compare: its own tiles, never changed, never exported. */
  reference: boolean;
  fit: GridFit;
  inputs: FitInputs;
  /** The tiles before the palette merge. */
  raw: Sprite;
  /** The own merge of `raw` at `ownStrength`; the base of `session`. */
  own: Sprite;
  ownStrength: number;
  readonly session: EditSession;
  size: SetSize;
  /** After the shared palette, the background erase and the trim. Null when no opaque tile is left. */
  prepared: Sprite | null;
  /** The tiles of `fit` that `prepared` holds, so "Ver original" shows the matching part of the source image. */
  trim: TileBox | null;
  height: number;
  step: number;
  /** The sprite that the export writes. */
  output: Sprite | null;
  /** The output does not match `step` yet: a drag of a large object calculates it on release. */
  stale: boolean;
  /**
   * The background erase is on, and after it the piece still looks like a full picture: its border is mostly
   * opaque, or the erase removed part of the border and opaque tiles still touch all four edges. The height of
   * such a piece is not the height of the drawing.
   */
  backgroundKept: boolean;
}

/** A box of tiles on the grid of a fit. */
export interface TileBox {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface SetObjectInit {
  name: string;
  reference: boolean;
  inputs: FitInputs;
  bytes: ArrayBuffer;
  fit: GridFit;
  raw: Sprite;
  own: Sprite;
  ownStrength: number;
}

export interface Dims {
  cols: number;
  rows: number;
}

export interface SetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The spacing of the scene. A drag keeps it, so the ground line and the content size stay still. */
export interface SetSpacing {
  gap: number;
  groundY: number;
  bottom: number;
}

export interface SetLayout extends SetSpacing {
  contentW: number;
  contentH: number;
  /** One box per object, in pixels of the common grid; an empty object gets a placeholder box. */
  boxes: SetBox[];
}

export interface SetExportFile {
  object: SetObject;
  name: string;
  sprite: Sprite;
}

function maxHeight(dims: ReadonlyArray<Dims | null>): number {
  let max = 0;
  for (const dim of dims) if (dim && dim.rows > max) max = dim.rows;
  return max;
}

export function setSpacing(dims: ReadonlyArray<Dims | null>): SetSpacing {
  const tallest = Math.max(1, maxHeight(dims));
  const gap = clamp(Math.round(tallest * 0.25), 2, 96);
  const top = Math.max(gap, Math.round(tallest * 0.2));
  return { gap, groundY: top + tallest, bottom: Math.max(gap, Math.round(tallest * 0.45)) };
}

/** Objects side by side on one ground line, left to right in list order. */
export function layoutSet(dims: ReadonlyArray<Dims | null>, spacing: SetSpacing = setSpacing(dims)): SetLayout {
  const tallest = maxHeight(dims);
  const placeholder = Math.max(4, Math.round((tallest || 16) * 0.4));
  const boxes: SetBox[] = [];
  let x = spacing.gap;
  for (const dim of dims) {
    const w = dim ? dim.cols : placeholder;
    const h = dim ? dim.rows : placeholder;
    boxes.push({ x, y: spacing.groundY - h, w, h });
    x += w + spacing.gap;
  }
  return { ...spacing, contentW: Math.max(x, spacing.gap * 2), contentH: spacing.groundY + spacing.bottom, boxes };
}

/** The heights that the handle snaps to: native, the 1/k reductions and the enlargements up to the snap limit. */
export function snapHeights(rows: number, limit: number): number[] {
  return wholeHeights(rows, limit)
    .filter((entry) => entry.step >= 1 / TUNING.set.snapEnlargeMax - EPS)
    .map((entry) => entry.height);
}

export function heightOf(size: SetSize, rows: number, limit: number): number {
  if (size.kind === 'free') return clamp(Math.round(size.height), 1, limit);
  const height = size.step >= 1 ? Math.ceil(rows / size.step - EPS) : Math.round(rows / size.step);
  return clamp(height, 1, limit);
}

/** A height that a whole-number size gives becomes that whole size, so it stays snapped later. */
export function sizeForHeight(height: number, rows: number, limit: number): SetSize {
  const target = clamp(Math.round(height), 1, limit);
  const whole = wholeHeights(rows, limit).find((entry) => entry.height === target);
  return whole ? { kind: 'whole', step: whole.step } : { kind: 'free', height: target };
}

/** "1x", "1/2", "3x", or the decimal factor of a free size. */
export function ratioLabel(step: number, rows: number, height: number): string {
  if (Math.abs(step - 1) < EPS) return '1x';
  if (Number.isInteger(step)) return `1/${step}`;
  const up = 1 / step;
  if (Math.abs(up - Math.round(up)) < EPS) return `${Math.round(up)}x`;
  return `${formatDecimal(height / rows)}x`;
}

export function isWholeStep(step: number): boolean {
  return Number.isInteger(step) || Math.abs(1 / step - Math.round(1 / step)) < EPS;
}

/** Unique PNG names; the second equal name gets "-2". Windows file names ignore case. */
export function uniqueFileNames(bases: readonly string[]): string[] {
  const taken = new Set<string>();
  return bases.map((base) => {
    let name = `${base}.png`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}-${k}.png`;
    taken.add(name.toLowerCase());
    return name;
  });
}

function eraseTiles(sprite: Sprite, indices: Int32Array): Sprite {
  const pixels = sprite.pixels.slice();
  for (let i = 0; i < indices.length; i++) pixels[indices[i]] = TRANSPARENT;
  return { cols: sprite.cols, rows: sprite.rows, pixels };
}

/**
 * A sprite that still holds a scenery: less than half of its border tiles are transparent (the rule that makes
 * borderBackground find nothing), or, after an erase that removed part of the border, opaque tiles still touch
 * all four edges. A clean sprite cropped to its drawing touches its edges too, so the second test needs the erase.
 */
function holdsScenery(sprite: Sprite, erased: boolean): boolean {
  const { cols, rows, pixels } = sprite;
  let border = 0;
  let clear = 0;
  let top = false;
  let bottom = false;
  let left = false;
  let right = false;
  for (let y = 0; y < rows; y++) {
    const edgeRow = y === 0 || y === rows - 1;
    for (let x = 0; x < cols; x++) {
      if (!edgeRow && x !== 0 && x !== cols - 1) continue;
      border++;
      if (pixels[y * cols + x] === TRANSPARENT) {
        clear++;
        continue;
      }
      if (y === 0) top = true;
      if (y === rows - 1) bottom = true;
      if (x === 0) left = true;
      if (x === cols - 1) right = true;
    }
  }
  if (border === 0) return false;
  return clear * 2 < border || (erased && top && bottom && left && right);
}

/** The box of the opaque tiles, the box that trimSprite keeps; null when no tile is opaque. */
export function opaqueBox(sprite: Sprite): TileBox | null {
  const { cols, rows, pixels } = sprite;
  let left = cols;
  let right = -1;
  let top = rows;
  let bottom = -1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (pixels[y * cols + x] === TRANSPARENT) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  return right < 0 ? null : { col: left, row: top, cols: right - left + 1, rows: bottom - top + 1 };
}

/** The sprite cropped to its opaque tiles, as every export writes it; null when no tile is opaque. */
export function trimOrNull(sprite: Sprite): Sprite | null {
  try {
    return trimSprite(sprite);
  } catch (error) {
    if (error instanceof CoreError && error.code === 'empty-image') return null;
    throw error;
  }
}

/** The colors of several sprites by total count, so the nearest-color map always prefers the same color. */
function paletteOfSprites(sprites: readonly Sprite[]): Uint32Array {
  const counts = new Map<number, number>();
  for (const sprite of sprites) for (const { color, count } of listPalette(sprite.pixels)) counts.set(color, (counts.get(color) ?? 0) + count);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return Uint32Array.from(entries, (entry) => entry[0]);
}

/** The pixel size of a fit, rounded to 2 decimals as the UI shows it. */
export function pixelSizeOf(fit: GridFit): { x: number; y: number } {
  return { x: Math.round(fit.axes.x.period * 100) / 100, y: Math.round(fit.axes.y.period * 100) / 100 };
}

function tiles(dims: Dims): number {
  return dims.cols * dims.rows;
}

/**
 * The objects of the set mode and the set stage: the shared palette, the background erase, the trim and the
 * resize of each object on the common grid. The engine work (load, raw tiles, own merge) stays in `app`.
 */
export class ImageSet {
  objects = $state.raw<SetObject[]>([]);
  selectedId = $state<number | null>(null);
  eraseBackground = $state(readStored(ERASE_KEY) !== 'off');
  /** Changes when an object, an output or the layout changes. */
  version = $state(0);
  /** Changes on every live resize step of a drag, before the drag commits. */
  liveVersion = $state(0);
  exportedVersion = $state(0);
  layout = $state.raw<SetLayout>(layoutSet([]));
  grid = $state.raw<SetGridState>({ mode: 'own', period: null, typed: false });
  /** The joint pixel size of the last detection, for "Detectar". */
  detected = $state.raw<{ x: number; y: number } | null>(null);
  /** Maps every normal piece to the colors of the references. */
  referenceColors = $state(false);
  private nextId = 1;

  get active(): boolean {
    return this.objects.length > 0;
  }

  get pieces(): SetObject[] {
    return this.objects.filter((object) => !object.reference);
  }

  get hasReferences(): boolean {
    return this.objects.some((object) => object.reference);
  }

  get selected(): SetObject | null {
    return this.objects.find((object) => object.id === this.selectedId) ?? null;
  }

  /** Changes after the set was made or last exported. */
  get unexported(): boolean {
    return this.active && this.version !== this.exportedVersion;
  }

  find(id: number): SetObject | null {
    return this.objects.find((object) => object.id === id) ?? null;
  }

  limitOf(object: SetObject): number {
    return object.prepared ? heightLimit(object.prepared.cols, object.prepared.rows) : 1;
  }

  add(inits: readonly SetObjectInit[]): SetObject[] {
    const added = inits.map((init): SetObject => {
      const session = new EditSession();
      session.setBase(init.own);
      return {
        id: this.nextId++,
        name: init.name,
        bytes: init.bytes,
        reference: init.reference,
        fit: init.fit,
        inputs: init.inputs,
        raw: init.raw,
        own: init.own,
        ownStrength: init.ownStrength,
        session,
        size: { kind: 'whole', step: 1 },
        prepared: null,
        trim: null,
        height: 0,
        step: 1,
        output: null,
        stale: false,
        backgroundKept: false,
      };
    });
    if (added.length === 0) return added;
    this.objects = [...this.objects, ...added];
    this.selectedId = added[0].id;
    this.version++;
    return added;
  }

  remove(id: number): void {
    const index = this.objects.findIndex((object) => object.id === id);
    if (index < 0) return;
    const next = this.objects.filter((object) => object.id !== id);
    this.objects = next;
    if (this.selectedId === id) this.selectedId = next[Math.min(index, next.length - 1)]?.id ?? null;
    this.version++;
  }

  clear(): void {
    this.objects = [];
    this.selectedId = null;
    this.layout = layoutSet([]);
    this.grid = { mode: 'own', period: null, typed: false };
    this.detected = null;
    this.referenceColors = false;
    this.version++;
    this.exportedVersion = this.version;
  }

  select(id: number | null): void {
    this.selectedId = id;
  }

  markExported(): void {
    this.exportedVersion = this.version;
  }

  setEraseBackground(on: boolean): void {
    this.eraseBackground = on;
    writeStored(ERASE_KEY, on ? 'on' : 'off');
  }

  /** Bumps the version after a change that `rebuild` does not make, such as a new grid mode. */
  touch(): void {
    this.version++;
  }

  /**
   * The set stage. Normal pieces: shared palette of the composed sprites, the optional map to the reference
   * colors, background erase, trim, resize. References: their own tiles, as they are.
   */
  rebuild(strength: number): void {
    const live = this.objects.filter((object) => !object.reference && object.session.hasBase);
    const unified = live.length > 0 ? unifyPalettes(live.map((object) => object.session.composed()), { strength }) : [];
    const references = this.objects.filter((object) => object.reference);
    const referencePalette = this.referenceColors ? paletteOfSprites(references.map((object) => object.raw)) : null;
    for (const object of references) {
      object.prepared = object.raw;
      object.trim = { col: 0, row: 0, cols: object.raw.cols, rows: object.raw.rows };
      object.output = object.raw;
      object.size = { kind: 'whole', step: 1 };
      object.height = object.raw.rows;
      object.step = 1;
      object.stale = false;
      object.backgroundKept = false;
    }
    live.forEach((object, i) => {
      let sprite = unified[i];
      if (referencePalette && referencePalette.length > 0) sprite = mapToPalette(sprite, referencePalette);
      object.backgroundKept = false;
      if (this.eraseBackground) {
        const background = borderBackground(sprite);
        if (background.length > 0) sprite = eraseTiles(sprite, background);
        object.backgroundKept = holdsScenery(sprite, background.length > 0);
      }
      object.prepared = trimOrNull(sprite);
      object.trim = object.prepared ? opaqueBox(sprite) : null;
      this.applySize(object);
    });
    this.relayout();
    this.version++;
  }

  /** A size from the panel or the keyboard: calculated at once. */
  setSize(id: number, size: SetSize): void {
    const object = this.find(id);
    if (!object?.prepared || object.reference) return;
    object.size = size;
    this.applySize(object);
    this.relayout();
    this.version++;
  }

  setHeight(id: number, height: number): void {
    const object = this.find(id);
    if (!object?.prepared || object.reference) return;
    this.setSize(id, sizeForHeight(height, object.prepared.rows, this.limitOf(object)));
  }

  /**
   * One step of a drag. Small objects get their exact result at once; a large one keeps its last result
   * (the scene stretches it) until `commit`. Returns false when the height did not change.
   */
  resizeLive(id: number, height: number): boolean {
    const object = this.find(id);
    const prepared = object?.prepared;
    if (!object || !prepared || object.reference) return false;
    const limit = this.limitOf(object);
    const size = sizeForHeight(height, prepared.rows, limit);
    const next = heightOf(size, prepared.rows, limit);
    object.size = size;
    if (next === object.height) return false;
    object.height = next;
    object.step = heightStep(prepared.rows, next);
    const result = resampledSize(prepared.cols, prepared.rows, object.step);
    if (tiles(prepared) > TUNING.set.liveResizeTiles || tiles(result) > TUNING.set.liveResizeTiles) {
      object.stale = true;
    } else {
      object.output = resampleSprite(prepared, object.step);
      object.stale = false;
    }
    this.liveVersion++;
    return true;
  }

  /** The end of a drag: calculates what a large object still needs and lays the scene out again. */
  commit(): void {
    for (const object of this.objects) if (object.stale) this.applySize(object);
    this.relayout();
    this.version++;
  }

  /** The result size of each object at its current step, also during a drag. */
  dims(): Array<Dims | null> {
    return this.objects.map((object) => (object.prepared ? resampledSize(object.prepared.cols, object.prepared.rows, object.step) : null));
  }

  /** The shared palette of what the export writes, by count. */
  palette(): Uint32Array {
    const counts = new Map<number, number>();
    for (const object of this.objects) {
      if (!object.output || object.reference) continue;
      for (const { color, count } of listPalette(object.output.pixels)) counts.set(color, (counts.get(color) ?? 0) + count);
    }
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return Uint32Array.from(entries, (entry) => entry[0]);
  }

  /** One PNG per object that has opaque tiles, with unique names. */
  exportFiles(): SetExportFile[] {
    const ready = this.objects.filter((object): object is SetObject & { output: Sprite } => object.output !== null && !object.reference);
    const names = uniqueFileNames(ready.map((object) => `${object.name}-pixel-${object.output.cols}x${object.output.rows}`));
    return ready.map((object, i) => ({ object, name: names[i], sprite: object.output }));
  }

  private applySize(object: SetObject): void {
    if (object.reference) return;
    const prepared = object.prepared;
    object.stale = false;
    if (!prepared) {
      object.output = null;
      object.height = 0;
      object.step = 1;
      return;
    }
    object.height = heightOf(object.size, prepared.rows, this.limitOf(object));
    object.step = heightStep(prepared.rows, object.height);
    object.output = resampleSprite(prepared, object.step);
  }

  private relayout(): void {
    this.layout = layoutSet(this.dims());
  }
}
