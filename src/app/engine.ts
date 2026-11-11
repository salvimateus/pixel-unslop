import type { EngineReply, EngineRequest, ErrorCode, MergeOptions, SetFitItem, SetGrid, Stage, WorkerMessage } from '../core/protocol.ts';
import type { CellGrid, GridFit, GridOptions, Selection, Sprite } from '../core/types.ts';
import { TUNING } from './tuning.ts';

type RequestType = EngineRequest['type'];
type SuccessReply<T extends RequestType> = Extract<EngineReply, { ok: true; type: T }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<EngineRequest, 'id'>;

/** Only these request types use "latest wins": a slider or a row of level buttons sends many of them. */
type LatestType = 'fit' | 'merge' | 'merge-own' | 'fit-set';

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

export interface LoadResult {
  width: number;
  height: number;
  bitmap: ImageBitmap;
  fit: GridFit;
  /** Edge strength of each boundary between two columns (x) and two rows (y) of source pixels. */
  profiles: { x: Float64Array; y: Float64Array };
}

export interface CleanResult {
  sprite: Sprite;
  palette: Uint32Array;
  aligned: ImageBitmap;
}

export interface MergeResult {
  sprite: Sprite;
  palette: Uint32Array;
}

export interface FitSetResult {
  /** The joint pixel size of all images, or null when none exists. */
  shared: { x: number; y: number } | null;
  suggested: 'own' | 'shared';
  items: SetFitItem[];
}

export type ProgressListener = (stage: Stage, ratio: number, id: number) => void;

interface Pending {
  resolve: (reply: EngineReply) => void;
  reject: (error: Error) => void;
}

interface Debounced {
  timer: ReturnType<typeof setTimeout>;
  send: () => void;
  drop: () => void;
}

export interface CallOptions {
  /** Waits a short time and sends only the last call of a burst (slider input). */
  debounce?: boolean;
}

/** The only door to the core worker. Replies older than the latest fit or merge request are dropped (resolved with null). */
export class CleanEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly latest: Record<LatestType, number> = { fit: 0, merge: 0, 'merge-own': 0, 'fit-set': 0 };
  private readonly debounced: Partial<Record<LatestType, Debounced>> = {};
  private readonly listeners = new Set<ProgressListener>();

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(bytes: ArrayBuffer): Promise<LoadResult> {
    this.dropDebounced('fit');
    this.dropDebounced('merge');
    const reply = await this.request({ type: 'load', bytes }, [bytes]);
    const { width, height, bitmap, fit, profiles } = expect(reply, 'load');
    return { width, height, bitmap, fit, profiles };
  }

  async fit(selection: Selection | null, options: GridOptions, call: CallOptions = {}): Promise<GridFit | null> {
    const reply = await this.requestLatest('fit', { type: 'fit', selection, options }, call);
    return reply ? expect(reply, 'fit').fit : null;
  }

  /** Grid lines placed by hand become the fit of the loaded image. Latest wins together with `fit`. */
  async setGrid(grid: CellGrid, call: CallOptions = {}): Promise<GridFit | null> {
    const copy: CellGrid = { x: grid.x.slice(), y: grid.y.slice() };
    const reply = await this.requestLatest('fit', { type: 'set-grid', grid: copy }, call);
    return reply ? expect(reply, 'fit').fit : null;
  }

  async clean(merge: MergeOptions): Promise<CleanResult> {
    this.flushDebounced('fit');
    this.dropDebounced('merge');
    this.latest.merge = this.nextId;
    const reply = await this.request({ type: 'clean', merge });
    const { sprite, palette, aligned } = expect(reply, 'clean');
    return { sprite, palette, aligned };
  }

  async merge(merge: MergeOptions, call: CallOptions = {}): Promise<MergeResult | null> {
    const reply = await this.requestLatest('merge', { type: 'merge', merge }, call);
    if (!reply) return null;
    const { sprite, palette } = expect(reply, 'merge');
    return { sprite, palette };
  }

  /** The own palette merge of each raw sprite. Needs no loaded image. The raws are copied, so the caller keeps them. */
  async mergeOwn(raws: readonly Sprite[], merge: MergeOptions, call: CallOptions = {}): Promise<Sprite[] | null> {
    const copies = raws.map((raw): Sprite => ({ cols: raw.cols, rows: raw.rows, pixels: raw.pixels.slice() }));
    const reply = await this.requestLatest('merge-own', { type: 'merge-own', raws: copies, merge }, call, copies.map((copy) => copy.pixels.buffer));
    return reply ? expect(reply, 'merge-own').sprites : null;
  }

  /** Fits each image for the set mode, with no loaded image and no change to it. The bytes are copied. */
  async fitSet(images: readonly ArrayBuffer[], grid: SetGrid, call: CallOptions = {}): Promise<FitSetResult | null> {
    const copies = images.map((bytes) => bytes.slice(0));
    const reply = await this.requestLatest('fit-set', { type: 'fit-set', images: copies, grid }, call, copies);
    if (!reply) return null;
    const { shared, suggested, items } = expect(reply, 'fit-set');
    return { shared, suggested, items };
  }

  /** The PNG of a sprite at one image pixel per tile, the only export size. `optimize` makes it smaller with the same pixels. */
  async exportPng(sprite: Sprite, options: { optimize: boolean }): Promise<Uint8Array> {
    const copy: Sprite = { cols: sprite.cols, rows: sprite.rows, pixels: sprite.pixels.slice() };
    const reply = await this.request({ type: 'export', sprite: copy, optimize: options.optimize }, [copy.pixels.buffer]);
    return new Uint8Array(expect(reply, 'export').png);
  }

  private requestLatest(type: LatestType, body: RequestBody, call: CallOptions, transfer: Transferable[] = []): Promise<EngineReply | null> {
    this.dropDebounced(type);
    if (!call.debounce) return this.sendLatest(type, body, transfer);
    return new Promise((resolve, reject) => {
      const send = () => {
        delete this.debounced[type];
        this.sendLatest(type, body, transfer).then(resolve, reject);
      };
      const timer = setTimeout(send, TUNING.ui.engineDebounceMs);
      this.debounced[type] = { timer, send, drop: () => resolve(null) };
    });
  }

  private async sendLatest(type: LatestType, body: RequestBody, transfer: Transferable[] = []): Promise<EngineReply | null> {
    const id = this.nextId;
    this.latest[type] = id;
    const reply = await this.request(body, transfer);
    return id < this.latest[type] ? null : reply;
  }

  private flushDebounced(type: LatestType): void {
    const entry = this.debounced[type];
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.send();
  }

  private dropDebounced(type: LatestType): void {
    const entry = this.debounced[type];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete this.debounced[type];
    entry.drop();
  }

  private request(body: RequestBody, transfer: Transferable[] = []): Promise<EngineReply> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise<EngineReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...body, id } as EngineRequest, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(new EngineError('internal', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../core/worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => this.handleMessage(event.data));
    worker.addEventListener('error', (event) => this.crash(event.message || 'worker error'));
    worker.addEventListener('messageerror', () => this.crash('message could not be read'));
    this.worker = worker;
    return worker;
  }

  private handleMessage(message: WorkerMessage): void {
    if ('type' in message && message.type === 'progress') {
      for (const listener of this.listeners) listener(message.stage, message.ratio, message.id);
      return;
    }
    const reply = message as EngineReply;
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply);
    else entry.reject(new EngineError(reply.error, reply.detail));
  }

  /** A dead worker loses its image. Every open request fails, and the next request starts a new worker. */
  private crash(detail: string): void {
    this.worker?.terminate();
    this.worker = null;
    const open = [...this.pending.values()];
    this.pending.clear();
    for (const entry of open) entry.reject(new EngineError('internal', detail));
  }
}

function expect<T extends RequestType>(reply: EngineReply, type: T): SuccessReply<T> {
  if (reply.ok && reply.type === type) return reply as SuccessReply<T>;
  throw new EngineError('internal', `unexpected reply for ${type}`);
}
