import type { Sprite } from '../core/types.ts';
import { TRANSPARENT } from '../core/color.ts';
import type { ReplacedColor } from '../core/palette.ts';
import { eraseTiles, holdsTile, removalAt, removedMatches, tilesNear, type ColorNear, type Removal, type RemovedColor, type RemoveScope } from '../core/sprite.ts';
import { track } from './analytics.ts';
import type { ListAction } from './undo-timeline.svelte.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';

export type { ReplacedColor, RemovedColor, RemoveScope };

/** Where a color list works: the frames of an animation, one image, or every piece of a set. */
export type ListVariant = 'frames' | 'image' | 'set';

const NO_TILES = new Int32Array(0);

/** A tolerance of "Remove color" or of the replacement map, inside the range of the slider. */
export function clampTolerance(value: number): number {
  return Number.isFinite(value) ? Math.min(TUNING.clean.removeToleranceMax, Math.max(0, value)) : TUNING.clean.removeTolerance;
}

function storedTolerance(key: string): number {
  const text = readStored(key);
  return text === null ? TUNING.clean.removeTolerance : clampTolerance(Number(text));
}

/**
 * What a "Remove color" click on one tile does: 'add' a new color, 'widen' a listed 'border' color to 'all', or
 * nothing for a color that is 'listed' already. `cleared` and `kept` leave out the tiles with a pixel edit.
 */
export interface RemovalPick {
  color: number;
  scope: RemoveScope;
  action: 'add' | 'widen' | 'listed';
  cleared: Int32Array;
  kept: Int32Array;
}

/**
 * The lists of one journey over one image. `base` takes the pixel edits; `stage` (before the removed colors) and
 * `prepared` (after them) are in the colors of the lists, for the picks; `extra` only opens the removal flood.
 */
export interface ListPreview {
  base: Sprite;
  stage: Sprite;
  prepared: Sprite;
  extra: RemovedColor[];
}

/** The tiles that hold no pixel edit: where `shown` (with the edits) shows `prepared` (without them). */
function unedited(tiles: Int32Array, shown: Sprite, prepared: Sprite): Int32Array {
  if (shown === prepared) return tiles;
  const out = new Int32Array(tiles.length);
  let n = 0;
  for (let i = 0; i < tiles.length; i++) if (shown.pixels[tiles[i]] === prepared.pixels[tiles[i]]) out[n++] = tiles[i];
  return n === tiles.length ? tiles : out.slice(0, n);
}

/**
 * A list of color picks of one journey, in the order of the picks, and the OKLab tolerance of the next pick. The list
 * lives in memory; only the tolerance is stored. The owner builds its stage from `entries` and sets `onchange`, which
 * runs after a change that the list makes by itself (a chip, "Clear"), so the owner builds again.
 */
abstract class ColorList<T> {
  entries = $state.raw<readonly T[]>([]);
  tolerance = $state(TUNING.clean.removeTolerance);
  onchange: (() => void) | null = null;
  /** Records each user change as one undo step: it must call `run`, which makes the change. */
  onstep: ((action: ListAction, run: () => void) => void) | null = null;

  private readonly storeKey: string;
  /** The analytics kind of the list. */
  protected readonly kind: string;

  constructor(storeKey: string, kind: string) {
    this.storeKey = storeKey;
    this.kind = kind;
    this.tolerance = storedTolerance(storeKey);
  }

  /** What the stage of the list is made from: equal keys give equal stages. */
  get key(): string {
    return this.entries.map((entry) => this.keyOf(entry)).join(',');
  }

  protected abstract keyOf(entry: T): string;

  /** The undo action of a change of this list, by its analytics detail. */
  protected abstract actionOf(detail: string): ListAction;

  /** The tolerance of the next picks; each entry keeps the tolerance of its own pick. `commit` (a drag release) stores it. */
  setTolerance(value: number, commit = true): void {
    this.tolerance = clampTolerance(value);
    if (!commit) return;
    writeStored(this.storeKey, String(this.tolerance));
    track('option_change', { kind: this.kind, detail: 'tolerance', count: this.entries.length });
  }

  /** Takes a list that the owner checked and built already, as one undo step. It does not call `onchange`. */
  commit(next: readonly T[], detail: string): void {
    const run = () => {
      this.entries = next;
    };
    if (this.onstep) this.onstep(this.actionOf(detail), run);
    else run();
    track('option_change', { kind: this.kind, detail, count: next.length });
  }

  /** Sets the entries of an undo or a redo: no step, no event, no `onchange`. */
  restoreEntries(entries: readonly T[]): void {
    this.entries = entries;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.change([], 'clear');
  }

  /** Forgets the list with no event: a new image, set or video. */
  reset(): void {
    this.entries = [];
  }

  protected change(next: readonly T[], detail: string): void {
    this.commit(next, detail);
    this.onchange?.();
  }
}

/** The colors that "Remove color" erases, each with its own tolerance and scope (see `removedMatches`). */
export class RemovedColorList extends ColorList<RemovedColor> {
  /** The last picks of one stage, color and tolerance: the hover asks again on each pointer move. */
  private pickCache: { key: string; border?: Removal; all?: Removal } | null = null;

  protected keyOf(entry: RemovedColor): string {
    return `${entry.color}@${entry.tolerance}@${entry.scope}`;
  }

  protected actionOf(detail: string): ListAction {
    return detail === 'restore' ? 'restore' : detail === 'clear' ? 'clearRemoved' : 'remove';
  }

  has(color: number): boolean {
    return this.entries.some((entry) => entry.color === color);
  }

  /**
   * The list with `color` at `tolerance` (the one of the next pick by default) and with `scope`. A listed 'border'
   * color and a new scope of 'all' widen to 'all' at its own tolerance. Null when nothing changes: TRANSPARENT, or a
   * listed color with that scope.
   */
  withColor(color: number, scope: RemoveScope, tolerance = this.tolerance): { next: RemovedColor[]; action: 'add' | 'widen' } | null {
    if (color === TRANSPARENT) return null;
    const listed = this.entries.find((entry) => entry.color === color);
    if (listed && (listed.scope === 'all' || scope === 'border')) return null;
    if (listed) return { next: this.entries.map((entry) => (entry === listed ? { ...entry, scope: 'all' as const } : entry)), action: 'widen' };
    return { next: [...this.entries, { color, tolerance, scope }], action: 'add' };
  }

  restore(color: number): void {
    if (!this.has(color)) return;
    this.change(
      this.entries.filter((entry) => entry.color !== color),
      'restore',
    );
  }

  /** `stage` with the tiles of `entries` (the list by default) erased; the same object when none goes. */
  static erase(stage: Sprite, entries: readonly RemovedColor[]): Sprite {
    const tiles = entries.length > 0 ? removedMatches(stage, entries) : NO_TILES;
    return tiles.length > 0 ? eraseTiles(stage, tiles) : stage;
  }

  /**
   * What a "Remove color" click on `tile` does, with the flood of the build. `stage` is the sprite before the removal,
   * `prepared` after it, and `shown` with the pixel edits; the color is the shown one, and an edited tile forces
   * 'border'. `extra` are entries that the build adds to the flood (the background erase). `stamp` names the stage,
   * for the cache. Null for a TRANSPARENT tile or a tile outside the sprite. Call it from an event handler.
   */
  pickAt(stage: Sprite, prepared: Sprite, shown: Sprite, tile: number, stamp: string, extra: () => RemovedColor[] = () => []): RemovalPick | null {
    if (!Number.isInteger(tile) || tile < 0 || tile >= stage.pixels.length || shown.pixels.length !== stage.pixels.length) return null;
    const color = shown.pixels[tile];
    if (color === TRANSPARENT) return null;
    const listed = this.entries.find((entry) => entry.color === color);
    if (listed?.scope === 'all') return { color, scope: 'all', action: 'listed', cleared: NO_TILES, kept: NO_TILES };
    const tolerance = listed?.tolerance ?? this.tolerance;
    const edited = shown !== prepared && shown.pixels[tile] !== prepared.pixels[tile];
    const key = `${stamp}|${this.key}|${color}|${tolerance}`;
    if (this.pickCache?.key !== key) this.pickCache = { key };
    const cache = this.pickCache;
    const known = cache.border ?? cache.all;
    const scope: RemoveScope | null = known ? (edited || holdsTile(known.reach, tile) ? 'border' : 'all') : null;
    let removal = scope ? cache[scope] : undefined;
    if (!removal) {
      const found = removalAt(stage, this.entries, color, tolerance, tile, { extra: extra(), forceBorder: edited });
      removal = { ...found, cleared: unedited(found.cleared, shown, prepared), kept: unedited(found.kept, shown, prepared) };
      cache[removal.scope] = removal;
    }
    const action = !listed ? 'add' : removal.scope === 'all' ? 'widen' : 'listed';
    if (action === 'listed') return { color, scope: removal.scope, action, cleared: NO_TILES, kept: NO_TILES };
    return { color, scope: removal.scope, action, cleared: removal.cleared, kept: removal.kept };
  }
}

/**
 * The replacement map: each entry turns the colors near `from` into `to`, in the order of the picks. A pick on the
 * stage first goes to `pending`; the chooser of the target makes one entry per pending source.
 */
export class ReplacedColorList extends ColorList<ReplacedColor> {
  /** The sources that wait for a target, in the order of the picks, each with the tolerance of its pick. */
  pending = $state.raw<readonly ColorNear[]>([]);
  /** The chooser of the target is open for `pending`. */
  choosing = $state(false);
  private tileCache: { key: string; tiles: Int32Array } | null = null;

  protected keyOf(entry: ReplacedColor): string {
    return `${entry.from}>${entry.to}@${entry.tolerance}`;
  }

  protected actionOf(detail: string): ListAction {
    return detail === 'restore' ? 'unreplace' : detail === 'clear' ? 'clearReplaced' : 'replace';
  }

  /** Adds a source to the pending group at the current tolerance. Returns false for TRANSPARENT or a pending color. */
  hold(color: number): boolean {
    if (color === TRANSPARENT || this.pending.some((entry) => entry.color === color)) return false;
    this.pending = [...this.pending, { color, tolerance: this.tolerance }];
    return true;
  }

  /** Adds a source to the pending group and opens the chooser of the target. */
  pick(color: number, tolerance = this.tolerance): void {
    if (color === TRANSPARENT) return;
    if (!this.pending.some((entry) => entry.color === color)) this.pending = [...this.pending, { color, tolerance }];
    this.choosing = this.pending.length > 0;
  }

  dropPending(color: number): void {
    this.pending = this.pending.filter((entry) => entry.color !== color);
    if (this.pending.length === 0) this.choosing = false;
  }

  /** Drops the pending group and closes the chooser. Returns false when nothing waited. */
  cancel(): boolean {
    if (this.pending.length === 0 && !this.choosing) return false;
    this.pending = [];
    this.choosing = false;
    return true;
  }

  /** One entry per pending source to `to`, in the order of the picks; a source equal to `to` is skipped. */
  pendingEntries(to: number): ReplacedColor[] {
    return this.pending.filter((entry) => entry.color !== to).map((entry) => ({ from: entry.color, to, tolerance: entry.tolerance }));
  }

  /** The list with `added`: a listed source is replaced in its place, a new one goes to the end. */
  merged(added: readonly ReplacedColor[]): ReplacedColor[] {
    const next = [...this.entries];
    for (const entry of added) {
      const at = next.findIndex((listed) => listed.from === entry.from);
      if (at >= 0) next[at] = entry;
      else next.push(entry);
    }
    return next;
  }

  remove(from: number): void {
    if (!this.entries.some((entry) => entry.from === from)) return;
    this.change(
      this.entries.filter((entry) => entry.from !== from),
      'restore',
    );
  }

  /** Forgets the list and the pending group with no event. */
  override reset(): void {
    super.reset();
    this.pending = [];
    this.choosing = false;
  }

  /**
   * The tiles that a pick of `color` at `tolerance` recolors: the shown tiles near it, without the pixel edits.
   * `stamp` names the stage, for the cache. Call it from an event handler.
   */
  tilesOf(prepared: Sprite, shown: Sprite, color: number, tolerance: number, stamp: string): Int32Array {
    if (color === TRANSPARENT || shown.pixels.length !== prepared.pixels.length) return NO_TILES;
    const key = `${stamp}|${color}|${tolerance}`;
    if (this.tileCache?.key === key) return this.tileCache.tiles;
    const tiles = unedited(tilesNear(shown, color, tolerance), shown, prepared);
    this.tileCache = { key, tiles };
    return tiles;
  }

  /** The tiles of every pending source, sorted. */
  pendingTiles(prepared: Sprite, shown: Sprite): Int32Array {
    if (this.pending.length === 0 || shown.pixels.length !== prepared.pixels.length) return NO_TILES;
    const seen = new Uint8Array(shown.pixels.length);
    for (const { color, tolerance } of this.pending) for (const tile of unedited(tilesNear(shown, color, tolerance), shown, prepared)) seen[tile] = 1;
    const out: number[] = [];
    for (let i = 0; i < seen.length; i++) if (seen[i]) out.push(i);
    return Int32Array.from(out);
  }
}
