import type { SetFitItem, SetGrid, Stage } from '../core/protocol.ts';
import type { CellGrid, ElasticMode, GridFit, GridOptions, Selection, Sprite } from '../core/types.ts';
import { PARAMS } from '../core/params.ts';
import { pack } from '../core/color.ts';
import { exportSprite } from '../core/pipeline.ts';
import { setDownloadFile, type PngFile } from './platform.ts';
import type { Camera } from '../ui/camera.ts';
import type { PreviewBackground } from '../ui/clean-scene.ts';
import { EditSession } from './edit-session.ts';
import { CleanEngine, EngineError, type FitSetResult, type LoadResult } from './engine.ts';
import { DEFAULT_FIT_INPUTS, ImageSet, pixelSizeOf, type FitInputs, type SetGridMode, type SetGridState, type SetObject, type SetObjectInit } from './image-set.svelte.ts';
import { formatDecimal, t } from './i18n.ts';
import * as sfx from './sfx.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';

/** `set-grid` is the Grade step of a set: one piece of the set is open on the Grade screen. */
export type Screen = 'drop' | 'set-grid' | 'set' | 'grid' | 'clean';
export type Tool = 'view' | 'pencil' | 'eraser' | 'bucket' | 'picker';
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
  progress = $state.raw<{ stage: Stage; ratio: number } | null>(null);

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
  /** Changes when the base sprite changes (clean, merge): the stage rewrites the whole sprite layer. */
  baseVersion = $state(0);
  /** Changes on every edit: the palette and the undo buttons read it. */
  editVersion = $state(0);
  exportedEditVersion = $state(-1);
  tool = $state<Tool>('pencil');
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
  /** The set object that is open in the worker: on the Grade step of the set, or on the Limpar screen. Null otherwise. */
  editingId = $state<number | null>(null);
  /** The images of a new set are loading: the stepper already shows the steps of a set. */
  startingSet = $state(false);
  /** The set has a result: "Limpar tudo!" ran once since the set started. */
  setCleaned = $state(false);
  /** The worker rejected the grid that the user placed by hand: the grid on screen is not the grid of the fit. */
  gridRejected = $state(false);
  private editEntryVersion = 0;
  private editEntryFitVersion = 0;
  aboutOpen = $state(false);
  toasts = $state<ToastItem[]>([]);
  confirmRequest = $state.raw<ConfirmRequest | null>(null);

  private toastId = 0;

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

  private get strength(): number {
    return PARAMS.palette.presets[this.preset];
  }

  toggleMute(): void {
    this.muted = !this.muted;
    sfx.setMuted(this.muted);
  }

  setOptimizePng(on: boolean): void {
    this.optimizePng = on;
    writeStored('optimizePng', on ? 'on' : 'off');
  }

  setPreviewBackground(value: PreviewBackground): void {
    this.previewBg = value;
    writeStored('previewBg', value);
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
    this.loading = true;
    try {
      const loaded = await this.track(this.engine.load(bytes));
      this.source?.bitmap.close();
      this.result?.aligned.close();
      this.profiles = loaded.profiles;
      this.manualGrid = null;
      this.source = { name: baseName(fileName), width: loaded.width, height: loaded.height, bitmap: loaded.bitmap };
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

  private rejectDrop(text: string): void {
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
    const fit = await this.requestFit(false);
    if (fit) this.shareSize({ x: round2(fit.axes.x.period), y: round2(fit.axes.y.period) });
    return fit;
  }

  /** In "Uma grade para todas" of a set, the joint pixel size of all pieces is detected again. */
  async detectAuto(): Promise<GridFit | null> {
    if (!(await this.dropManualGrid())) return null;
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
      this.session.setBase(output.sprite);
      this.result = { ...output, fitVersion: this.fitVersion };
      this.exportedEditVersion = -1;
      this.baseVersion++;
      this.editVersion++;
      if (output.palette.length > 0) this.ink = output.palette[0];
      this.tool = 'pencil';
      this.screen = 'clean';
    } catch (error) {
      this.fail(error);
    } finally {
      this.cleaning = false;
    }
  }

  async applyPreset(name: PresetName): Promise<void> {
    this.preset = name;
    writeStored('preset', name);
    if (this.screen === 'set') {
      await this.refreshSet();
      return;
    }
    if (!this.result) return;
    try {
      const output = await this.track(this.engine.merge({ strength: PARAMS.palette.presets[name] }, { debounce: true }));
      if (!output || !this.result) return;
      this.session.setBase(output.sprite);
      this.result = { ...this.result, sprite: output.sprite, palette: output.palette };
      this.baseVersion++;
      this.editVersion++;
    } catch (error) {
      this.fail(error);
    }
  }

  /** Navigation of the stepper and the back buttons. */
  async goTo(target: Screen): Promise<void> {
    if (target === this.screen) return;
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
    if (this.screen === 'set-grid') return true;
    if (!(await this.refreshSet())) this.set.rebuild(this.strength);
    return true;
  }

  /** The grid choice of the set, on its Grade step: the open piece shows its new grid at once. */
  async setGridMode(mode: SetGridMode): Promise<void> {
    const grid = this.set.grid;
    if (mode === grid.mode || this.loading) return;
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
    const stale = this.set.pieces.filter((piece) => !piece.inputs.grid && !samePeriod(piece.inputs.fixedPeriod ?? pixelSizeOf(piece.fit), period));
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
    return true;
  }

  /** "Limpar tudo!": stores the open piece, gives every piece its grid, cleans all pieces and opens the result. */
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
  private async loadObject(object: SetObject, inputs: FitInputs): Promise<{ loaded: LoadResult; fit: GridFit }> {
    const loaded = await this.track(this.engine.load(object.bytes.slice(0)));
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

  private forgetImage(): void {
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
  pixels: number[];
}

interface DevHook {
  state(): { screen: string; busy: boolean; fit: GridFit | null; tool: string };
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
    state: () => ({ screen: app.screen, busy: app.busy, fit: app.fit, tool: app.tool }),
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
      let binary = '';
      for (let i = 0; i < file.bytes.length; i += 0x8000) binary += String.fromCharCode(...file.bytes.subarray(i, i + 0x8000));
      return { name: file.name, base64: btoa(binary) };
    },
    setObjectToScreen: (id) => {
      const box = setBox(id);
      return box && app.screen === 'set' ? toClient(box.x + box.w / 2, box.y + box.h / 2) : null;
    },
  };
}
