import type { CellGrid, Sprite } from '../core/types.ts';
import { TRANSPARENT } from '../core/color.ts';
import { PARAMS } from '../core/params.ts';
import { placeFrames, prepareFrames, type BuiltFrames, type CellMode, type FrameOffset, type PreparedFrames, type RemovedColor } from '../core/frames.ts';
import { borderBackground, colorMatches, eraseTiles, listPalette, opaqueBox, type TileBox } from '../core/sprite.ts';
import { track } from './analytics.ts';
import { EditSession } from './edit-session.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';
import type { VideoInfo, VideoSource } from './video.ts';

/** One entry of the timeline: a video frame. The same frame can appear more than once, to hold a pose. Replaced on change. */
export interface AnimFrame {
  readonly id: number;
  /** The index of the video frame. */
  readonly index: number;
  /** Whole tiles that the content of this frame moves by in the output. */
  readonly offset: FrameOffset;
}

/** One sampled video frame: its tiles before and after its own color merge, and a small picture of the video frame. */
export interface SampledFrame {
  readonly raw: Sprite;
  readonly own: Sprite;
  readonly thumb: ImageBitmap;
}

/** The video frame as it comes out of the video, while its clean tiles are on their way. Owned by the model: closed on replace. */
export interface FramePreview {
  readonly index: number;
  /** The grid extent of the frame at one pixel per tile. */
  readonly tiles: ImageBitmap;
  readonly thumb: ImageBitmap;
}

/** What the frame store holds: distinct video frames, the pinned ones, and their raw plus own tiles. */
export interface FrameStoreStats {
  cached: number;
  pinned: number;
  tiles: number;
  pinnedTiles: number;
  /** Pinned frames that are not sampled yet. */
  pending: number;
}

/** The cell modes in the order of the UI: the container first, then the automatic ones. */
export const CELL_MODES: readonly CellMode[] = ['box', 'crop', 'feet', 'full'];

const EMPTY_BUILD: BuiltFrames = { frames: [], cell: { cols: 0, rows: 0 }, kept: [] };
const EMPTY_PREPARED: PreparedFrames = { frames: [], kept: [] };
const ZERO: FrameOffset = { x: 0, y: 0 };
const UNDO_LIMIT = 100;

/** The container and the offsets at one moment, for undo and redo. */
interface PlaceSnapshot {
  container: TileBox | null;
  offsets: ReadonlyMap<number, FrameOffset>;
}

function sameOffset(a: FrameOffset, b: FrameOffset): boolean {
  return a.x === b.x && a.y === b.y;
}

function sameBox(a: TileBox | null, b: TileBox | null): boolean {
  return a === b || (a !== null && b !== null && a.col === b.col && a.row === b.row && a.cols === b.cols && a.rows === b.rows);
}

function storedNumber(key: string, min: number, max: number, fallback: number): number {
  const value = Number(readStored(key));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** A new key: the container is the default even where an older automatic mode was stored. */
const CELL_KEY = 'animCellMode';

function storedCell(): CellMode {
  const value = readStored(CELL_KEY);
  return (CELL_MODES as readonly string[]).includes(value ?? '') ? (value as CellMode) : 'box';
}

/** The distinct video frames that `PARAMS.limits.maxTimelineTiles` holds at this many raw plus own tiles per frame. */
export function pinnedLimit(tilesPerFrame: number): number {
  return tilesPerFrame > 0 ? Math.floor(PARAMS.limits.maxTimelineTiles / tilesPerFrame) : 0;
}

const TOLERANCE_KEY = 'animRemoveTolerance';

/** A tolerance of "Remove color", inside the range of the slider. */
export function clampTolerance(value: number): number {
  return Number.isFinite(value) ? Math.min(TUNING.clean.removeToleranceMax, Math.max(0, value)) : TUNING.clean.removeTolerance;
}

function storedTolerance(key: string): number {
  const text = readStored(key);
  return text === null ? TUNING.clean.removeTolerance : clampTolerance(Number(text));
}

function clampFps(fps: number): number {
  return Math.round(Math.min(TUNING.anim.maxFps, Math.max(TUNING.anim.minFps, fps)));
}

/** A new key: the default step is 4 even where an older step was stored. */
const STEP_KEY = 'animStepSize';

export function sameGrid(a: CellGrid, b: CellGrid): boolean {
  if (a.x.length !== b.x.length || a.y.length !== b.y.length) return false;
  for (let i = 0; i < a.x.length; i++) if (a.x[i] !== b.x[i]) return false;
  for (let i = 0; i < a.y.length; i++) if (a.y[i] !== b.y[i]) return false;
  return true;
}

/**
 * The model of one video animation: the frame store of the video, the ordered timeline and the output rules (one
 * palette, the reference frame, the background erase and the common cell). The store keeps the sampled frames by
 * video index: the pinned ones (every frame of the timeline and the reference frame) stay while they are used, the
 * others form a small cache that forgets the oldest frame first. The app samples the frames and puts them in; every
 * option change builds the output frames again at once.
 */
export class Animation {
  /** The open video. Plain field: nothing renders from the element. */
  video: VideoSource | null = null;
  info = $state.raw<VideoInfo | null>(null);
  /** The video frame that the Grade step shows. */
  keyIndex = $state(0);

  /** The sampled frames by video index. Map order is the use order: the first unpinned frame is the next to go. */
  private store = new Map<number, SampledFrame>();
  /** Changes when a frame comes into the store or leaves it: views of missing frames look again. */
  storeVersion = $state(0);
  /** The video frame of the cursor before its clean tiles arrive. */
  preview = $state.raw<FramePreview | null>(null);
  /** The merge strength of the own tiles in the store. */
  ownStrength = Number.NaN;
  /** The grid lines that sample the frames, and the fit version of the Grade step at that time. Null before the lock. */
  grid: CellGrid | null = null;
  sampledFitVersion = -1;
  /** Changes with the grid and the merge strength: a sample made before the change does not go in the store. */
  generation = 0;
  /** Changes when the frames in the store change their pixels: views of the video frames draw again. */
  framesVersion = $state(0);
  /** Called when the frames that the screen needs change: the cursor, the timeline, the reference, the grid. */
  onneed: (() => void) | null = null;

  /** The video frame on the Frames screen. */
  cursor = $state(0);
  stepSize = $state(storedNumber(STEP_KEY, 1, Number.MAX_SAFE_INTEGER, TUNING.anim.defaultStep));
  timeline = $state.raw<AnimFrame[]>([]);
  selectedId = $state<number | null>(null);
  /** The video frame whose colors the reference option uses; the key frame by default. */
  referenceIndex = $state(0);
  referenceColors = $state(false);
  eraseBackground = $state(readStored('animErase') !== 'off');
  /** The colors that "Remove color" erases from every frame, in the order of the picks, each with the tolerance of its pick. */
  removedColors = $state.raw<readonly RemovedColor[]>([]);
  /** The OKLab tolerance of the next pick. A removed color keeps the tolerance of its own pick. */
  colorTolerance = $state(storedTolerance(TOLERANCE_KEY));
  cell = $state<CellMode>(storedCell());
  fps = $state(storedNumber('animFps', TUNING.anim.minFps, TUNING.anim.maxFps, TUNING.anim.defaultFps));
  onion = $state(readStored('animOnion') === 'on');
  /** Export options, kept between sessions. */
  sheetJson = $state(readStored('animJson') !== 'off');
  loopInGame = $state(readStored('animLoop') !== 'off');

  /**
   * The crop box of the frames, in tiles of the grid. The first timeline entry edits it; every other entry only
   * moves its content under it, through its offset. It can reach past the grid.
   */
  container = $state.raw<TileBox | null>(null);
  /** Undo and redo of the container and the offsets. */
  canUndo = $state(false);
  canRedo = $state(false);

  /** The output frames of the timeline: same size, one palette. */
  built = $state.raw<BuiltFrames>(EMPTY_BUILD);
  /** Changes on each build. */
  version = $state(0);
  /** Changes on each change that an export writes: the timeline or an output option. */
  editVersion = $state(0);
  exportedVersion = $state(-1);

  private nextId = 1;
  private arrivalTimer = 0;
  /** The container of the first add waits for the first frame to arrive. */
  private containerWaits = false;
  /** The user picked the reference frame; until then it follows the key frame. */
  private referenceChosen = false;
  /** The per-frame erase of the Frames screen, per video frame, until the frames or the erase change. */
  private displayCache = new Map<number, Sprite>();
  /** The palette, reference and erase of the timeline frames: the slow part, made again only when its inputs change. */
  private prepared: PreparedFrames = EMPTY_PREPARED;
  private preparedKey = '';
  private undoStack: PlaceSnapshot[] = [];
  private redoStack: PlaceSnapshot[] = [];
  /** The state before the edit in progress (a drag), or null. */
  private editStart: PlaceSnapshot | null = null;
  /** The pixel edits of each timeline entry, by entry id, over its prepared frame. */
  private sessions = new Map<number, EditSession>();
  /** Changes on each pixel edit of an entry: the badges and thumbnails read it. */
  frameEditsVersion = $state(0);
  private paletteCache: { version: number; colors: Array<{ color: number; count: number }> } | null = null;

  get active(): boolean {
    return this.info !== null;
  }

  /** The video frames that the Frames screen can show: all of them once the grid is locked. */
  get count(): number {
    return this.grid && this.info ? this.info.frameCount : 0;
  }

  /** The grid is locked: the Frames screen can open. */
  get locked(): boolean {
    return this.grid !== null;
  }

  /** The largest step: one less than the video frames. */
  get maxStep(): number {
    return Math.max(1, (this.info?.frameCount ?? 2) - 1);
  }

  /** A timeline that no export has written yet. */
  get unexported(): boolean {
    return this.timeline.length > 0 && this.editVersion !== this.exportedVersion;
  }

  get selected(): AnimFrame | null {
    return this.timeline.find((frame) => frame.id === this.selectedId) ?? null;
  }

  /** The timeline entry that edits the container. */
  get first(): AnimFrame | null {
    return this.timeline[0] ?? null;
  }

  /** The tile size of the locked grid. */
  get gridSize(): { cols: number; rows: number } {
    const grid = this.grid;
    return grid ? { cols: Math.max(0, grid.x.length - 1), rows: Math.max(0, grid.y.length - 1) } : { cols: 0, rows: 0 };
  }

  /** The raw plus own tiles of one sampled frame on the locked grid. */
  get tilesPerFrame(): number {
    const { cols, rows } = this.gridSize;
    return cols * rows * 2;
  }

  /** The distinct video frames that fit the timeline budget on the locked grid. */
  get maxPinned(): number {
    return pinnedLimit(this.tilesPerFrame);
  }

  /**
   * How full the timeline is: the timeline entries against `PARAMS.limits.maxFrames`, or the distinct pinned frames
   * against the tile budget, whichever is nearer to its limit.
   */
  get budget(): { used: number; max: number } {
    void this.timeline;
    const entries = { used: this.timeline.length, max: PARAMS.limits.maxFrames };
    const frames = { used: this.pinnedIndices().size, max: this.maxPinned };
    return frames.max > 0 && frames.used / frames.max > entries.used / entries.max ? frames : entries;
  }

  /** The video frames that the store keeps while they are used: every timeline frame and the reference frame. */
  pinnedIndices(): Set<number> {
    const pinned = new Set(this.timeline.map((frame) => frame.index));
    if (this.locked) pinned.add(this.referenceIndex);
    return pinned;
  }

  /** The sampled frame of a video index, or undefined. Reactive through `storeVersion`. */
  sampled(index: number): SampledFrame | undefined {
    void this.storeVersion;
    return this.store.get(index);
  }

  /** The frame is in the store. Reactive through `storeVersion`. */
  has(index: number): boolean {
    void this.storeVersion;
    return this.store.has(index);
  }

  /** A timeline frame that is not sampled yet. Reactive. */
  isPending(index: number): boolean {
    void this.storeVersion;
    return !this.store.has(index);
  }

  /** The distinct timeline frames that are not sampled yet. Reactive. */
  get pendingCount(): number {
    void this.storeVersion;
    let count = 0;
    for (const index of new Set(this.timeline.map((frame) => frame.index))) if (!this.store.has(index)) count++;
    return count;
  }

  /** The pinned frames that are not sampled yet: the timeline frames nearest to `near` first, then the reference. */
  missingPinned(near: number): number[] {
    const missing = [...new Set(this.timeline.map((frame) => frame.index))].filter((index) => !this.store.has(index));
    missing.sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b);
    if (this.locked && !this.store.has(this.referenceIndex) && !missing.includes(this.referenceIndex)) missing.push(this.referenceIndex);
    return missing;
  }

  stats(): FrameStoreStats {
    const pinned = this.pinnedIndices();
    let pinnedCount = 0;
    let pinnedTiles = 0;
    let tiles = 0;
    for (const [index, frame] of this.store) {
      const size = frame.raw.pixels.length + frame.own.pixels.length;
      tiles += size;
      if (pinned.has(index)) {
        pinnedCount++;
        pinnedTiles += size;
      }
    }
    let pending = 0;
    for (const index of pinned) if (!this.store.has(index)) pending++;
    return { cached: this.store.size - pinnedCount, pinned: pinnedCount, tiles, pinnedTiles, pending };
  }

  /**
   * How many of these new timeline entries fit, in order: the entries stay within `PARAMS.limits.maxFrames`, and
   * the distinct pinned frames within the tile budget of the grid.
   */
  room(indices: readonly number[]): number {
    const pinned = this.pinnedIndices();
    const maxPinned = this.maxPinned;
    let entries = this.timeline.length;
    let fit = 0;
    for (const index of indices) {
      if (entries + 1 > PARAMS.limits.maxFrames) break;
      if (!pinned.has(index)) {
        if (pinned.size + 1 > maxPinned) break;
        pinned.add(index);
      }
      entries++;
      fit++;
    }
    return fit;
  }

  /**
   * A sampled frame comes into the store. It is refused (and its thumb closed) when the grid or the strength changed
   * after the sample started, or when the frame is already there. Returns true when it went in.
   */
  put(index: number, frame: SampledFrame, generation: number): boolean {
    if (generation !== this.generation || this.store.has(index) || !this.locked) {
      frame.thumb.close();
      return false;
    }
    this.store.set(index, frame);
    this.storeVersion++;
    const pinned = this.pinnedIndices();
    if (pinned.has(index)) this.arrived();
    this.trimCache(pinned);
    return true;
  }

  /**
   * A pinned frame arrived. The palette work of the timeline runs on the main thread over every frame, so while
   * more pinned frames are on their way, the arrivals of a short time make one build.
   */
  private arrived(): void {
    clearTimeout(this.arrivalTimer);
    this.arrivalTimer = 0;
    const build = () => {
      this.arrivalTimer = 0;
      this.rebuild();
      this.settleContainer();
    };
    if (this.stats().pending === 0) build();
    else this.arrivalTimer = window.setTimeout(build, TUNING.anim.arrivalBuildMs);
  }

  /** The frame was shown again: the cache forgets it last. */
  touch(index: number): void {
    const frame = this.store.get(index);
    if (!frame) return;
    this.store.delete(index);
    this.store.set(index, frame);
  }

  /** The video frame of the cursor, before its clean tiles. The model owns the bitmaps and closes the ones it replaces. */
  setPreview(index: number, tiles: ImageBitmap, thumb: ImageBitmap): void {
    this.dropPreview();
    this.preview = { index, tiles, thumb };
  }

  private dropPreview(): void {
    const preview = this.preview;
    if (!preview) return;
    this.preview = null;
    preview.tiles.close();
    preview.thumb.close();
  }

  /** Forgets the oldest unpinned frames past the cache budget of `TUNING.anim`. The cursor frame stays. */
  private trimCache(pinned = this.pinnedIndices()): void {
    let count = 0;
    let tiles = 0;
    for (const [index, frame] of this.store) {
      if (pinned.has(index)) continue;
      count++;
      tiles += frame.raw.pixels.length + frame.own.pixels.length;
    }
    if (count <= TUNING.anim.cacheFrames && tiles <= TUNING.anim.cacheTiles) return;
    for (const [index, frame] of this.store) {
      if (count <= TUNING.anim.cacheFrames && tiles <= TUNING.anim.cacheTiles) break;
      if (pinned.has(index) || index === this.cursor) continue;
      this.evict(index);
      count--;
      tiles -= frame.raw.pixels.length + frame.own.pixels.length;
    }
  }

  private evict(index: number): void {
    const frame = this.store.get(index);
    if (!frame) return;
    this.store.delete(index);
    this.displayCache.delete(index);
    frame.thumb.close();
    this.storeVersion++;
  }

  /** Empties the store and the preview, and closes their bitmaps. */
  private emptyStore(): void {
    for (const frame of this.store.values()) frame.thumb.close();
    this.store.clear();
    this.displayCache.clear();
    this.dropPreview();
    this.storeVersion++;
  }

  /** Some timeline entry has pixel edits. */
  get hasFrameEdits(): boolean {
    void this.frameEditsVersion;
    for (const session of this.sessions.values()) if (session.hasEdits) return true;
    return false;
  }

  /** The entry has pixel edits. Reactive through `frameEditsVersion`. */
  isEdited(id: number): boolean {
    void this.frameEditsVersion;
    return this.sessions.get(id)?.hasEdits ?? false;
  }

  /**
   * The edit session of one entry, made on first use. Its base is the prepared frame of the entry (one palette,
   * reference colors and erase, on the full grid, before the placement). Null for an unknown entry.
   */
  sessionOf(id: number): EditSession | null {
    const at = this.liveTimeline().findIndex((frame) => frame.id === id);
    const base = this.prepared.frames[at];
    if (at < 0 || !base) return null;
    let session = this.sessions.get(id);
    if (!session) {
      session = new EditSession();
      session.setBase(base);
      this.sessions.set(id, session);
    }
    return session;
  }

  /** The prepared frame of an entry with its pixel edits, on the full grid; null for an unknown entry. */
  editedFrame(id: number): Sprite | null {
    const timeline = this.liveTimeline();
    const at = timeline.findIndex((frame) => frame.id === id);
    return at < 0 ? null : (this.frameAt(at, timeline) ?? null);
  }

  /** The edits of an entry, for a view of its video frame: null when the entry has no edits. */
  editsOf(id: number): Sprite | null {
    void this.frameEditsVersion;
    const session = this.sessions.get(id);
    return session?.hasEdits ? session.composed() : null;
  }

  /** A pixel edit of an entry: the output places the frames again, and the export has a change to write. */
  frameEdited(): void {
    this.editVersion++;
    this.frameEditsVersion++;
    this.place();
  }

  /** The colors of every timeline frame with its edits, most used first: the palette of the frame editor. */
  paletteColors(): Array<{ color: number; count: number }> {
    if (this.paletteCache?.version === this.version) return this.paletteCache.colors;
    const timeline = this.liveTimeline();
    const frames = timeline.map((_, at) => this.frameAt(at, timeline)).filter((frame): frame is Sprite => frame !== undefined);
    const all = new Uint32Array(frames.reduce((sum, frame) => sum + frame.pixels.length, 0));
    let offset = 0;
    for (const frame of frames) {
      all.set(frame.pixels, offset);
      offset += frame.pixels.length;
    }
    const colors = listPalette(all);
    this.paletteCache = { version: this.version, colors };
    return colors;
  }

  find(id: number): AnimFrame | null {
    return this.timeline.find((frame) => frame.id === id) ?? null;
  }

  /** The first timeline entry of a video frame. */
  entryOf(index: number): AnimFrame | null {
    return this.timeline.find((frame) => frame.index === index) ?? null;
  }

  /** The offset that a new entry of this video frame would take: that of the nearest earlier entry in timeline order. */
  inheritedOffset(index: number): FrameOffset {
    const list = this.timeline;
    let at = list.length;
    while (at > 0 && list[at - 1].index > index) at--;
    return (list[at - 1] ?? list[at])?.offset ?? ZERO;
  }

  /** The container over the source tiles of one frame: it sits where the offset of the frame puts it. */
  containerFor(offset: FrameOffset): TileBox | null {
    const box = this.container;
    return box ? { col: box.col - offset.x, row: box.row - offset.y, cols: box.cols, rows: box.rows } : null;
  }

  /** The container that the first add makes: the opaque box of that frame with a margin; the whole grid when it is empty. */
  private initialContainer(sprite: Sprite | undefined): TileBox | null {
    const { cols, rows } = this.gridSize;
    if (cols === 0 || rows === 0) return null;
    const box = sprite ? opaqueBox(sprite) : null;
    if (!box) return { col: 0, row: 0, cols, rows };
    const mx = Math.max(TUNING.anim.containerMarginMin, Math.round(box.cols * TUNING.anim.containerMarginShare));
    const my = Math.max(TUNING.anim.containerMarginMin, Math.round(box.rows * TUNING.anim.containerMarginShare));
    const col = Math.max(0, box.col - mx);
    const row = Math.max(0, box.row - my);
    return { col, row, cols: Math.min(cols, box.col + box.cols + mx) - col, rows: Math.min(rows, box.row + box.rows + my) - row };
  }

  /** The number of timeline entries of one video frame. */
  uses(index: number): number {
    let count = 0;
    for (const frame of this.timeline) if (frame.index === index) count++;
    return count;
  }

  /** A new video: everything of the last one goes away. */
  start(video: VideoSource): void {
    this.clear();
    this.video = video;
    this.info = video.info;
  }

  /** True when the grid is locked with exactly these grid lines. */
  sampledWith(grid: CellGrid, fitVersion: number): boolean {
    if (!this.grid) return false;
    return this.sampledFitVersion === fitVersion || sameGrid(this.grid, grid);
  }

  /**
   * Locks a grid. `frames` holds the pinned frames sampled on it; the cache is cleared, and every other frame is
   * sampled on demand. The timeline stays. A grid of another tile size makes the container again on the first entry,
   * resets every offset and drops the pixel edits: returns true then.
   */
  setGrid(grid: CellGrid, fitVersion: number, strength: number, frames: ReadonlyMap<number, SampledFrame>): boolean {
    const before = this.gridSize;
    const wasLocked = this.locked;
    this.emptyStore();
    this.grid = { x: grid.x.slice(), y: grid.y.slice() };
    this.sampledFitVersion = fitVersion;
    this.ownStrength = strength;
    this.generation++;
    const size = this.gridSize;
    const sizeChanged = !wasLocked || size.cols !== before.cols || size.rows !== before.rows;
    const resized = this.container !== null && sizeChanged;
    for (const [index, frame] of frames) this.store.set(index, frame);
    this.framesVersion++;
    const count = this.count;
    this.cursor = Math.min(this.cursor, Math.max(0, count - 1));
    if (!this.referenceChosen || this.referenceIndex >= count) this.referenceIndex = Math.min(this.keyIndex, Math.max(0, count - 1));
    let kept = this.timeline.filter((frame) => frame.index < count);
    if (sizeChanged) this.sessions.clear();
    for (const id of this.sessions.keys()) if (!kept.some((frame) => frame.id === id)) this.sessions.delete(id);
    this.frameEditsVersion++;
    if (resized) {
      kept = kept.map((frame) => ({ ...frame, offset: ZERO }));
      this.container = null;
      this.clearHistory();
    }
    if (kept.length !== this.timeline.length || resized) this.setTimeline(kept);
    else this.rebuild();
    if (resized && kept.length > 0) {
      this.container = this.initialContainer(this.prepared.frames[0]);
      this.place();
    }
    this.onneed?.();
    return resized;
  }

  /**
   * The own merge of the pinned frames at a new strength, by video index. Every other frame leaves the store: its
   * own tiles are of the old strength, so it is sampled again when it is needed.
   */
  setOwns(owns: ReadonlyMap<number, Sprite>, strength: number): void {
    for (const [index, frame] of [...this.store]) {
      const own = owns.get(index);
      if (own) this.store.set(index, { raw: frame.raw, own, thumb: frame.thumb });
      else this.evict(index);
    }
    this.ownStrength = strength;
    this.generation++;
    this.storeVersion++;
    this.displayCache.clear();
    this.framesVersion++;
    this.editVersion++;
    this.rebuild();
    this.onneed?.();
  }

  /** The raw tiles of the sampled pinned frames, by video index: the input of a new merge. */
  pinnedRaws(): Map<number, Sprite> {
    const raws = new Map<number, Sprite>();
    for (const index of this.pinnedIndices()) {
      const frame = this.store.get(index);
      if (frame) raws.set(index, frame.raw);
    }
    return raws;
  }

  /** The small picture of a video frame: from the store, or from the preview of the cursor. Reactive. */
  thumbOf(index: number): ImageBitmap | null {
    const frame = this.sampled(index);
    if (frame) return frame.thumb;
    const preview = this.preview;
    return preview && preview.index === index ? preview.thumb : null;
  }

  /** The clean video frame as the Frames screen shows it: its own merge, with its background erased when that is on. Reactive. */
  displayFrame(index: number): Sprite | null {
    void this.storeVersion;
    const own = this.store.get(index)?.own;
    if (!own) return null;
    if (!this.eraseBackground) return own;
    const cached = this.displayCache.get(index);
    if (cached) return cached;
    const background = borderBackground(own);
    const sprite = background.length > 0 ? eraseTiles(own, background) : own;
    this.displayCache.set(index, sprite);
    return sprite;
  }

  /** Moves the cursor of the Frames screen. Returns false when it did not move. */
  seek(index: number): boolean {
    if (this.count === 0) return false;
    const next = Math.min(this.count - 1, Math.max(0, Math.round(index)));
    if (next === this.cursor) return false;
    this.cursor = next;
    this.onneed?.();
    return true;
  }

  /** The step of the Frames screen: 1 up to one less than the video frames. Returns false when it did not change. */
  setStepSize(size: number): boolean {
    const next = Math.min(this.maxStep, Math.max(1, Math.round(size) || 1));
    if (next === this.stepSize) return false;
    this.stepSize = next;
    writeStored(STEP_KEY, String(next));
    return true;
  }

  /**
   * Adds a video frame to the timeline, after the last entry of an earlier or equal video frame, so frames
   * picked out of order still play in video order. Returns the new entry.
   */
  add(index: number): AnimFrame | null {
    if (index < 0 || index >= this.count || this.room([index]) === 0) return null;
    const wasEmpty = this.timeline.length === 0;
    const frame: AnimFrame = { id: this.nextId++, index, offset: wasEmpty ? ZERO : this.inheritedOffset(index) };
    const list = this.timeline;
    let at = list.length;
    while (at > 0 && list[at - 1].index > index) at--;
    this.setTimeline([...list.slice(0, at), frame, ...list.slice(at)]);
    this.selectedId = frame.id;
    if (wasEmpty) this.startContainer();
    return frame;
  }

  /**
   * "Adicionar intervalo": every `every` video frames from `from` to the last one that is not in the timeline yet,
   * as many as the budget allows. `limited` is true when the budget cut the range.
   */
  addRange(from: number, every: number): { added: AnimFrame[]; limited: boolean } {
    const step = Math.max(1, Math.round(every));
    const present = new Set(this.timeline.map((frame) => frame.index));
    const wanted: number[] = [];
    for (let index = Math.max(0, from); index < this.count; index += step) if (!present.has(index)) wanted.push(index);
    const fit = this.room(wanted);
    const limited = fit < wanted.length;
    const added: AnimFrame[] = [];
    const wasEmpty = this.timeline.length === 0;
    const list = [...this.timeline];
    for (const index of wanted.slice(0, fit)) {
      let at = list.length;
      while (at > 0 && list[at - 1].index > index) at--;
      const offset = (list[at - 1] ?? list[at])?.offset ?? ZERO;
      const frame: AnimFrame = { id: this.nextId++, index, offset };
      list.splice(at, 0, frame);
      added.push(frame);
    }
    if (added.length === 0) return { added, limited };
    this.setTimeline(list);
    this.selectedId = added[added.length - 1].id;
    if (wasEmpty) this.startContainer();
    return { added, limited };
  }

  /** Removes several entries at once, for a cancelled range. */
  removeMany(ids: ReadonlySet<number>): void {
    if (ids.size === 0) return;
    let edits = false;
    for (const id of ids) edits = this.sessions.delete(id) || edits;
    if (edits) this.frameEditsVersion++;
    this.setTimeline(this.timeline.filter((frame) => !ids.has(frame.id)));
  }

  /** Removes the last timeline entry of a video frame. Returns the removed entry. */
  removeIndex(index: number): AnimFrame | null {
    const list = this.timeline;
    let at = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].index === index) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const frame = list[at];
    this.remove(frame.id);
    return frame;
  }

  remove(id: number): void {
    const list = this.timeline;
    const at = list.findIndex((frame) => frame.id === id);
    if (at < 0) return;
    const next = list.filter((frame) => frame.id !== id);
    if (this.sessions.delete(id)) this.frameEditsVersion++;
    if (this.selectedId === id) this.selectedId = next[Math.min(at, next.length - 1)]?.id ?? null;
    this.setTimeline(next);
  }

  /** A copy of the entry right after it: the pose holds one more frame. */
  duplicate(id: number): AnimFrame | null {
    const list = this.timeline;
    const at = list.findIndex((frame) => frame.id === id);
    if (at < 0) return null;
    const frame: AnimFrame = { id: this.nextId++, index: list[at].index, offset: list[at].offset };
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(frame.id, session.clone());
      this.frameEditsVersion++;
    }
    this.setTimeline([...list.slice(0, at + 1), frame, ...list.slice(at + 1)]);
    this.selectedId = frame.id;
    return frame;
  }

  /** Moves an entry one place to the left (-1) or right (1). Returns false at an end. */
  move(id: number, delta: -1 | 1): boolean {
    const list = [...this.timeline];
    const at = list.findIndex((frame) => frame.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= list.length) return false;
    [list[at], list[to]] = [list[to], list[at]];
    this.setTimeline(list);
    return true;
  }

  select(id: number | null): void {
    this.selectedId = id;
  }

  setReference(index: number): void {
    if (index < 0 || index >= this.count) return;
    this.referenceChosen = true;
    if (index === this.referenceIndex) return;
    this.referenceIndex = index;
    track('option_change', { kind: 'anim_reference_frame', detail: index });
    if (this.referenceColors) this.changed();
    this.trimCache();
    this.onneed?.();
  }

  setReferenceColors(on: boolean): void {
    if (on === this.referenceColors) return;
    this.referenceColors = on;
    track('option_change', { kind: 'anim_reference', detail: on });
    this.changed();
  }

  setEraseBackground(on: boolean): void {
    if (on === this.eraseBackground) return;
    this.eraseBackground = on;
    writeStored('animErase', on ? 'on' : 'off');
    track('option_change', { kind: 'anim_erase', detail: on });
    this.displayCache.clear();
    this.framesVersion++;
    this.changed();
  }

  /**
   * Adds a color, at the current tolerance, to the colors that every frame loses. Returns how many timeline frames
   * have tiles of it within that tolerance; with 0 (no frame has it, it is in the list, or it is TRANSPARENT) the
   * list does not change.
   */
  addRemovedColor(color: number): number {
    if (color === TRANSPARENT || this.hasRemovedColor(color)) return 0;
    const tolerance = this.colorTolerance;
    const frames = this.prepared.frames.filter((frame) => colorMatches(frame, [color], tolerance).length > 0).length;
    if (frames === 0) return 0;
    this.removedColors = [...this.removedColors, { color, tolerance }];
    track('option_change', { kind: 'anim_remove_color', detail: 'add', count: this.removedColors.length });
    this.changed();
    return frames;
  }

  restoreRemovedColor(color: number): void {
    if (!this.hasRemovedColor(color)) return;
    this.removedColors = this.removedColors.filter((entry) => entry.color !== color);
    track('option_change', { kind: 'anim_remove_color', detail: 'restore', count: this.removedColors.length });
    this.changed();
  }

  /** The color is in the list of "Remove color", at any tolerance. */
  hasRemovedColor(color: number): boolean {
    return this.removedColors.some((entry) => entry.color === color);
  }

  clearRemovedColors(): void {
    if (this.removedColors.length === 0) return;
    this.removedColors = [];
    track('option_change', { kind: 'anim_remove_color', detail: 'clear', count: 0 });
    this.changed();
  }

  /**
   * The tolerance of the next picks. It builds nothing: each removed color keeps the tolerance of its pick, until the
   * user restores it and picks it again. `commit` (the end of a slider drag) stores it.
   */
  setColorTolerance(value: number, commit = true): void {
    this.colorTolerance = clampTolerance(value);
    if (!commit) return;
    writeStored(TOLERANCE_KEY, String(this.colorTolerance));
    track('option_change', { kind: 'anim_remove_color', detail: 'tolerance', count: this.removedColors.length });
  }

  setCell(mode: CellMode): void {
    if (mode === this.cell) return;
    this.cell = mode;
    writeStored(CELL_KEY, mode);
    track('option_change', { kind: 'anim_cell', detail: mode });
    this.editVersion++;
    this.place();
  }

  /** Starts an edit of the container or of offsets: a drag, or one key press. Many live changes make one undo step. */
  beginEdit(): void {
    if (!this.editStart) this.editStart = this.snapshot();
  }

  /** Ends the edit; an edit that changed nothing adds no step. Returns true when it changed something. */
  endEdit(): boolean {
    const start = this.editStart;
    this.editStart = null;
    if (!start || this.sameAsNow(start)) return false;
    this.undoStack.push(start);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.syncHistory();
    return true;
  }

  /**
   * The container of the first entry: whole tiles, at least 1 by 1. Call it live during a drag, between
   * beginEdit and endEdit.
   */
  setContainer(box: TileBox): void {
    const next: TileBox = { col: Math.round(box.col), row: Math.round(box.row), cols: Math.max(1, Math.round(box.cols)), rows: Math.max(1, Math.round(box.rows)) };
    if (sameBox(next, this.container)) return;
    this.container = next;
    this.editVersion++;
    this.place();
  }

  /** The offset of one entry, in whole tiles. Live during a drag, between beginEdit and endEdit. */
  setOffset(id: number, offset: FrameOffset): void {
    const next = { x: Math.round(offset.x), y: Math.round(offset.y) };
    const list = this.timeline;
    const at = list.findIndex((frame) => frame.id === id);
    if (at < 0 || sameOffset(list[at].offset, next)) return;
    const copy = [...list];
    copy[at] = { ...list[at], offset: next };
    this.timeline = copy;
    this.editVersion++;
    this.place();
  }

  /** One step of undo of the container and the offsets. */
  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.redoStack.push(this.snapshot());
    this.restore(step);
    this.syncHistory();
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.undoStack.push(this.snapshot());
    this.restore(step);
    this.syncHistory();
    return true;
  }

  private snapshot(): PlaceSnapshot {
    return { container: this.container, offsets: new Map(this.timeline.map((frame) => [frame.id, frame.offset])) };
  }

  private sameAsNow(snap: PlaceSnapshot): boolean {
    if (!sameBox(snap.container, this.container)) return false;
    return this.timeline.every((frame) => {
      const before = snap.offsets.get(frame.id);
      return !before || sameOffset(before, frame.offset);
    });
  }

  private restore(snap: PlaceSnapshot): void {
    this.container = snap.container;
    this.timeline = this.timeline.map((frame) => {
      const offset = snap.offsets.get(frame.id);
      return offset && !sameOffset(offset, frame.offset) ? { ...frame, offset } : frame;
    });
    this.editVersion++;
    this.place();
  }

  private syncHistory(): void {
    this.canUndo = this.undoStack.length > 0;
    this.canRedo = this.redoStack.length > 0;
  }

  private clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.editStart = null;
    this.syncHistory();
  }

  /**
   * The first add makes the container from the prepared sprite of that frame. A frame that is not sampled yet gets
   * the whole grid until it arrives, then the container from its sprite, unless the user changed it in between.
   */
  private startContainer(): void {
    const first = this.timeline[0];
    const live = first !== undefined && this.store.has(first.index);
    this.container = this.initialContainer(live ? this.prepared.frames[0] : undefined);
    this.containerWaits = !live;
    this.clearHistory();
    this.place();
  }

  /** The first frame arrived after its add: the container fits it now. */
  private settleContainer(): void {
    const first = this.timeline[0];
    if (!this.containerWaits || !first || !this.store.has(first.index)) return;
    this.containerWaits = false;
    if (this.canUndo) return;
    this.container = this.initialContainer(this.prepared.frames[0]);
    this.place();
  }

  /** The playback speed. A held button sends many changes: `commit` stores and reports only the last one. */
  setFps(fps: number, commit = true): void {
    const next = clampFps(fps);
    if (next !== this.fps) {
      this.fps = next;
      this.editVersion++;
    }
    if (commit) this.commitFps();
  }

  commitFps(): void {
    writeStored('animFps', String(this.fps));
    track('option_change', { kind: 'anim_fps', detail: this.fps });
  }

  setOnion(on: boolean): void {
    if (on === this.onion) return;
    this.onion = on;
    writeStored('animOnion', on ? 'on' : 'off');
    track('option_change', { kind: 'anim_onion', detail: on });
  }

  setSheetJson(on: boolean): void {
    this.sheetJson = on;
    writeStored('animJson', on ? 'on' : 'off');
    track('option_change', { kind: 'anim_json', detail: on });
  }

  setLoopInGame(on: boolean): void {
    this.loopInGame = on;
    writeStored('animLoop', on ? 'on' : 'off');
    track('option_change', { kind: 'anim_loop', detail: on });
  }

  /**
   * The fps that plays the timeline at the speed of the video: the video fps over the median gap between
   * neighbor entries. Without two distinct frames, the step size gives the gap.
   */
  videoFps(): number {
    const fps = this.info?.fps ?? TUNING.anim.defaultFps;
    const gaps: number[] = [];
    for (let i = 1; i < this.timeline.length; i++) {
      const gap = Math.abs(this.timeline[i].index - this.timeline[i - 1].index);
      if (gap > 0) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    const gap = gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)] : this.stepSize;
    return clampFps(fps / gap);
  }

  /**
   * Builds the output frames of the timeline: one palette, the reference colors, the removed colors and the erase
   * (only when one of these inputs or the frames changed), then the placement in the cell.
   */
  rebuild(): void {
    const timeline = this.liveTimeline();
    const strength = Number.isFinite(this.ownStrength) ? this.ownStrength : 0;
    const reference = this.referenceColors ? this.store.get(this.referenceIndex)?.own : undefined;
    const removed = this.removedColors.length > 0 ? this.removedColors : null;
    const key = `${this.framesVersion}|${strength}|${reference ? this.referenceIndex : -1}|${this.eraseBackground}|${removed ? removed.map((entry) => `${entry.color}@${entry.tolerance}`).join(',') : ''}|${timeline.map((frame) => frame.index).join(',')}`;
    if (key !== this.preparedKey) {
      this.preparedKey = key;
      this.prepared =
        timeline.length === 0
          ? EMPTY_PREPARED
          : prepareFrames(
              timeline.map((frame) => this.store.get(frame.index)!.own),
              { strength, reference: reference ? listPalette(reference.pixels) : null, eraseBackground: this.eraseBackground, removeColors: removed },
            );
      // Same grid size: each session keeps its edits over the new base.
      timeline.forEach((frame, at) => {
        const base = this.prepared.frames[at];
        if (base) this.sessions.get(frame.id)?.setBase(base);
      });
    }
    this.place();
  }

  /**
   * One output frame with `pad` tiles of its frame around the cell, for the Align step: `inner` is the cell inside
   * the sprite. Only the container mode knows where the cell sits in the frame; the other modes give the cell alone.
   */
  paddedFrame(position: number, pad: number): { sprite: Sprite; inner: TileBox } | null {
    const frame = this.timeline[position];
    const prepared = this.frameAt(position);
    const built = this.built.frames[position];
    if (!frame || !prepared || !built) return null;
    const box = this.container;
    if (this.cell !== 'box' || !box || pad <= 0) return { sprite: built, inner: { col: 0, row: 0, cols: built.cols, rows: built.rows } };
    const wide: TileBox = { col: box.col - pad, row: box.row - pad, cols: box.cols + pad * 2, rows: box.rows + pad * 2 };
    const placed = placeFrames([prepared], { cell: 'box', offsets: [frame.offset], box: wide });
    const sprite = placed.frames[0];
    return sprite ? { sprite, inner: { col: pad, row: pad, cols: box.cols, rows: box.rows } } : null;
  }

  /** Places the prepared frames in the cell with the offsets and the container. Cheap: it runs on every drag move. */
  private place(): void {
    const timeline = this.liveTimeline();
    const prepared = this.prepared;
    if (prepared.frames.length === 0 || prepared.frames.length !== timeline.length) {
      this.built = prepared.frames.length === 0 ? EMPTY_BUILD : this.built;
      this.version++;
      return;
    }
    const cell = this.cell === 'box' && !this.container ? 'crop' : this.cell;
    const frames = prepared.frames.map((frame, at) => this.sessions.get(timeline[at].id)?.composed() ?? frame);
    const placed = placeFrames(frames, { cell, offsets: timeline.map((frame) => frame.offset), box: this.container });
    this.built = { frames: placed.frames, cell: placed.cell, kept: prepared.kept };
    this.version++;
  }

  /** The timeline entries whose video frame is in the store: the ones that `prepared` holds, in order. */
  private liveTimeline(): AnimFrame[] {
    return this.timeline.filter((frame) => this.store.has(frame.index));
  }

  /** The prepared frame at one timeline position, with the edits of its entry. */
  private frameAt(position: number, timeline = this.liveTimeline()): Sprite | undefined {
    const prepared = this.prepared.frames[position];
    const frame = timeline[position];
    if (!prepared || !frame) return prepared;
    const session = this.sessions.get(frame.id);
    return session?.hasBase ? session.composed() : prepared;
  }

  markExported(): void {
    this.exportedVersion = this.editVersion;
  }

  /** Forgets the video and its frames. The stored options stay. */
  clear(): void {
    clearTimeout(this.arrivalTimer);
    this.arrivalTimer = 0;
    this.emptyStore();
    this.video?.close();
    this.video = null;
    this.info = null;
    this.keyIndex = 0;
    this.ownStrength = Number.NaN;
    this.grid = null;
    this.sampledFitVersion = -1;
    this.generation++;
    this.framesVersion++;
    this.cursor = 0;
    this.timeline = [];
    this.selectedId = null;
    this.referenceIndex = 0;
    this.referenceChosen = false;
    this.referenceColors = false;
    this.removedColors = [];
    this.container = null;
    this.containerWaits = false;
    this.clearHistory();
    this.sessions.clear();
    this.frameEditsVersion++;
    this.paletteCache = null;
    this.prepared = EMPTY_PREPARED;
    this.preparedKey = '';
    this.built = EMPTY_BUILD;
    this.version++;
    this.editVersion++;
    this.exportedVersion = this.editVersion;
  }

  private setTimeline(list: AnimFrame[]): void {
    this.timeline = list;
    if (this.selectedId !== null && !list.some((frame) => frame.id === this.selectedId)) this.selectedId = list[list.length - 1]?.id ?? null;
    this.changed();
    this.trimCache();
    this.onneed?.();
  }

  private changed(): void {
    this.editVersion++;
    this.rebuild();
  }
}
