import type { CellGrid, Sprite } from '../core/types.ts';
import { buildFrames, type BuiltFrames, type CellMode } from '../core/frames.ts';
import { borderBackground, eraseTiles, listPalette } from '../core/sprite.ts';
import { track } from './analytics.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';
import type { VideoInfo, VideoSource } from './video.ts';

/** One entry of the timeline: a video frame. The same frame can appear more than once, to hold a pose. */
export interface AnimFrame {
  readonly id: number;
  /** The index of the video frame. */
  readonly index: number;
}

export const CELL_MODES: readonly CellMode[] = ['full', 'crop', 'feet'];

const EMPTY_BUILD: BuiltFrames = { frames: [], cell: { cols: 0, rows: 0 }, kept: [] };

function storedNumber(key: string, min: number, max: number, fallback: number): number {
  const value = Number(readStored(key));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function storedCell(): CellMode {
  const value = readStored('animCell');
  return (CELL_MODES as readonly string[]).includes(value ?? '') ? (value as CellMode) : 'crop';
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

  /** New sampled frames. The timeline keeps its video indices; entries past the new count go away. */
  setFrames(raws: Sprite[], owns: Sprite[], thumbs: ImageBitmap[], strength: number, grid: CellGrid, fitVersion: number): void {
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
    const kept = this.timeline.filter((frame) => frame.index < count);
    if (kept.length !== this.timeline.length) this.setTimeline(kept);
    else this.rebuild();
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
    const frame: AnimFrame = { id: this.nextId++, index };
    const list = this.timeline;
    let at = list.length;
    while (at > 0 && list[at - 1].index > index) at--;
    this.setTimeline([...list.slice(0, at), frame, ...list.slice(at)]);
    this.selectedId = frame.id;
    return frame;
  }

  /** "Adicionar intervalo": every `every` video frames from `from` to the last one that is not in the timeline yet. */
  addRange(from: number, every: number): AnimFrame[] {
    const step = Math.max(1, Math.round(every));
    const present = new Set(this.timeline.map((frame) => frame.index));
    const added: AnimFrame[] = [];
    const list = [...this.timeline];
    for (let index = Math.max(0, from); index < this.count; index += step) {
      if (present.has(index)) continue;
      const frame: AnimFrame = { id: this.nextId++, index };
      let at = list.length;
      while (at > 0 && list[at - 1].index > index) at--;
      list.splice(at, 0, frame);
      added.push(frame);
    }
    if (added.length === 0) return added;
    this.setTimeline(list);
    this.selectedId = added[added.length - 1].id;
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
    const frame: AnimFrame = { id: this.nextId++, index: list[at].index };
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
    writeStored('animCell', mode);
    track('option_change', { kind: 'anim_cell', detail: mode });
    this.changed();
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

  /** Builds the output frames of the timeline: one palette, the reference colors, the erase and the common cell. */
  rebuild(): void {
    const owns = this.timeline.map((frame) => this.owns[frame.index]).filter((sprite): sprite is Sprite => sprite !== undefined);
    const reference = this.referenceColors ? this.owns[this.referenceIndex] : undefined;
    this.built =
      owns.length === 0
        ? EMPTY_BUILD
        : buildFrames(owns, {
            strength: Number.isFinite(this.ownStrength) ? this.ownStrength : 0,
            reference: reference ? listPalette(reference.pixels) : null,
            eraseBackground: this.eraseBackground,
            cell: this.cell,
          });
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
