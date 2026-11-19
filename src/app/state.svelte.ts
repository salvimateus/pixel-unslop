import type { SetFitItem, SetGrid, Stage } from '../core/protocol.ts';
import type { CellGrid, ElasticMode, GridFit, GridOptions, Selection, Sprite } from '../core/types.ts';
import { PARAMS } from '../core/params.ts';
import { pack, TRANSPARENT } from '../core/color.ts';
import { matchToReference, type ColorCount } from '../core/palette.ts';
import { exportSprite, referencePalette } from '../core/pipeline.ts';
import { listPalette } from '../core/sprite.ts';
import { isDesktop, monitorWorkArea, setDownloadFile, setInterfaceZoom, type PngFile } from './platform.ts';
import { defaultZoom, nextZoom, snapZoom, storeZoom, storedZoom, type ZoomMove } from './zoom.ts';
import type { Camera } from '../ui/camera.ts';
import type { PreviewBackground } from '../ui/clean-scene.ts';
import { formatOf, track as trackEvent } from './analytics.ts';
import { EditSession } from './edit-session.ts';
import { CleanEngine, EngineError, type FitSetResult, type LoadResult } from './engine.ts';
import { DEFAULT_FIT_INPUTS, ImageSet, pixelSizeOf, type FitInputs, type SetGridMode, type SetGridState, type SetObject, type SetObjectInit } from './image-set.svelte.ts';
import { Animation } from './animation.svelte.ts';
import { isVideoFile, VideoError, VideoSource } from './video.ts';
import { formatDecimal, t } from './i18n.ts';
import * as sfx from './sfx.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';

/**
 * `set-grid` is the Grade step of a set: one piece of the set is open on the Grade screen. `anim-grid`,
 * `anim-frames` and `anim` are the steps of a video animation: its grid on one video frame, the frame pick, and the loop.
 */
export type Screen = 'drop' | 'set-grid' | 'set' | 'grid' | 'clean' | 'anim-grid' | 'anim-frames' | 'anim';
/** The stages of the progress pill: the worker stages, plus the frame extraction of a video. */
export type ProgressStage = Stage | 'frames';
export interface Progress {
  stage: ProgressStage;
  ratio: number;
  /** Done and total items, for a counter. */
  done?: number;
  total?: number;
}
export type Tool = 'view' | 'pencil' | 'eraser' | 'bucket' | 'picker';
/** The tools with a brush size. */
export type BrushTool = 'pencil' | 'eraser';
export interface BrushSizes {
  pencil: number;
  eraser: number;
}
export type PresetName = 'off' | 'light' | 'normal' | 'strong';
export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export const PRESET_NAMES: readonly PresetName[] = ['off', 'light', 'normal', 'strong'];
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ACCEPTED_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
const BACKGROUNDS: readonly PreviewBackground[] = ['checker', 'dark', 'light'];

export interface SourceImage {
  /** File name without the extension. */
  name: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

export interface CleanOutput {
  sprite: Sprite;
  palette: Uint32Array;
  aligned: ImageBitmap;
  /** The fit version that produced this result. */
  fitVersion: number;
}

/** The image whose colors paint the single image. `on` false keeps it but shows the colors of the palette merge. */
export interface ColorReference {
  /** File name without the extension. */
  name: string;
  sprite: Sprite;
  flat: boolean;
  on: boolean;
}

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

/** What the dev hook and the screens need from the active stage. */
export interface StageProbe {
  camera: Camera;
  canvas: HTMLCanvasElement;
}

export interface DropSignal {
  kind: 'ok' | 'bad';
  at: number;
}

/** The brush sizes of the last session, "pencil,eraser"; a missing or broken value gives 1 and 1. */
function storedBrush(): BrushSizes {
  const [pencil, eraser] = (readStored('brush') ?? '').split(',').map(Number);
  const valid = (value: number) => (Number.isInteger(value) && value >= 1 ? Math.min(value, TUNING.clean.brushMax) : 1);
  return { pencil: valid(pencil), eraser: valid(eraser) };
}

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = readStored(key);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function isImageFile(file: File): boolean {
  return ACCEPTED_TYPES.has(file.type) || (file.type === '' && ACCEPTED_EXTENSIONS.test(file.name));
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || 'image';
}

function gridOptions(inputs: FitInputs): GridOptions {
  const options: GridOptions = { elastic: inputs.elastic };
  if (inputs.fixedPeriod) options.fixedPeriod = { ...inputs.fixedPeriod };
  if (inputs.nudge.x !== 0 || inputs.nudge.y !== 0) options.nudge = { ...inputs.nudge };
  return options;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function samePeriod(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < 0.006 && Math.abs(a.y - b.y) < 0.006;
}

function isDefaultInputs(inputs: FitInputs): boolean {
  return inputs.selection === null && inputs.fixedPeriod === null && inputs.grid === null && inputs.nudge.x === 0 && inputs.nudge.y === 0 && inputs.elastic === 'auto';
}

/** A latest-wins merge can be superseded by a newer one; the raw tiles are needed, so ask again. */
const RAW_ATTEMPTS = 4;

class AppState {
  readonly engine = new CleanEngine();
  readonly set = new ImageSet();
  readonly anim = new Animation();
  /** The last file that the animation export wrote, for the dev hook. Plain field. */
  lastAnimExport: { name: string; bytes: Uint8Array } | null = null;
  private readonly singleSession = new EditSession();
  /** The session of the single image, or of the set object that is open on the Grade and Limpar screens. */
  session: EditSession = this.singleSession;
  /** The files that the open set export dialog would save, with its selection, names and options. Null while it is closed. */
  setExportSelection: (() => PngFile[]) | null = null;
  /** The stage that is on screen now. Plain field: the canvas loop reads it, nothing renders from it. */
  stage: StageProbe | null = null;

  screen = $state<Screen>('drop');
  loading = $state(false);
  cleaning = $state(false);
  busyCount = $state(0);
  showProgress = $state(false);
  progress = $state.raw<Progress | null>(null);
  /** Stops the running job of the progress pill (the frame extraction); null when the job cannot stop. */
  progressCancel = $state.raw<(() => void) | null>(null);

  source = $state.raw<SourceImage | null>(null);
  fit = $state.raw<GridFit | null>(null);
  fitVersion = $state(0);
  elastic = $state<ElasticMode>('auto');
  fixedPeriod = $state.raw<{ x: number; y: number } | null>(null);
  nudge = $state.raw<{ x: number; y: number }>({ x: 0, y: 0 });
  selection = $state.raw<Selection | null>(null);
  /** "Minha arte está esticada": the art pixel can be a rectangle, by the shape slider or a marked rectangle. */
  stretched = $state(false);
  /** Grid lines that the user placed with "Ajustar linhas"; null for the fitted grid. */
  manualGrid = $state.raw<CellGrid | null>(null);
  /** Edge strength between source pixel columns and rows of the loaded image, for the snap of a moved line. */
  profiles = $state.raw<{ x: Float64Array; y: Float64Array } | null>(null);

  result = $state.raw<CleanOutput | null>(null);
  /** Stays when a new image opens, until the user removes it. Raw state: replace the object. */
  colorReference = $state.raw<ColorReference | null>(null);
  /** The palette of the reference at one merge strength; a new reference or strength computes it again. */
  private referenceColors: { sprite: Sprite; strength: number; colors: ColorCount[] } | null = null;
  /** Changes when the base sprite changes (clean, merge): the stage rewrites the whole sprite layer. */
  baseVersion = $state(0);
  /** Changes on every edit: the palette and the undo buttons read it. */
  editVersion = $state(0);
  exportedEditVersion = $state(-1);
  tool = $state<Tool>('pencil');
  /** The size of the pencil and of the eraser, in grid squares; each tool keeps its own. */
  brush = $state<BrushSizes>(storedBrush());
  ink = $state<number>(pack(0, 0, 0));
  previewBg = $state<PreviewBackground>(stored('previewBg', BACKGROUNDS, 'checker'));
  showTileGrid = $state(false);
  preset = $state<PresetName>(stored('preset', PRESET_NAMES, 'normal'));
  /** Lossless PNG optimization of every export, a stored convenience. */
  optimizePng = $state(readStored('optimizePng') !== 'off');

  muted = $state(sfx.isMuted());
  dragActive = $state(false);
  dropSignal = $state.raw<DropSignal | null>(null);
  exportOpen = $state(false);
  setExportOpen = $state(false);
  animExportOpen = $state(false);
  /** The set object that is open in the worker: on the Grade step of the set, or on the Limpar screen. Null otherwise. */
  editingId = $state<number | null>(null);
  /** The images of a new set are loading: the stepper already shows the steps of a set. */
  startingSet = $state(false);
  /** The set has a result: "Limpar tudo!" ran once since the set started. */
  setCleaned = $state(false);
  /** The worker rejected the grid that the user placed by hand: the grid on screen is not the grid of the fit. */
  gridRejected = $state(false);
  private editEntryVersion = 0;
  private editEntryFitVersion = $state(0);
  /** A grid of the set changed, or a piece came in, after the last "Limpar tudo!". */
  private setGridChanged = $state(false);
  aboutOpen = $state(false);
  toasts = $state<ToastItem[]>([]);
  confirmRequest = $state.raw<ConfirmRequest | null>(null);

  private toastId = 0;
  /** The video frame that the Grade step of an animation should show; the loads follow the newest one. */
  private keyTarget = 0;
  private keyLoop: Promise<boolean> | null = null;
  /** The desktop window controls its interface zoom; in a browser, the browser does. */
  zoomAvailable = $state(isDesktop);
  /** The interface zoom in percent, and the zoom of Ctrl + 0. */
  zoomPercent = $state(100);
  zoomDefault = $state<number>(TUNING.ui.zoom.default);
  /** Changes on each zoom change or chip click: the indicator shows again. */
  zoomShownAt = $state(0);
  private zoomErrorShown = false;

  constructor() {
    this.engine.onProgress((stage, ratio) => {
      this.progress = { stage, ratio };
    });
  }

  get busy(): boolean {
    return this.busyCount > 0;
  }

  /** Edits that were not exported yet. A new image asks before it replaces them. */
  get unsavedEdits(): boolean {
    return this.session.hasEdits && this.editVersion !== this.exportedEditVersion;
  }

  get editingObject(): SetObject | null {
    return this.editingId === null ? null : this.set.find(this.editingId);
  }

  /** Set changes, or edits of the open object, that no export has written yet. */
  get setUnexported(): boolean {
    return this.set.unexported || (this.editingId !== null && this.editVersion !== this.editEntryVersion);
  }

  /**
   * The Grade step of a set needs "Limpar tudo!": no result yet, a grid changed, a new piece, or a typed shared
   * size that some pieces do not have. Otherwise its primary button only goes back to the set.
   */
  get setGridPending(): boolean {
    if (!this.setCleaned || this.setGridChanged) return true;
    const open = this.editingObject;
    if (this.screen === 'set-grid' && open && !open.reference && this.fitVersion !== this.editEntryFitVersion) return true;
    return this.staleSharedPieces().length > 0;
  }

  private get strength(): number {
    return PARAMS.palette.presets[this.preset];
  }

  /** Desktop only, before the first paint: the zoom that the user kept, else the default that fits the monitor. */
  async startZoom(): Promise<void> {
    if (!isDesktop) return;
    this.zoomDefault = defaultZoom(await monitorWorkArea());
    this.zoomPercent = storedZoom(this.zoomDefault);
    // A failure here keeps the zoom of the window; the first change tells the user.
    await setInterfaceZoom(this.zoomPercent / 100, TUNING.ui.minViewport);
  }

  /** Ctrl + "+", "-" or "0", or a button of the zoom indicator: the next zoom step, kept for the next start. */
  async changeZoom(move: ZoomMove): Promise<void> {
    if (!this.zoomAvailable) return;
    const before = this.zoomPercent;
    const next = nextZoom(before, move, this.zoomDefault);
    this.zoomPercent = next;
    this.zoomShownAt = performance.now();
    // The dev preview of the indicator has no window to zoom.
    if (!isDesktop) return;
    if (!(await setInterfaceZoom(next / 100, TUNING.ui.minViewport))) {
      if (this.zoomPercent === next) this.zoomPercent = before;
      if (!this.zoomErrorShown) this.toast(t('zoom.failed'), 'error');
      this.zoomErrorShown = true;
      return;
    }
    storeZoom(next);
  }

  /** Shows the zoom indicator with no change, from the chip of the header. */
  showZoom(): void {
    if (this.zoomAvailable) this.zoomShownAt = performance.now();
  }

  /** Dev only: shows the zoom indicator and the chip in a browser, at a zoom that changes nothing. */
  previewZoom(percent: number): void {
    this.zoomAvailable = true;
    this.zoomPercent = snapZoom(percent);
    this.zoomShownAt = performance.now();
  }

  /** The largest brush for the sprite on the Limpar screen: TUNING.clean.brushMax, or its larger side. */
  get brushLimit(): number {
    const sprite = this.result?.sprite;
    return sprite ? Math.max(1, Math.min(TUNING.clean.brushMax, Math.max(sprite.cols, sprite.rows))) : TUNING.clean.brushMax;
  }

  /** The size of a brush tool, inside 1 and the limit of the sprite. Returns the size in use. */
  setBrush(tool: BrushTool, size: number): number {
    const next = Math.round(Math.min(this.brushLimit, Math.max(1, size)));
    if (next !== this.brush[tool]) {
      this.brush = { ...this.brush, [tool]: next };
      writeStored('brush', `${this.brush.pencil},${this.brush.eraser}`);
    }
    return next;
  }

  toggleMute(): void {
    this.muted = !this.muted;
    sfx.setMuted(this.muted);
    trackEvent('sound_toggle', { detail: !this.muted });
  }

  setOptimizePng(on: boolean): void {
    this.optimizePng = on;
    writeStored('optimizePng', on ? 'on' : 'off');
    trackEvent('option_change', { kind: 'optimize_png', detail: on });
  }

  setPreviewBackground(value: PreviewBackground): void {
    this.previewBg = value;
    writeStored('previewBg', value);
    trackEvent('option_change', { kind: 'preview_background', detail: value });
  }

  toast(text: string, kind: ToastKind = 'info'): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, text, kind }].slice(-TUNING.ui.maxToasts);
    setTimeout(() => this.dismissToast(id), kind === 'error' ? TUNING.ui.toastErrorMs : TUNING.ui.toastMs);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  confirm(title: string, body: string, confirmLabel: string): Promise<boolean> {
    this.confirmRequest?.resolve(false);
    return new Promise((resolve) => {
      this.confirmRequest = {
        title,
        body,
        confirmLabel,
        resolve: (ok) => {
          this.confirmRequest = null;
          resolve(ok);
        },
      };
    });
  }

  errorText(error: unknown): string {
    if (error instanceof EngineError) return t(`error.${error.code}`, { min: PARAMS.limits.minSide });
    return t('error.internal');
  }

  /** Shows an error and returns to the drop screen when the worker lost the image. */
  fail(error: unknown): void {
    trackEvent('app_error', { kind: error instanceof EngineError ? error.code : 'internal', screen: this.screen });
    sfx.play('error');
    this.toast(this.errorText(error), 'error');
    if (error instanceof EngineError && error.code === 'no-image') this.forgetImage();
  }

  async track<T>(work: Promise<T>): Promise<T> {
    this.busyCount++;
    const timer = setTimeout(() => {
      if (this.busyCount > 0) this.showProgress = true;
    }, TUNING.ui.progressDelayMs);
    try {
      return await work;
    } finally {
      clearTimeout(timer);
      this.busyCount--;
      if (this.busyCount === 0) {
        this.showProgress = false;
        this.progress = null;
      }
    }
  }

  /**
   * Two or more images make a set; while a set exists, new images join it. One image keeps the single flow,
   * unless `asSet` says that the user chose the set entry.
   */
  async openFiles(files: ArrayLike<File>, asSet = false): Promise<void> {
    const list = Array.from(files);
    if (list.length === 0) return;
    const videos = list.filter(isVideoFile);
    if (videos.length > 0) {
      if (list.length === 1) await this.openVideo(videos[0]);
      else this.rejectDrop(t('toast.videoAlone'));
      return;
    }
    const images = list.filter(isImageFile);
    if (images.length === 0) {
      this.rejectDrop(t('toast.notImage'));
      return;
    }
    if (images.length < list.length) this.toast(t('toast.skippedFiles', { count: list.length - images.length }), 'info');
    if (asSet || this.set.active || images.length > 1) {
      await this.addToSet(images);
      return;
    }
    const file = images[0];
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      this.rejectDrop(t('error.read'));
      return;
    }
    await this.openBytes(bytes, file.name);
  }

  async openBytes(bytes: ArrayBuffer, fileName: string): Promise<void> {
    if (this.loading) return;
    if (this.set.active) {
      await this.addToSet([new File([bytes], fileName)]);
      return;
    }
    if (this.unsavedEdits && !(await this.confirm(t('confirm.replace.title'), t('confirm.replace.body'), t('confirm.replace.ok')))) return;
    if (!(await this.leaveAnimFor())) return;
    this.loading = true;
    try {
      const loaded = await this.track(this.engine.load(bytes));
      this.adoptImage(loaded, baseName(fileName));
      trackEvent('image_open', { kind: 'single', format: formatOf(fileName), width: loaded.width, height: loaded.height });
      sfx.play('drop');
      this.dropSignal = { kind: 'ok', at: performance.now() };
      if (this.screen === 'drop' && !prefersReducedMotion()) await wait(TUNING.ui.loadPopMs);
      this.screen = 'grid';
    } catch (error) {
      this.rejectDrop(this.errorText(error));
    } finally {
      this.loading = false;
    }
  }

  /** A freshly loaded image becomes the open image, with the automatic grid and no result. */
  private adoptImage(loaded: LoadResult, name: string): void {
    this.source?.bitmap.close();
    this.result?.aligned.close();
    this.profiles = loaded.profiles;
    this.manualGrid = null;
    this.gridRejected = false;
    this.source = { name, width: loaded.width, height: loaded.height, bitmap: loaded.bitmap };
    this.fit = loaded.fit;
    this.fitVersion++;
    this.elastic = 'auto';
    this.fixedPeriod = null;
    this.nudge = { x: 0, y: 0 };
    this.selection = null;
    this.stretched = false;
    this.result = null;
    this.session.clear();
    this.baseVersion++;
    this.editVersion++;
    this.exportOpen = false;
  }

  private rejectDrop(text: string): void {
    trackEvent('app_error', { kind: 'open_rejected', screen: this.screen });
    sfx.play('error');
    this.toast(text, 'error');
    this.dropSignal = { kind: 'bad', at: performance.now() };
  }

  /** Grid lines placed by hand are replaced only after the user agrees. */
  private async dropManualGrid(): Promise<boolean> {
    if (!this.manualGrid) return true;
    if (!(await this.confirm(t('confirm.manualGrid.title'), t('confirm.manualGrid.body'), t('confirm.manualGrid.ok')))) return false;
    this.manualGrid = null;
    this.gridRejected = false;
    return true;
  }

  /** Grid lines placed by hand become the fit. A burst of edits sends only the last one. */
  async setManualGrid(grid: CellGrid): Promise<GridFit | null> {
    this.manualGrid = grid;
    try {
      const fit = await this.track(this.engine.setGrid(grid, { debounce: true }));
      if (!fit || this.manualGrid !== grid) return null;
      this.fit = fit;
      this.fitVersion++;
      this.gridRejected = false;
      return fit;
    } catch (error) {
      if (this.manualGrid !== grid) return null;
      // The worker keeps its earlier fit: "Limpar!" stays blocked until the grid on screen is valid again.
      if (error instanceof EngineError && error.code === 'no-image') {
        this.fail(error);
        return null;
      }
      this.gridRejected = true;
      sfx.play('error');
      this.toast(error instanceof EngineError && error.code === 'too-many-cells' ? this.errorText(error) : t('grid.rejected'), 'error');
      return null;
    }
  }

  /** Back to the grid that the fit gives for the current inputs. */
  restoreGrid(): Promise<GridFit | null> {
    this.manualGrid = null;
    this.gridRejected = false;
    return this.requestFit(false);
  }

  /** Drags a box over one art pixel: the box replaces the manual size and nudge. */
  async fitBox(selection: Selection): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
    this.selection = selection;
    this.fixedPeriod = null;
    this.nudge = { x: 0, y: 0 };
    trackEvent('grid_change', { kind: 'mark_box', screen: this.screen });
    const fit = await this.requestFit(false);
    if (fit) this.shareSize({ x: round2(fit.axes.x.period), y: round2(fit.axes.y.period) });
    return fit;
  }

  /** In "Uma grade para todas" of a set, the joint pixel size of all pieces is detected again. */
  async detectAuto(): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
    trackEvent('grid_change', { kind: 'auto', screen: this.screen });
    if (this.sharedGridStep) {
      sfx.play('tick');
      if (!(await this.refitSet({ mode: 'shared', period: null, typed: false }))) return null;
      return this.reopenGridObject();
    }
    this.selection = null;
    this.fixedPeriod = null;
    this.nudge = { x: 0, y: 0 };
    return this.requestFit(false);
  }

  /** "Usar N px" of the size notice: the other size that the edges show, with no marked square. */
  async useSuggestedSize(period: { x: number; y: number }): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
    const size = { x: round2(period.x), y: round2(period.y) };
    trackEvent('grid_change', { kind: 'suggested_size', detail: size.x, screen: this.screen });
    this.selection = null;
    this.fixedPeriod = size;
    this.shareSize(size);
    return this.requestFit(false);
  }

  /** Removes the marked square: the size stays, and the grid goes back to its automatic position. */
  async clearMark(): Promise<GridFit | null> {
    if (!this.selection || !this.fit) return null;
    if (!(await this.dropManualGrid())) return null;
    const setPeriod = this.sharedGridStep ? this.set.grid.period : null;
    this.fixedPeriod = setPeriod ? { ...setPeriod } : (this.fixedPeriod ?? { x: round2(this.fit.axes.x.period), y: round2(this.fit.axes.y.period) });
    this.selection = null;
    return this.requestFit(false);
  }

  async setPixelSize(x: number, y: number): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
    this.fixedPeriod = { x, y };
    this.shareSize({ x, y });
    return this.requestFit(true);
  }

  /** The Grade step of a set in "Uma grade para todas": the size of the open piece is the size of all pieces. */
  private get sharedGridStep(): boolean {
    return this.screen === 'set-grid' && this.set.grid.mode === 'shared' && !(this.editingObject?.reference ?? true);
  }

  /** A size set on the open piece becomes the typed size of the set; the other pieces take it at "Limpar tudo!". */
  private shareSize(period: { x: number; y: number }): void {
    if (!this.sharedGridStep) return;
    this.set.grid = { mode: 'shared', period: { ...period }, typed: true };
    this.set.touch();
  }

  async setElastic(mode: ElasticMode): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
    this.elastic = mode;
    trackEvent('grid_change', { kind: 'elastic', detail: mode, screen: this.screen });
    return this.requestFit(false);
  }

  async setNudge(x: number, y: number): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
    this.nudge = { x, y };
    return this.requestFit(true);
  }

  private fitInputs(): FitInputs {
    return { selection: this.selection, fixedPeriod: this.fixedPeriod, grid: this.manualGrid, nudge: this.nudge, elastic: this.elastic };
  }

  private async requestFit(debounce: boolean): Promise<GridFit | null> {
    try {
      const fit = await this.track(this.engine.fit(this.selection, gridOptions(this.fitInputs()), { debounce }));
      if (!fit) return null;
      this.fit = fit;
      this.fitVersion++;
      return fit;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /**
   * Runs the cleanup and opens the Limpar screen. A result of the same grid is reused, with its edits. A new
   * grid clears the edits of the single image; a set object keeps them while its grid keeps its size.
   */
  async clean(): Promise<void> {
    if (!this.fit || this.cleaning) return;
    if (this.gridRejected) {
      sfx.play('error');
      this.toast(t('grid.rejected'), 'error');
      return;
    }
    if (this.result && this.result.fitVersion === this.fitVersion) {
      this.screen = 'clean';
      return;
    }
    this.cleaning = true;
    try {
      const output = await this.track(this.engine.clean({ strength: PARAMS.palette.presets[this.preset] }));
      this.result?.aligned.close();
      if (this.editingId === null) this.session.clear();
      const base = this.baseOf(output.sprite);
      this.session.setBase(base);
      this.result = { ...output, fitVersion: this.fitVersion };
      this.exportedEditVersion = -1;
      this.baseVersion++;
      this.editVersion++;
      const ink = base === output.sprite ? output.palette[0] : listPalette(base.pixels)[0]?.color;
      if (ink !== undefined) this.ink = ink;
      this.tool = 'pencil';
      this.screen = 'clean';
      trackEvent('clean_run', {
        kind: this.editingId === null ? 'single' : 'set_piece',
        detail: this.preset,
        width: output.sprite.cols,
        height: output.sprite.rows,
        count: output.palette.length,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.cleaning = false;
    }
  }

  async applyPreset(name: PresetName): Promise<void> {
    this.preset = name;
    writeStored('preset', name);
    trackEvent('option_change', { kind: 'preset', detail: name, screen: this.screen });
    if (this.anim.active) {
      // The Grade step of the animation only keeps the choice: the frames merge again at the next step.
      if (this.screen !== 'anim-grid') await this.refreshAnim();
      return;
    }
    if (this.screen === 'set') {
      await this.refreshSet();
      return;
    }
    if (!this.result) return;
    try {
      const output = await this.track(this.engine.merge({ strength: PARAMS.palette.presets[name] }, { debounce: true }));
      if (!output || !this.result) return;
      this.session.setBase(this.baseOf(output.sprite));
      this.result = { ...this.result, sprite: output.sprite, palette: output.palette };
      this.baseVersion++;
      this.editVersion++;
    } catch (error) {
      this.fail(error);
    }
  }

  /** Reads a reference image and paints the single image with its colors. The old reference stays on a failure. */
  async loadColorReference(files: ArrayLike<File>): Promise<void> {
    const list = Array.from(files);
    if (list.length === 0 || this.loading) return;
    const file = list.find(isImageFile);
    if (!file) {
      sfx.play('error');
      this.toast(t('toast.notImage'), 'error');
      return;
    }
    this.loading = true;
    try {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        sfx.play('error');
        this.toast(t('error.read'), 'error');
        return;
      }
      const { sprite, flat } = await this.track(this.engine.reference(bytes));
      if (this.paletteOfReference({ sprite, flat }).length === 0) {
        sfx.play('error');
        this.toast(t('toast.referenceEmpty'), 'error');
        return;
      }
      const name = baseName(file.name);
      this.colorReference = { name, sprite, flat, on: true };
      this.rebase();
      trackEvent('color_reference', { kind: 'load', format: formatOf(file.name), width: sprite.cols, height: sprite.rows });
      sfx.play('drop');
      this.toast(t('toast.referenceApplied', { name }), 'success');
    } catch (error) {
      this.fail(error);
    } finally {
      this.loading = false;
    }
  }

  setColorReferenceOn(on: boolean): void {
    const reference = this.colorReference;
    if (!reference || reference.on === on) return;
    this.colorReference = { ...reference, on };
    this.rebase();
  }

  clearColorReference(): void {
    if (!this.colorReference) return;
    this.colorReference = null;
    this.referenceColors = null;
    sfx.play('erase');
    this.rebase();
  }

  /** The base of the single image: the merged sprite, painted with the reference colors when the reference is on. */
  private baseOf(sprite: Sprite): Sprite {
    const reference = this.colorReference;
    if (!reference || !reference.on || this.editingId !== null) return sprite;
    return matchToReference(sprite, this.paletteOfReference(reference));
  }

  private paletteOfReference(reference: { sprite: Sprite; flat: boolean }): ColorCount[] {
    const strength = this.strength;
    const cached = this.referenceColors;
    if (cached && cached.sprite === reference.sprite && cached.strength === strength) return cached.colors;
    const colors = referencePalette(reference, { strength });
    this.referenceColors = { sprite: reference.sprite, strength, colors };
    return colors;
  }

  /** The reference changed: the single image takes its new base at once, with its edits. */
  private rebase(): void {
    if (!this.result || this.editingId !== null) return;
    const before = this.session.composed();
    this.session.setBase(this.baseOf(this.result.sprite));
    this.followInk(before.pixels, this.session.composed().pixels);
    this.baseVersion++;
    this.editVersion++;
  }

  /** The ink follows the recolor: it takes the new color of the first tile that had it. A custom ink stays. */
  private followInk(before: Uint32Array, after: Uint32Array): void {
    const ink = this.ink;
    if (ink === TRANSPARENT || after.includes(ink)) return;
    const index = before.indexOf(ink);
    if (index >= 0 && index < after.length) this.ink = after[index];
  }

  /** Navigation of the stepper and the back buttons. */
  async goTo(target: Screen): Promise<void> {
    if (target === this.screen) return;
    if (this.anim.active) {
      await this.goToAnim(target);
      return;
    }
    if (target === 'drop') {
      if (this.set.active) {
        await this.leaveSet();
        return;
      }
      this.screen = 'drop';
      return;
    }
    if (target === 'set-grid') {
      await this.backToSetGrid();
      return;
    }
    if (target === 'set') {
      if (this.screen === 'set-grid') await this.cleanSet();
      else await this.returnToSet();
      return;
    }
    if (!this.source) return;
    if (target === 'grid') {
      if (this.screen === 'clean' && this.session.hasEdits) {
        const ok = await this.confirm(t('confirm.leave.title'), t('confirm.leave.body'), t('confirm.leave.ok'));
        if (!ok) return;
      }
      this.screen = 'grid';
      return;
    }
    await this.clean();
  }

  /** The tiles of the loaded image before the palette merge: a merge with strength 0 changes no color. */
  private async readRaw(): Promise<Sprite> {
    for (let attempt = 0; attempt < RAW_ATTEMPTS; attempt++) {
      const reply = await this.engine.merge({ strength: 0 });
      if (reply) return reply.sprite;
    }
    throw new EngineError('internal', 'the raw tiles did not arrive');
  }

  /** The own merge of each raw at one strength, asked again when a newer merge superseded it. */
  private async ownMerges(raws: Sprite[], strength: number): Promise<Sprite[]> {
    for (let attempt = 0; attempt < RAW_ATTEMPTS; attempt++) {
      const owns = await this.engine.mergeOwn(raws, { strength });
      if (owns) return owns;
    }
    throw new EngineError('internal', 'the color merge did not arrive');
  }

  /** The set fit of several images, asked again when a newer set fit superseded it. */
  private async fitImages(images: readonly ArrayBuffer[], grid: SetGrid): Promise<FitSetResult> {
    for (let attempt = 0; attempt < RAW_ATTEMPTS; attempt++) {
      const result = await this.engine.fitSet(images, grid);
      if (result) return result;
    }
    throw new EngineError('internal', 'the grid of the set did not arrive');
  }

  /** The request grid of a set grid state: a typed size is used exactly. */
  private gridRequest(grid: SetGridState): SetGrid {
    if (grid.mode === 'own') return { kind: 'own' };
    if (grid.typed && grid.period) return { kind: 'fixed', period: { ...grid.period } };
    return { kind: 'shared' };
  }

  /** The grid inputs that make "Editar" open a piece with the grid it has in the set. */
  private inputsFor(fit: GridFit, mode: SetGridMode): FitInputs {
    if (mode === 'own') return { ...DEFAULT_FIT_INPUTS };
    return { ...DEFAULT_FIT_INPUTS, fixedPeriod: { x: fit.axes.x.period, y: fit.axes.y.period } };
  }

  /**
   * Adds images to the set, or starts a set. A new set fits all images together and takes the grid mode that
   * the core suggests. References always keep their own automatic grid. New pieces open on the Grade step, so
   * the user checks their grid before the cleanup; a reference added to the result stays on the result.
   */
  private async addToSet(files: readonly File[], asReference = false): Promise<void> {
    if (this.loading) return;
    const previous = this.editingId;
    if (this.editingId !== null && !(await this.leaveOpenObject())) return;
    const starting = !this.set.active;
    if (starting && this.unsavedEdits && !(await this.confirm(t('confirm.replace.title'), t('confirm.replace.body'), t('confirm.replace.ok')))) return;
    if (starting && !(await this.leaveAnimFor())) return;
    const max = TUNING.set.maxObjects;
    const room = max - this.set.objects.length;
    if (room <= 0) {
      this.rejectDrop(t('toast.setFull', { max }));
      return;
    }
    if (files.length > room) this.toast(t('toast.setLimit', { max }), 'info');

    this.loading = true;
    this.startingSet = starting;
    try {
      const read: Array<{ name: string; bytes: ArrayBuffer }> = [];
      for (const file of files.slice(0, room)) {
        const name = baseName(file.name);
        try {
          read.push({ name, bytes: await file.arrayBuffer() });
        } catch {
          this.toast(t('toast.setSkip', { name, reason: t('error.read') }), 'error');
        }
      }
      const images = read.map((entry) => entry.bytes);
      let grid = this.set.grid;
      let detected = this.set.detected;
      let result: FitSetResult;
      if (asReference) {
        result = await this.track(this.fitImages(images, { kind: 'own' }));
      } else if (starting) {
        result = await this.track(this.fitImages(images, { kind: 'shared' }));
        detected = result.shared;
        if (result.suggested === 'shared' && result.shared) {
          grid = { mode: 'shared', period: result.shared, typed: false };
        } else {
          grid = { mode: 'own', period: null, typed: false };
          result = await this.track(this.fitImages(images, { kind: 'own' }));
        }
      } else if (grid.mode === 'shared' && grid.period) {
        // New pieces take the pixel size in use, so the pieces already in the set keep their grids.
        result = await this.track(this.fitImages(images, { kind: 'fixed', period: { ...grid.period } }));
      } else {
        result = await this.track(this.fitImages(images, { kind: 'own' }));
      }

      const fitted: Array<{ name: string; bytes: ArrayBuffer; fit: GridFit; raw: Sprite }> = [];
      result.items.forEach((item, i) => {
        if (item.ok) fitted.push({ ...read[i], fit: item.fit, raw: item.raw });
        else this.toast(t('toast.setSkip', { name: read[i].name, reason: this.errorText(new EngineError(item.error, item.detail)) }), 'error');
      });
      if (fitted.length === 0) {
        sfx.play('error');
        this.dropSignal = { kind: 'bad', at: performance.now() };
        return;
      }
      if (starting) {
        this.forgetSingle();
        this.setCleaned = false;
      }
      this.set.grid = grid;
      this.set.detected = detected;
      // The own merge waits for "Limpar tudo!": until then the base of each piece is its raw tiles.
      const inits: SetObjectInit[] = fitted.map((entry) => ({
        ...entry,
        reference: asReference,
        inputs: asReference ? { ...DEFAULT_FIT_INPUTS } : this.inputsFor(entry.fit, grid.mode),
        own: entry.raw,
        ownStrength: Number.NaN,
      }));
      const added = this.set.add(inits);
      trackEvent('image_open', { kind: asReference ? 'set_reference' : starting ? 'set_new' : 'set_add', count: added.length, detail: grid.mode });
      if (!asReference) this.setGridChanged = true;
      if (starting) this.set.markExported();
      sfx.play('drop');
      this.dropSignal = { kind: 'ok', at: performance.now() };
      if (this.screen === 'drop' && !prefersReducedMotion()) await wait(TUNING.ui.loadPopMs);
      if (asReference && this.screen === 'set') {
        if (!(await this.refreshSet())) this.set.rebuild(this.strength);
        return;
      }
      const open = asReference ? (previous ?? added[0].id) : added[0].id;
      if (this.screen === 'set-grid' && this.editingId === open) return;
      if (!asReference && !starting) this.toast(t('toast.setCheckGrid', { count: added.length }), 'info');
      await this.enterGridObject(open);
    } catch (error) {
      this.rejectDrop(this.errorText(error));
    } finally {
      this.loading = false;
      this.startingSet = false;
    }
  }

  /** Stores the object that is open in the worker back in the set, from the Grade step or the Limpar screen. */
  private async leaveOpenObject(): Promise<boolean> {
    if (this.editingId === null) return true;
    if (this.screen === 'set-grid') return this.storeGridObject(false);
    return this.returnToSet();
  }

  /** Opens the file picker result as references of the set. */
  async addReferences(files: ArrayLike<File>): Promise<void> {
    const images = Array.from(files).filter(isImageFile);
    if (images.length === 0) {
      if (files.length > 0) this.rejectDrop(t('toast.notImage'));
      return;
    }
    await this.addToSet(images, true);
  }

  /**
   * Fits all normal pieces again with a new grid state. Asks first when a piece with manual edits gets a grid of
   * another size. Returns false when nothing changed.
   */
  private async refitSet(next: SetGridState, debounce = false): Promise<boolean> {
    const pieces = this.set.pieces;
    if (this.loading) return false;
    if (pieces.length === 0) {
      this.set.grid = next;
      this.set.touch();
      this.setGridChanged = true;
      return true;
    }
    let result: FitSetResult | null;
    try {
      result = await this.track(this.engine.fitSet(pieces.map((piece) => piece.bytes), this.gridRequest(next), { debounce }));
    } catch (error) {
      this.fail(error);
      return false;
    }
    if (!result) return false;
    const failed = result.items.find((item) => !item.ok);
    if (failed && !failed.ok) {
      this.fail(new EngineError(failed.error, failed.detail));
      return false;
    }
    const items = result.items.filter((item): item is Extract<SetFitItem, { ok: true }> => item.ok);
    const losing = pieces.filter((piece, i) => piece.session.hasEdits && (items[i].fit.cols !== piece.fit.cols || items[i].fit.rows !== piece.fit.rows));
    if (losing.length > 0) {
      const names = losing.map((piece) => piece.name).join(', ');
      if (!(await this.confirm(t('confirm.setGrid.title'), t('confirm.setGrid.body', { names }), t('confirm.setGrid.ok')))) return false;
    }
    if (next.mode === 'shared' && !next.typed) {
      this.set.detected = result.shared;
      next = { ...next, period: result.shared };
    }
    this.set.grid = next;
    pieces.forEach((piece, i) => {
      const item = items[i];
      if (item.fit.cols !== piece.fit.cols || item.fit.rows !== piece.fit.rows) piece.session.clear();
      piece.fit = item.fit;
      piece.raw = item.raw;
      piece.inputs = this.inputsFor(item.fit, next.mode);
      piece.own = item.raw;
      piece.ownStrength = Number.NaN;
      piece.session.setBase(item.raw);
    });
    this.set.touch();
    // The Grade step shows no result: the merge and the set stage wait for "Limpar tudo!".
    if (this.screen === 'set-grid') {
      this.setGridChanged = true;
      return true;
    }
    if (!(await this.refreshSet())) this.set.rebuild(this.strength);
    return true;
  }

  /** The grid choice of the set, on its Grade step: the open piece shows its new grid at once. */
  async setGridMode(mode: SetGridMode): Promise<void> {
    const grid = this.set.grid;
    if (mode === grid.mode || this.loading) return;
    trackEvent('grid_change', { kind: 'set_mode', detail: mode, screen: this.screen });
    sfx.play('tick');
    if (!(await this.refitSet({ mode, period: mode === 'shared' && grid.typed ? grid.period : null, typed: mode === 'shared' && grid.typed }))) return;
    if (this.screen === 'set-grid') await this.reopenGridObject();
  }

  /** Turns a piece into a reference (its own tiles, locked) or back into a normal piece. */
  async setReference(id: number, on: boolean): Promise<void> {
    const object = this.set.find(id);
    if (!object || object.reference === on || this.loading) return;
    const grid = this.set.grid;
    const request: SetGrid = on || grid.mode === 'own' || !grid.period ? { kind: 'own' } : { kind: 'fixed', period: { ...grid.period } };
    this.loading = true;
    try {
      const [item] = (await this.track(this.fitImages([object.bytes], request))).items;
      if (!item.ok) throw new EngineError(item.error, item.detail);
      object.reference = on;
      object.fit = item.fit;
      object.raw = item.raw;
      object.inputs = on ? { ...DEFAULT_FIT_INPUTS } : this.inputsFor(item.fit, grid.mode);
      object.ownStrength = Number.NaN;
      if (on && !this.set.hasReferences) this.set.referenceColors = false;
    } catch (error) {
      this.fail(error);
      return;
    } finally {
      this.loading = false;
    }
    sfx.play('tick');
    if (!(await this.refreshSet())) this.set.rebuild(this.strength);
  }

  /**
   * In "Uma grade para todas" with a typed size, fits again each piece whose pixel size is another one. Lines
   * placed by hand stay. Returns false when the user kept the edits that a new grid would drop, or on an error.
   */
  private async syncSharedGrid(): Promise<boolean> {
    const grid = this.set.grid;
    if (grid.mode !== 'shared' || !grid.typed || !grid.period) return true;
    const period = grid.period;
    const stale = this.staleSharedPieces();
    if (stale.length === 0) return true;
    let result: FitSetResult;
    try {
      result = await this.track(this.fitImages(stale.map((piece) => piece.bytes), { kind: 'fixed', period: { ...period } }));
    } catch (error) {
      this.fail(error);
      return false;
    }
    const failed = result.items.find((item) => !item.ok);
    if (failed && !failed.ok) {
      this.fail(new EngineError(failed.error, failed.detail));
      return false;
    }
    const items = result.items.filter((item): item is Extract<SetFitItem, { ok: true }> => item.ok);
    const resized = (i: number) => items[i].fit.cols !== stale[i].fit.cols || items[i].fit.rows !== stale[i].fit.rows;
    const losing = stale.filter((piece, i) => piece.session.hasEdits && resized(i));
    if (losing.length > 0) {
      const names = losing.map((piece) => piece.name).join(', ');
      if (!(await this.confirm(t('confirm.setGrid.title'), t('confirm.setGrid.body', { names }), t('confirm.setGrid.ok')))) return false;
    }
    stale.forEach((piece, i) => {
      const item = items[i];
      piece.fit = item.fit;
      piece.raw = item.raw;
      piece.own = item.raw;
      piece.inputs = this.inputsFor(item.fit, 'shared');
      piece.ownStrength = Number.NaN;
      piece.session.setBase(item.raw);
    });
    this.set.touch();
    this.setGridChanged = true;
    return true;
  }

  /** In "Uma grade para todas" with a typed size: the pieces with no hand grid whose pixel size is another one. */
  private staleSharedPieces(): SetObject[] {
    const grid = this.set.grid;
    if (grid.mode !== 'shared' || !grid.typed || !grid.period) return [];
    const period = grid.period;
    return this.set.pieces.filter((piece) => !piece.inputs.grid && !samePeriod(piece.inputs.fixedPeriod ?? pixelSizeOf(piece.fit), period));
  }

  /** "Limpar tudo!", or "Voltar ao conjunto" when nothing is pending: stores the open piece, gives every piece its grid, cleans all pieces and opens the result. */
  async cleanSet(): Promise<void> {
    if (this.loading || this.cleaning || !this.set.active) return;
    if (!(await this.storeGridObject(false))) return;
    this.cleaning = true;
    try {
      if (!(await this.syncSharedGrid())) return;
      if (!(await this.refreshSet())) this.set.rebuild(this.strength);
    } finally {
      this.cleaning = false;
    }
    if (this.editingId !== null) this.closeEditor();
    this.setCleaned = true;
    this.setGridChanged = false;
    trackEvent('clean_run', { kind: 'set', detail: this.preset, count: this.set.objects.length });
    sfx.play('sweep');
    this.screen = 'set';
  }

  /** "Voltar à grade": from the result or from the Limpar screen of a piece, to the Grade step of the set. */
  private async backToSetGrid(): Promise<void> {
    if (!this.set.active) return;
    if (this.screen === 'clean' && this.editingId !== null && !(await this.returnToSet())) return;
    const id = this.set.selected?.id ?? this.set.objects[0]?.id;
    if (id !== undefined) await this.openSetGrid(id);
  }

  setReferenceColors(on: boolean): void {
    if (on === this.set.referenceColors) return;
    this.set.referenceColors = on;
    this.set.rebuild(this.strength);
  }

  /** Merges again the objects whose own merge is not at the current level, then runs the set stage. */
  private async refreshSet(): Promise<boolean> {
    const strength = this.strength;
    const stale = this.set.objects.filter((object) => !object.reference && object.ownStrength !== strength);
    if (stale.length > 0) {
      let owns: Sprite[] | null;
      try {
        owns = await this.track(this.engine.mergeOwn(stale.map((object) => object.raw), { strength }));
      } catch (error) {
        this.fail(error);
        return false;
      }
      // A newer level superseded this merge: its own refresh runs the stage.
      if (!owns || strength !== this.strength) return false;
      stale.forEach((object, i) => {
        object.own = owns[i];
        object.ownStrength = strength;
        object.session.setBase(owns[i]);
      });
    }
    this.set.rebuild(strength);
    return true;
  }

  setEraseBackground(on: boolean): void {
    if (on === this.set.eraseBackground) return;
    this.set.setEraseBackground(on);
    this.set.rebuild(this.strength);
  }

  /** Loads one set object in the worker and applies its grid inputs. The caller owns the returned bitmap. */
  private loadObject(object: SetObject, inputs: FitInputs): Promise<{ loaded: LoadResult; fit: GridFit }> {
    return this.loadWithInputs(object.bytes.slice(0), inputs);
  }

  /** Loads image bytes in the worker (the buffer is detached) and applies grid inputs. The caller owns the returned bitmap. */
  private async loadWithInputs(bytes: ArrayBuffer, inputs: FitInputs): Promise<{ loaded: LoadResult; fit: GridFit }> {
    const loaded = await this.track(this.engine.load(bytes));
    try {
      let fit = loaded.fit;
      if (!isDefaultInputs(inputs)) {
        const refit = await this.track(this.engine.fit(inputs.selection, gridOptions(inputs)));
        if (!refit) throw new EngineError('internal', 'the grid of the object did not arrive');
        fit = refit;
      }
      if (inputs.grid) {
        const manual = await this.track(this.engine.setGrid(inputs.grid));
        if (!manual) throw new EngineError('internal', 'the grid of the object did not arrive');
        fit = manual;
      }
      return { loaded, fit };
    } catch (error) {
      loaded.bitmap.close();
      throw error;
    }
  }

  /** Makes a loaded set object the open image of the Grade and Limpar screens. */
  private takeObject(object: SetObject, loaded: LoadResult, fit: GridFit, inputs: FitInputs): void {
    this.source?.bitmap.close();
    this.result?.aligned.close();
    this.source = { name: object.name, width: loaded.width, height: loaded.height, bitmap: loaded.bitmap };
    this.fit = fit;
    this.fitVersion++;
    this.selection = inputs.selection;
    this.fixedPeriod = inputs.fixedPeriod;
    this.manualGrid = inputs.grid;
    this.gridRejected = false;
    const period = inputs.fixedPeriod;
    const mark = inputs.selection;
    this.stretched = (period !== null && Math.abs(period.x - period.y) >= 0.01) || (mark !== null && Math.abs(mark.w - mark.h) >= 0.01);
    this.profiles = loaded.profiles;
    this.nudge = inputs.nudge;
    this.elastic = inputs.elastic;
    this.session = object.session;
    this.result = null;
    this.editingId = object.id;
    this.editEntryVersion = this.editVersion;
    this.editEntryFitVersion = this.fitVersion;
    this.set.select(object.id);
  }

  /** "Editar": opens one set object on the Limpar screen, with its grid and its edits. */
  async editObject(id: number): Promise<void> {
    const object = this.set.find(id);
    if (!object || object.reference || this.loading || this.editingId !== null) return;
    this.loading = true;
    try {
      const { loaded, fit } = await this.loadObject(object, object.inputs);
      let output: Awaited<ReturnType<CleanEngine['clean']>>;
      try {
        output = await this.track(this.engine.clean({ strength: this.strength }));
      } catch (error) {
        loaded.bitmap.close();
        throw error;
      }
      this.takeObject(object, loaded, fit, object.inputs);
      this.session.setBase(output.sprite);
      this.result = { ...output, fitVersion: this.fitVersion };
      this.exportedEditVersion = -1;
      this.baseVersion++;
      this.editVersion++;
      this.editEntryVersion = this.editVersion;
      if (output.palette.length > 0) this.ink = output.palette[0];
      this.tool = 'pencil';
      this.screen = 'clean';
    } catch (error) {
      this.fail(error);
    } finally {
      this.loading = false;
    }
  }

  /** The Grade step of a set: shows one piece with its original image and its grid. The piece open before is stored. */
  async openSetGrid(id: number): Promise<void> {
    if (this.loading || this.cleaning || !this.set.find(id)) return;
    if (this.screen === 'set-grid' && this.editingId === id) return;
    if (!(await this.leaveOpenObject())) return;
    this.loading = true;
    try {
      await this.enterGridObject(id);
    } catch (error) {
      this.fail(error);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Loads one piece for the Grade step, with no cleanup. In "Uma grade para todas" with a typed size, a piece
   * that has another size shows the shared size at once.
   */
  private async enterGridObject(id: number): Promise<void> {
    const object = this.set.find(id);
    if (!object) return;
    const grid = this.set.grid;
    let inputs = object.inputs;
    if (!object.reference && grid.mode === 'shared' && grid.typed && grid.period && !inputs.grid && !samePeriod(inputs.fixedPeriod ?? pixelSizeOf(object.fit), grid.period)) {
      inputs = { ...inputs, selection: null, fixedPeriod: { ...grid.period } };
    }
    const { loaded, fit } = await this.loadObject(object, inputs);
    this.takeObject(object, loaded, fit, inputs);
    this.baseVersion++;
    this.screen = 'set-grid';
  }

  /** Loads the open piece of the Grade step again, after a change that gave every piece a new grid. */
  private async reopenGridObject(): Promise<GridFit | null> {
    const id = this.editingId ?? this.set.selected?.id ?? null;
    if (this.editingId !== null) this.closeEditor();
    if (id === null) return null;
    this.loading = true;
    try {
      await this.enterGridObject(id);
      return this.fit;
    } catch (error) {
      this.fail(error);
      return null;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Stores the piece of the Grade step back in the set with its grid and raw tiles. A grid of another size drops
   * the manual edits of the piece, so it asks first. Returns false on a refusal. With `close` false the piece stays
   * open, so the screen never shows an empty stage while the next piece or the result loads.
   */
  private async storeGridObject(close = true): Promise<boolean> {
    const object = this.editingObject;
    if (!object) return true;
    if (this.gridRejected || !this.fit) {
      this.toast(t('grid.rejected'), 'error');
      return false;
    }
    if (object.reference || this.fitVersion === this.editEntryFitVersion) {
      if (close) this.closeEditor();
      return true;
    }
    const resized = this.fit.cols !== object.fit.cols || this.fit.rows !== object.fit.rows;
    if (resized && object.session.hasEdits && !(await this.confirm(t('confirm.objectGrid.title'), t('confirm.objectGrid.body'), t('confirm.objectGrid.ok')))) return false;
    const wasLoading = this.loading;
    this.loading = true;
    try {
      const raw = await this.track(this.readRaw());
      object.fit = this.fit;
      object.inputs = this.fitInputs();
      object.raw = raw;
      object.own = raw;
      object.ownStrength = Number.NaN;
      object.session.setBase(raw);
      this.editEntryFitVersion = this.fitVersion;
      this.set.touch();
      this.setGridChanged = true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.loading = wasLoading;
    }
    if (close) this.closeEditor();
    return true;
  }

  /** Stores the open object back in the set with its grid, raw tiles and edits. Returns false when it stays open. */
  async returnToSet(): Promise<boolean> {
    const object = this.editingObject;
    if (!object || !this.fit) return false;
    if (this.loading) return false;
    const sizeChanged = !this.result || this.result.sprite.cols !== this.fit.cols || this.result.sprite.rows !== this.fit.rows;
    if (sizeChanged && this.session.hasEdits && !(await this.confirm(t('confirm.objectGrid.title'), t('confirm.objectGrid.body'), t('confirm.objectGrid.ok')))) return false;
    this.loading = true;
    const unchanged = this.editVersion === this.editEntryVersion && this.fitVersion === this.editEntryFitVersion && !this.set.unexported;
    const grid = this.set.grid;
    const entryPeriod = object.fit.axes;
    const newPeriod = { x: this.fit.axes.x.period, y: this.fit.axes.y.period };
    const newSize =
      grid.mode === 'shared' &&
      !this.manualGrid &&
      this.fitVersion !== this.editEntryFitVersion &&
      (Math.abs(newPeriod.x - entryPeriod.x.period) > 0.005 || Math.abs(newPeriod.y - entryPeriod.y.period) > 0.005);
    try {
      const strength = this.strength;
      const raw = await this.track(this.readRaw());
      const [own] = await this.track(this.ownMerges([raw], strength));
      object.fit = this.fit;
      object.inputs = this.fitInputs();
      object.raw = raw;
      object.own = own;
      object.ownStrength = strength;
      object.session.setBase(own);
    } catch (error) {
      this.loading = false;
      this.fail(error);
      return false;
    }
    this.loading = false;
    this.closeEditor();
    this.screen = 'set';
    if (!(await this.refreshSet())) this.set.rebuild(this.strength);
    if (unchanged) this.set.markExported();
    if (newSize && (await this.refitSet({ mode: 'shared', period: newPeriod, typed: true }))) {
      const size = newPeriod.x === newPeriod.y ? formatDecimal(newPeriod.x) : `${formatDecimal(newPeriod.x)} × ${formatDecimal(newPeriod.y)}`;
      this.toast(t('toast.sharedSizeApplied', { size }), 'success');
    }
    return true;
  }

  /** Closes the open set object without a worker call; its session keeps the edits made so far. */
  private closeEditor(): void {
    this.source?.bitmap.close();
    this.result?.aligned.close();
    this.source = null;
    this.fit = null;
    this.result = null;
    this.selection = null;
    this.fixedPeriod = null;
    this.nudge = { x: 0, y: 0 };
    this.elastic = 'auto';
    this.manualGrid = null;
    this.profiles = null;
    this.session = this.singleSession;
    this.editingId = null;
    this.baseVersion++;
    this.editVersion++;
    this.exportOpen = false;
  }

  /** The single image goes away when a set starts. */
  private forgetSingle(): void {
    this.source?.bitmap.close();
    this.result?.aligned.close();
    this.source = null;
    this.fit = null;
    this.result = null;
    this.singleSession.clear();
    this.baseVersion++;
    this.editVersion++;
    this.exportOpen = false;
  }

  async removeObject(id: number): Promise<void> {
    const object = this.set.find(id);
    if (!object || this.editingId !== null) return;
    if (object.session.hasEdits && !(await this.confirm(t('confirm.removeObject.title', { name: object.name }), t('confirm.removeObject.body'), t('confirm.removeObject.ok')))) return;
    this.set.remove(id);
    sfx.play('erase');
    if (!this.set.active) {
      this.set.clear();
      this.screen = 'drop';
      return;
    }
    this.set.rebuild(this.strength);
  }

  /** Back to the drop screen: the set is gone, so changes that were not exported ask first. */
  private async leaveSet(): Promise<void> {
    if (this.setUnexported && !(await this.confirm(t('confirm.leaveSet.title'), t('confirm.leaveSet.body'), t('confirm.leaveSet.ok')))) return;
    this.forgetSet();
  }

  private forgetSet(): void {
    if (this.editingId !== null) this.closeEditor();
    this.set.clear();
    this.setExportOpen = false;
    this.screen = 'drop';
  }

  markSetExported(): void {
    this.set.markExported();
  }

  /** After a set export: start again, with nothing left to confirm. */
  startOverSet(): void {
    this.forgetSet();
  }

  markExported(): void {
    this.exportedEditVersion = this.editVersion;
  }

  /** After an export: start again with a new image, with nothing left to confirm. */
  startOver(): void {
    this.exportOpen = false;
    this.forgetImage();
  }

  /**
   * Opens a video as a new animation, on the Grade step of its first frame. Work that was not exported asks
   * first; the work stays when the video fails to open.
   */
  async openVideo(file: File): Promise<void> {
    if (this.loading || this.cleaning) return;
    const unsaved = this.unsavedEdits || this.setUnexported || this.anim.unexported;
    if (unsaved && !(await this.confirm(t('confirm.video.title'), t('confirm.video.body'), t('confirm.video.ok')))) return;
    this.loading = true;
    let video: VideoSource | null = null;
    try {
      video = await this.track(VideoSource.open(file));
      const png = await this.track(video.framePng(0));
      const loaded = await this.track(this.engine.load(png));
      if (this.set.active) this.forgetSet();
      this.anim.clear();
      this.animExportOpen = false;
      this.anim.start(video);
      this.keyTarget = 0;
      this.adoptImage(loaded, video.info.name);
      const info = video.info;
      video = null;
      trackEvent('video_open', { kind: info.exact ? 'exact' : 'estimated', format: formatOf(file.name), width: info.width, height: info.height, count: info.frameCount, detail: info.fps });
      sfx.play('drop');
      this.dropSignal = { kind: 'ok', at: performance.now() };
      if (this.screen === 'drop' && !prefersReducedMotion()) await wait(TUNING.ui.loadPopMs);
      this.screen = 'anim-grid';
      if (!info.exact) this.toast(t('toast.videoFpsGuess', { fps: info.fps }), 'info');
    } catch (error) {
      video?.close();
      if (error instanceof VideoError) {
        trackEvent('app_error', { kind: 'video_rejected', detail: error.problem, screen: this.screen });
        sfx.play('error');
        this.toast(t(`video.error.${error.problem}`, { min: PARAMS.limits.minSide }), 'error');
        this.dropSignal = { kind: 'bad', at: performance.now() };
      } else {
        this.rejectDrop(this.errorText(error));
      }
    } finally {
      this.loading = false;
    }
  }

  /** Before an image replaces the animation: asks when the timeline was not exported, then closes the video. */
  private async leaveAnimFor(): Promise<boolean> {
    if (!this.anim.active) return true;
    if (this.anim.unexported && !(await this.confirm(t('confirm.leaveAnim.title'), t('confirm.leaveAnim.body'), t('confirm.leaveAnim.ok')))) return false;
    this.closeAnim();
    this.screen = 'drop';
    return true;
  }

  /** Back to the drop screen from the animation. */
  private async leaveAnim(): Promise<void> {
    if (this.cleaning) return;
    if (!(await this.leaveAnimFor())) return;
    this.screen = 'drop';
  }

  private closeAnim(): void {
    this.progressCancel?.();
    this.anim.clear();
    this.animExportOpen = false;
    this.forgetSingle();
  }

  /** The stepper and the back buttons inside the animation. */
  private async goToAnim(target: Screen): Promise<void> {
    if (this.cleaning) return;
    if (target === 'drop') {
      await this.leaveAnim();
      return;
    }
    if (target === 'anim-grid') {
      await this.calibrateAt(this.anim.keyIndex);
      return;
    }
    if (target === 'anim-frames') {
      if (this.screen === 'anim-grid') await this.lockAnimGrid();
      else if (this.anim.extracted) this.screen = 'anim-frames';
      return;
    }
    if (target === 'anim') {
      if (this.screen === 'anim-grid' && !(await this.lockAnimGrid())) return;
      if (this.anim.extracted && this.anim.timeline.length > 0) this.screen = 'anim';
    }
  }

  /**
   * The Grade step of the animation shows another video frame. The grid inputs stay, so the grid moves to the
   * new frame as it is. A burst of calls loads only the newest frame. Returns false on a failure.
   */
  setKeyFrame(index: number): Promise<boolean> {
    const info = this.anim.info;
    if (!info) return Promise.resolve(false);
    this.keyTarget = Math.min(info.frameCount - 1, Math.max(0, Math.round(index)));
    if (!this.keyLoop) {
      this.keyLoop = this.runKeyLoop().finally(() => {
        this.keyLoop = null;
      });
    }
    return this.keyLoop;
  }

  private async runKeyLoop(): Promise<boolean> {
    const wasLoading = this.loading;
    this.loading = true;
    try {
      while (this.anim.video && (this.keyTarget !== this.anim.keyIndex || !this.source)) {
        const video = this.anim.video;
        const index = this.keyTarget;
        const inputs = this.fitInputs();
        const png = await this.track(video.framePng(index));
        const { loaded, fit } = await this.loadWithInputs(png, inputs);
        if (this.anim.video !== video) {
          loaded.bitmap.close();
          return false;
        }
        this.takeKeyFrame(loaded, fit, inputs, index);
      }
      return this.source !== null;
    } catch (error) {
      this.keyTarget = this.anim.keyIndex;
      this.fail(error);
      return false;
    } finally {
      this.loading = wasLoading;
    }
  }

  /** A loaded video frame becomes the image of the Grade step, with the grid inputs that were on screen. */
  private takeKeyFrame(loaded: LoadResult, fit: GridFit, inputs: FitInputs, index: number): void {
    this.source?.bitmap.close();
    this.result?.aligned.close();
    this.source = { name: this.anim.info?.name ?? 'video', width: loaded.width, height: loaded.height, bitmap: loaded.bitmap };
    this.fit = fit;
    this.fitVersion++;
    this.selection = inputs.selection;
    this.fixedPeriod = inputs.fixedPeriod;
    this.manualGrid = inputs.grid;
    this.nudge = inputs.nudge;
    this.elastic = inputs.elastic;
    this.profiles = loaded.profiles;
    this.gridRejected = false;
    this.result = null;
    this.baseVersion++;
    this.anim.keyIndex = index;
  }

  /** "Calibrar aqui": the Grade step on one video frame, with the grid of the frames. */
  async calibrateAt(index: number): Promise<void> {
    if (!this.anim.active || this.cleaning) return;
    const ok = await this.setKeyFrame(index);
    if (ok) {
      this.screen = 'anim-grid';
      return;
    }
    // Without a frame on the Grade step and without sampled frames, nothing of the video is left to show.
    if (!this.source && !this.anim.extracted && this.anim.active) {
      this.closeAnim();
      this.screen = 'drop';
    }
  }

  /**
   * "Usar esta grade em todos os frames": samples every video frame with the exact grid lines of the Grade step
   * and opens the Frames screen. The same grid samples nothing again. A long video or a fine grid takes only the
   * first frames that fit the limits. Returns false when the frames are not ready.
   */
  async lockAnimGrid(): Promise<boolean> {
    const anim = this.anim;
    const video = anim.video;
    const fit = this.fit;
    if (!video || !fit || this.cleaning || this.loading) return false;
    if (this.gridRejected) {
      sfx.play('error');
      this.toast(t('grid.rejected'), 'error');
      return false;
    }
    if (anim.sampledWith(fit.grid, this.fitVersion)) {
      if (anim.ownStrength !== this.strength) await this.refreshAnim();
      this.screen = 'anim-frames';
      return true;
    }
    const info = video.info;
    const tilesPerFrame = Math.max(1, fit.cols * fit.rows * 2);
    const fitting = Math.floor(PARAMS.limits.maxFrameTiles / tilesPerFrame);
    const count = Math.min(info.frameCount, PARAMS.limits.maxFrames, fitting);
    if (count <= 0) {
      sfx.play('error');
      this.toast(t('toast.framesTooFine'), 'error');
      return false;
    }
    const grid: CellGrid = { x: fit.grid.x.slice(), y: fit.grid.y.slice() };
    const fitVersion = this.fitVersion;
    const strength = this.strength;
    let cancelled = false;
    this.cleaning = true;
    this.progressCancel = () => {
      cancelled = true;
    };
    this.progress = { stage: 'frames', ratio: 0, done: 0, total: count };
    try {
      const frames = await this.track(this.extractFrames(video, count, grid, strength, () => cancelled));
      if (!frames || anim.video !== video) {
        if (frames) for (const thumb of frames.thumbs) thumb.close();
        else if (cancelled) this.toast(t('toast.framesCancelled'), 'info');
        return false;
      }
      anim.setFrames(frames.raws, frames.owns, frames.thumbs, strength, grid, fitVersion);
      if (count < info.frameCount) this.toast(t('toast.framesLimited', { count, total: info.frameCount }), 'info');
      trackEvent('clean_run', { kind: 'anim', detail: this.preset, width: fit.cols, height: fit.rows, count });
      sfx.play('sweep');
      this.screen = 'anim-frames';
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.cleaning = false;
      this.progressCancel = null;
    }
  }

  /**
   * Samples the first `count` video frames on one grid. The seek of the next frame runs while the worker samples
   * this one. Returns null when cancelled; the bitmaps of a cancelled or failed run are closed.
   */
  private async extractFrames(video: VideoSource, count: number, grid: CellGrid, strength: number, cancelled: () => boolean): Promise<{ raws: Sprite[]; owns: Sprite[]; thumbs: ImageBitmap[] } | null> {
    const raws: Sprite[] = [];
    const owns: Sprite[] = [];
    const thumbs: ImageBitmap[] = [];
    const merge = { strength };
    let pending: Promise<{ raw: Sprite; own: Sprite }> | null = null;
    try {
      for (let i = 0; i <= count; i++) {
        const shot = i < count && !cancelled() ? await video.capture(i, TUNING.anim.monitorPx) : null;
        if (pending) {
          const sample: { raw: Sprite; own: Sprite } = await pending;
          pending = null;
          raws.push(sample.raw);
          owns.push(sample.own);
          this.progress = { stage: 'frames', ratio: owns.length / count, done: owns.length, total: count };
        }
        if (!shot) break;
        if (cancelled() || this.anim.video !== video) {
          shot.frame.close();
          shot.thumb.close();
          break;
        }
        thumbs.push(shot.thumb);
        pending = this.engine.sampleFrame(shot.frame, grid, merge);
      }
    } catch (error) {
      for (const thumb of thumbs) thumb.close();
      // A sample that is still on its way must not reject later with nobody to catch it.
      pending?.catch(() => undefined);
      throw error;
    }
    if (cancelled() || owns.length < count) {
      for (const thumb of thumbs) thumb.close();
      return null;
    }
    return { raws, owns, thumbs };
  }

  /** The frames of the animation merge again at the current cleanup level. */
  private async refreshAnim(): Promise<void> {
    const anim = this.anim;
    const strength = this.strength;
    if (!anim.extracted || anim.ownStrength === strength) return;
    try {
      const owns = await this.track(this.engine.mergeOwn(anim.raws, { strength }));
      // A newer level superseded this merge: its own refresh sets the frames.
      if (!owns || strength !== this.strength || !anim.extracted) return;
      anim.setOwn(owns, strength);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stops the job of the progress pill, when it can stop. */
  cancelProgress(): void {
    this.progressCancel?.();
  }

  markAnimExported(): void {
    this.anim.markExported();
  }

  /** After an animation export: start again with a new file, with nothing left to confirm. */
  startOverAnim(): void {
    this.closeAnim();
    this.screen = 'drop';
  }

  private forgetImage(): void {
    if (this.anim.active) {
      // The worker lost the frame of the Grade step: the sampled frames stay, and the Grade step loads its frame again.
      this.source?.bitmap.close();
      this.result?.aligned.close();
      this.source = null;
      this.fit = null;
      this.result = null;
      this.baseVersion++;
      if (this.anim.extracted) this.screen = this.screen === 'anim' && this.anim.timeline.length > 0 ? 'anim' : 'anim-frames';
      else void this.calibrateAt(this.anim.keyIndex);
      return;
    }
    if (this.set.active) {
      // The worker lost the open object: it goes back to the set as it was before "Editar".
      const object = this.editingObject;
      const onGridStep = this.screen === 'set-grid';
      if (object && !onGridStep) object.session.setBase(object.own);
      if (this.editingId !== null) this.closeEditor();
      if (onGridStep) {
        void this.reopenGridObject();
        return;
      }
      this.set.rebuild(this.strength);
      this.screen = 'set';
      return;
    }
    this.source?.bitmap.close();
    this.result?.aligned.close();
    this.source = null;
    this.fit = null;
    this.result = null;
    this.session.clear();
    this.baseVersion++;
    this.editVersion++;
    this.exportOpen = false;
    this.screen = 'drop';
  }
}

export const app = new AppState();

interface DevSetObject {
  id: number;
  name: string;
  nativeCols: number;
  nativeRows: number;
  cols: number;
  rows: number;
  height: number;
  step: number;
  backgroundKept: boolean;
  reference: boolean;
  pixelSize: { x: number; y: number };
  /** The left edge of the object in the scene, in scene pixels; `place` is the manual one, or null. */
  x: number;
  place: number | null;
  hidden: boolean;
  pixels: number[];
}

interface DevHook {
  state(): { screen: string; busy: boolean; fit: GridFit | null; tool: string; brush: BrushSizes };
  sprite(): { cols: number; rows: number; pixels: number[] } | null;
  imageToScreen(x: number, y: number): { x: number; y: number };
  tileToScreen(col: number, row: number): { x: number; y: number };
  set(): {
    objects: DevSetObject[];
    palette: number[];
    grid: { mode: 'own' | 'shared'; period: { x: number; y: number } | null; typed: boolean };
  } | null;
  /** Client coordinates of the resize handle of a set object. */
  setHandleToScreen(id: number): { x: number; y: number } | null;
  /** Client coordinates of the center of a set object. */
  setObjectToScreen(id: number): { x: number; y: number } | null;
  /** The exact file of a browser download of the set: the open dialog's selection, else every file with its suggested name. */
  setExportBytes(): Promise<{ name: string; base64: string } | null>;
  /** Shows the zoom indicator and the header chip at `percent`, with no zoom applied: the look of the desktop feature. */
  showZoom(percent: number): void;
  /** The state of the video animation, or null without a video. */
  anim(): DevAnim | null;
  /** One output frame of the animation, by its timeline position. */
  animFrame(position: number): { cols: number; rows: number; pixels: number[] } | null;
  /** The exact bytes of the last animation export (the sheet, the ZIP of the browser, or the GIF). */
  animExportBytes(): { name: string; base64: string } | null;
}

interface DevAnim {
  screen: string;
  info: { name: string; width: number; height: number; fps: number; frameCount: number; exact: boolean } | null;
  keyIndex: number;
  sampled: number;
  cursor: number;
  stepSize: number;
  timeline: number[];
  selectedId: number | null;
  fps: number;
  onion: boolean;
  cell: string;
  eraseBackground: boolean;
  referenceColors: boolean;
  referenceIndex: number;
  built: { cols: number; rows: number; count: number; kept: boolean[] };
  unexported: boolean;
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

declare global {
  interface Window {
    __unslop?: DevHook;
  }
}

function toClient(x: number, y: number): { x: number; y: number } {
  const stage = app.stage;
  if (!stage) return { x: Number.NaN, y: Number.NaN };
  const rect = stage.canvas.getBoundingClientRect();
  const p = stage.camera.imageToScreen(x, y);
  return { x: rect.left + p.x, y: rect.top + p.y };
}

function setBox(id: number): { x: number; y: number; w: number; h: number } | null {
  const index = app.set.objects.findIndex((object) => object.id === id);
  return index < 0 ? null : (app.set.layout.boxes[index] ?? null);
}

/** Dev mode only: lets the orchestrator place pointer events and read the result. */
export function installDevHook(): void {
  window.__unslop = {
    state: () => ({ screen: app.screen, busy: app.busy, fit: app.fit, tool: app.tool, brush: { ...app.brush } }),
    sprite: () => {
      if (!app.result) return null;
      const sprite = app.session.composed();
      return { cols: sprite.cols, rows: sprite.rows, pixels: Array.from(sprite.pixels) };
    },
    imageToScreen: (x, y) => toClient(x, y),
    tileToScreen: (col, row) => toClient(col + 0.5, row + 0.5),
    set: () => {
      if (!app.set.active) return null;
      const objects = app.set.objects.map((object) => ({
        id: object.id,
        name: object.name,
        nativeCols: object.prepared?.cols ?? 0,
        nativeRows: object.prepared?.rows ?? 0,
        cols: object.output?.cols ?? 0,
        rows: object.output?.rows ?? 0,
        height: object.height,
        step: object.step,
        backgroundKept: object.backgroundKept,
        reference: object.reference,
        pixelSize: pixelSizeOf(object.fit),
        x: app.set.layout.boxes[app.set.objects.indexOf(object)]?.x ?? 0,
        place: object.place,
        hidden: object.hidden,
        pixels: object.output ? Array.from(object.output.pixels) : [],
      }));
      const grid = app.set.grid;
      return { objects, palette: Array.from(app.set.palette()), grid: { mode: grid.mode, period: grid.period ? { ...grid.period } : null, typed: grid.typed } };
    },
    setHandleToScreen: (id) => {
      const box = setBox(id);
      return box && app.screen === 'set' ? toClient(box.x + box.w, box.y) : null;
    },
    setExportBytes: async () => {
      if (!app.set.active) return null;
      const files = app.setExportSelection?.() ?? app.set.exportFiles().map((file) => ({ name: file.name, bytes: exportSprite(file.sprite, { optimize: app.optimizePng }) }));
      const file = setDownloadFile(files);
      if (!file) return null;
      return { name: file.name, base64: base64Of(file.bytes) };
    },
    showZoom: (percent) => app.previewZoom(percent),
    anim: () => {
      const anim = app.anim;
      if (!anim.active) return null;
      const info = anim.info;
      return {
        screen: app.screen,
        info: info ? { name: info.name, width: info.width, height: info.height, fps: info.fps, frameCount: info.frameCount, exact: info.exact } : null,
        keyIndex: anim.keyIndex,
        sampled: anim.count,
        cursor: anim.cursor,
        stepSize: anim.stepSize,
        timeline: anim.timeline.map((frame) => frame.index),
        selectedId: anim.selectedId,
        fps: anim.fps,
        onion: anim.onion,
        cell: anim.cell,
        eraseBackground: anim.eraseBackground,
        referenceColors: anim.referenceColors,
        referenceIndex: anim.referenceIndex,
        built: { cols: anim.built.cell.cols, rows: anim.built.cell.rows, count: anim.built.frames.length, kept: [...anim.built.kept] },
        unexported: anim.unexported,
      };
    },
    animFrame: (position) => {
      const sprite = app.anim.built.frames[position];
      return sprite ? { cols: sprite.cols, rows: sprite.rows, pixels: Array.from(sprite.pixels) } : null;
    },
    animExportBytes: () => {
      const file = app.lastAnimExport;
      return file ? { name: file.name, base64: base64Of(file.bytes) } : null;
    },
    setObjectToScreen: (id) => {
      const box = setBox(id);
      return box && app.screen === 'set' ? toClient(box.x + box.w / 2, box.y + box.h / 2) : null;
    },
  };
}
