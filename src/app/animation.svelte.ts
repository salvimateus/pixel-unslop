import type { CellGrid, Sprite } from '../core/types.ts';
import { placeFrames, prepareFrames, type BuiltFrames, type CellMode, type FrameOffset, type PreparedFrames } from '../core/frames.ts';
import { borderBackground, eraseTiles, listPalette, opaqueBox, type TileBox } from '../core/sprite.ts';
import { track } from './analytics.ts';
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

function clampFps(fps: number): number {
  return Math.round(Math.min(TUNING.anim.maxFps, Math.max(TUNING.anim.minFps, fps)));
}

function sameGrid(a: CellGrid, b: CellGrid): boolean {
  if (a.x.length !== b.x.length || a.y.length !== b.y.length) return false;
  for (let i = 0; i < a.x.length; i++) if (a.x[i] !== b.x[i]) return false;
  for (let i = 0; i < a.y.length; i++) if (a.y[i] !== b.y[i]) return false;
  return true;
}

/**
 * The model of one video animation: the sampled frames of the video, the ordered timeline and the output
 * rules (one palette, the reference frame, the background erase and the common cell). The app writes the
 * sampled frames; every option change builds the output frames again at once.
 */
export class Animation {
  /** The open video. Plain field: nothing renders from the element. */
  video: VideoSource | null = null;
  info = $state.raw<VideoInfo | null>(null);
  /** The video frame that the Grade step shows. */
  keyIndex = $state(0);

  /** The tiles of every sampled video frame, before and after its own color merge. Replaced as a whole. */
  raws = $state.raw<Sprite[]>([]);
  owns = $state.raw<Sprite[]>([]);
  /** A small picture of each sampled video frame, for the monitor. Closed on replace and on clear. */
  thumbs = $state.raw<ImageBitmap[]>([]);
  /** The merge strength of `owns`. */
  ownStrength = Number.NaN;
  /** The grid lines that sampled the frames, and the fit version of the Grade step at that time. */
  grid: CellGrid | null = null;
  sampledFitVersion = -1;
  /** Changes when the sampled frames or their merge change: views of the video frames draw again. */
  framesVersion = $state(0);

  /** The video frame on the Frames screen. */
  cursor = $state(0);
  stepSize = $state(storedNumber('animStep', 1, 4, 1));
  timeline = $state.raw<AnimFrame[]>([]);
  selectedId = $state<number | null>(null);
  /** The video frame whose colors the reference option uses; the key frame by default. */
  referenceIndex = $state(0);
  referenceColors = $state(false);
  eraseBackground = $state(readStored('animErase') !== 'off');
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

  get active(): boolean {
    return this.info !== null;
  }

  get count(): number {
    return this.owns.length;
  }

  get extracted(): boolean {
    return this.owns.length > 0;
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

  /** The tile size of the grid of the sampled frames. */
  get gridSize(): { cols: number; rows: number } {
    const own = this.owns[0];
    return own ? { cols: own.cols, rows: own.rows } : { cols: 0, rows: 0 };
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

  /** True when the frames were sampled with exactly these grid lines. */
  sampledWith(grid: CellGrid, fitVersion: number): boolean {
    if (!this.extracted || !this.grid) return false;
    return this.sampledFitVersion === fitVersion || sameGrid(this.grid, grid);
  }

  /**
   * New sampled frames. The timeline keeps its video indices; entries past the new count go away. A grid of
   * another tile size makes the container again on the first entry and resets every offset: returns true then.
   */
  setFrames(raws: Sprite[], owns: Sprite[], thumbs: ImageBitmap[], strength: number, grid: CellGrid, fitVersion: number): boolean {
    const before = this.gridSize;
    const resized = this.container !== null && (owns[0]?.cols !== before.cols || owns[0]?.rows !== before.rows);
    for (const thumb of this.thumbs) thumb.close();
    this.raws = raws;
    this.owns = owns;
    this.thumbs = thumbs;
    this.ownStrength = strength;
    this.grid = { x: grid.x.slice(), y: grid.y.slice() };
    this.sampledFitVersion = fitVersion;
    this.displayCache.clear();
    this.framesVersion++;
    const count = owns.length;
    this.cursor = Math.min(this.cursor, Math.max(0, count - 1));
    if (!this.referenceChosen || this.referenceIndex >= count) this.referenceIndex = Math.min(this.keyIndex, Math.max(0, count - 1));
    let kept = this.timeline.filter((frame) => frame.index < count);
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
    return resized;
  }

  /** The own merge of every frame at a new strength. */
  setOwn(owns: Sprite[], strength: number): void {
    if (owns.length !== this.owns.length) return;
    this.owns = owns;
    this.ownStrength = strength;
    this.displayCache.clear();
    this.framesVersion++;
    this.editVersion++;
    this.rebuild();
  }

  thumbOf(index: number): ImageBitmap | null {
    return this.thumbs[index] ?? null;
  }

  /** The clean video frame as the Frames screen shows it: its own merge, with its background erased when that is on. */
  displayFrame(index: number): Sprite | null {
    const own = this.owns[index];
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
    return true;
  }

  setStepSize(size: number): void {
    const next = Math.min(4, Math.max(1, Math.round(size)));
    if (next === this.stepSize) return;
    this.stepSize = next;
    writeStored('animStep', String(next));
  }

  /**
   * Adds a video frame to the timeline, after the last entry of an earlier or equal video frame, so frames
   * picked out of order still play in video order. Returns the new entry.
   */
  add(index: number): AnimFrame | null {
    if (index < 0 || index >= this.count) return null;
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

  /** "Adicionar intervalo": every `every` video frames from `from` to the last one that is not in the timeline yet. */
  addRange(from: number, every: number): AnimFrame[] {
    const step = Math.max(1, Math.round(every));
    const present = new Set(this.timeline.map((frame) => frame.index));
    const added: AnimFrame[] = [];
    const wasEmpty = this.timeline.length === 0;
    const list = [...this.timeline];
    for (let index = Math.max(0, from); index < this.count; index += step) {
      if (present.has(index)) continue;
      let at = list.length;
      while (at > 0 && list[at - 1].index > index) at--;
      const offset = (list[at - 1] ?? list[at])?.offset ?? ZERO;
      const frame: AnimFrame = { id: this.nextId++, index, offset };
      list.splice(at, 0, frame);
      added.push(frame);
    }
    if (added.length === 0) return added;
    this.setTimeline(list);
    this.selectedId = added[added.length - 1].id;
    if (wasEmpty) this.startContainer();
    return added;
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
    if (this.selectedId === id) this.selectedId = next[Math.min(at, next.length - 1)]?.id ?? null;
    this.setTimeline(next);
  }

  /** A copy of the entry right after it: the pose holds one more frame. */
  duplicate(id: number): AnimFrame | null {
    const list = this.timeline;
    const at = list.findIndex((frame) => frame.id === id);
    if (at < 0) return null;
    const frame: AnimFrame = { id: this.nextId++, index: list[at].index, offset: list[at].offset };
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

  /** The first add makes the container from the prepared sprite of that frame. */
  private startContainer(): void {
    this.container = this.initialContainer(this.prepared.frames[0]);
    this.clearHistory();
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
   * Builds the output frames of the timeline: one palette, the reference colors and the erase (only when the
   * frames, the strength, the reference or the erase changed), then the placement in the cell.
   */
  rebuild(): void {
    const timeline = this.timeline.filter((frame) => this.owns[frame.index] !== undefined);
    const strength = Number.isFinite(this.ownStrength) ? this.ownStrength : 0;
    const reference = this.referenceColors ? this.owns[this.referenceIndex] : undefined;
    const key = `${this.framesVersion}|${strength}|${this.referenceColors ? this.referenceIndex : -1}|${this.eraseBackground}|${timeline.map((frame) => frame.index).join(',')}`;
    if (key !== this.preparedKey) {
      this.preparedKey = key;
      this.prepared =
        timeline.length === 0
          ? EMPTY_PREPARED
          : prepareFrames(
              timeline.map((frame) => this.owns[frame.index]),
              { strength, reference: reference ? listPalette(reference.pixels) : null, eraseBackground: this.eraseBackground },
            );
    }
    this.place();
  }

  /**
   * One output frame with `pad` tiles of its frame around the cell, for the Align step: `inner` is the cell inside
   * the sprite. Only the container mode knows where the cell sits in the frame; the other modes give the cell alone.
   */
  paddedFrame(position: number, pad: number): { sprite: Sprite; inner: TileBox } | null {
    const frame = this.timeline[position];
    const prepared = this.prepared.frames[position];
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
    const timeline = this.timeline.filter((frame) => this.owns[frame.index] !== undefined);
    const prepared = this.prepared;
    if (prepared.frames.length === 0 || prepared.frames.length !== timeline.length) {
      this.built = prepared.frames.length === 0 ? EMPTY_BUILD : this.built;
      this.version++;
      return;
    }
    const cell = this.cell === 'box' && !this.container ? 'crop' : this.cell;
    const placed = placeFrames(prepared.frames, { cell, offsets: timeline.map((frame) => frame.offset), box: this.container });
    this.built = { frames: placed.frames, cell: placed.cell, kept: prepared.kept };
    this.version++;
  }

  markExported(): void {
    this.exportedVersion = this.editVersion;
  }

  /** Forgets the video and its frames. The stored options stay. */
  clear(): void {
    for (const thumb of this.thumbs) thumb.close();
    this.video?.close();
    this.video = null;
    this.info = null;
    this.keyIndex = 0;
    this.raws = [];
    this.owns = [];
    this.thumbs = [];
    this.ownStrength = Number.NaN;
    this.grid = null;
    this.sampledFitVersion = -1;
    this.displayCache.clear();
    this.framesVersion++;
    this.cursor = 0;
    this.timeline = [];
    this.selectedId = null;
    this.referenceIndex = 0;
    this.referenceChosen = false;
    this.referenceColors = false;
    this.container = null;
    this.clearHistory();
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
  }

  private changed(): void {
    this.editVersion++;
    this.rebuild();
  }
}
