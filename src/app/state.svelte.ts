import type { Stage } from '../core/protocol.ts';
import type { ElasticMode, GridFit, GridOptions, Selection, Sprite } from '../core/types.ts';
import { PARAMS } from '../core/params.ts';
import { pack } from '../core/color.ts';
import type { Camera } from '../ui/camera.ts';
import type { PreviewBackground } from '../ui/clean-scene.ts';
import { EditSession } from './edit-session.ts';
import { CleanEngine, EngineError } from './engine.ts';
import { t } from './i18n.ts';
import * as sfx from './sfx.ts';
import { readStored, writeStored } from './storage.ts';
import { TUNING } from './tuning.ts';

export type Screen = 'drop' | 'grid' | 'clean';
export type Tool = 'view' | 'pencil' | 'eraser' | 'bucket' | 'picker';
export type PresetName = 'off' | 'light' | 'normal' | 'strong';
export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export const PRESET_NAMES: readonly PresetName[] = ['off', 'light', 'normal', 'strong'];
export const SCREENS: readonly Screen[] = ['drop', 'grid', 'clean'];
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

class AppState {
  readonly engine = new CleanEngine();
  readonly session = new EditSession();
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

  muted = $state(sfx.isMuted());
  dragActive = $state(false);
  dropSignal = $state.raw<DropSignal | null>(null);
  exportOpen = $state(false);
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

  toggleMute(): void {
    this.muted = !this.muted;
    sfx.setMuted(this.muted);
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

  async openFiles(files: ArrayLike<File>): Promise<void> {
    if (files.length === 0) return;
    if (files.length > 1) this.toast(t('toast.manyFiles', { count: files.length }), 'info');
    const file = files[0];
    if (!isImageFile(file)) {
      this.rejectDrop(t('toast.notImage'));
      return;
    }
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
    if (this.unsavedEdits && !(await this.confirm(t('confirm.replace.title'), t('confirm.replace.body'), t('confirm.replace.ok')))) return;
    this.loading = true;
    try {
      const loaded = await this.track(this.engine.load(bytes));
      this.source?.bitmap.close();
      this.result?.aligned.close();
      this.source = { name: fileName.replace(/\.[^.]+$/, '') || 'image', width: loaded.width, height: loaded.height, bitmap: loaded.bitmap };
      this.fit = loaded.fit;
      this.fitVersion++;
      this.elastic = 'auto';
      this.fixedPeriod = null;
      this.nudge = { x: 0, y: 0 };
      this.selection = null;
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

  /** Drags a box over one art pixel: the box replaces the manual size and nudge. */
  fitBox(selection: Selection): Promise<GridFit | null> {
    this.selection = selection;
    this.fixedPeriod = null;
    this.nudge = { x: 0, y: 0 };
    return this.requestFit(false);
  }

  detectAuto(): Promise<GridFit | null> {
    this.selection = null;
    this.fixedPeriod = null;
    this.nudge = { x: 0, y: 0 };
    return this.requestFit(false);
  }

  setPixelSize(x: number, y: number): Promise<GridFit | null> {
    this.fixedPeriod = { x, y };
    return this.requestFit(true);
  }

  setElastic(mode: ElasticMode): Promise<GridFit | null> {
    this.elastic = mode;
    return this.requestFit(false);
  }

  setNudge(x: number, y: number): Promise<GridFit | null> {
    this.nudge = { x, y };
    return this.requestFit(true);
  }

  private async requestFit(debounce: boolean): Promise<GridFit | null> {
    const options: GridOptions = { elastic: this.elastic };
    if (this.fixedPeriod) options.fixedPeriod = { ...this.fixedPeriod };
    if (this.nudge.x !== 0 || this.nudge.y !== 0) options.nudge = { ...this.nudge };
    try {
      const fit = await this.track(this.engine.fit(this.selection, options, { debounce }));
      if (!fit) return null;
      this.fit = fit;
      this.fitVersion++;
      return fit;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /** Runs the cleanup and opens the Limpar screen. A result of the same grid is reused, with its edits. */
  async clean(): Promise<void> {
    if (!this.fit || this.cleaning) return;
    if (this.result && this.result.fitVersion === this.fitVersion) {
      this.screen = 'clean';
      return;
    }
    this.cleaning = true;
    try {
      const output = await this.track(this.engine.clean({ strength: PARAMS.palette.presets[this.preset] }));
      this.result?.aligned.close();
      this.session.clear();
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
      this.screen = 'drop';
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

  markExported(): void {
    this.exportedEditVersion = this.editVersion;
  }

  /** After an export: start again with a new image, with nothing left to confirm. */
  startOver(): void {
    this.exportOpen = false;
    this.forgetImage();
  }

  private forgetImage(): void {
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

interface DevHook {
  state(): { screen: string; busy: boolean; fit: GridFit | null; tool: string };
  sprite(): { cols: number; rows: number; pixels: number[] } | null;
  imageToScreen(x: number, y: number): { x: number; y: number };
  tileToScreen(col: number, row: number): { x: number; y: number };
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
  };
}
