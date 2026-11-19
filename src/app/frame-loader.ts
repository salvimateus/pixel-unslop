import type { CellGrid, Sprite } from '../core/types.ts';
import type { Animation, SampledFrame } from './animation.svelte.ts';
import type { CleanEngine } from './engine.ts';
import { TUNING } from './tuning.ts';
import { isAbortError, type VideoSource } from './video.ts';

type JobKind = 'nav' | 'pinned' | 'prefetch';

interface Job {
  index: number;
  kind: JobKind;
}

/**
 * Fills the frame store of an animation from its video, one frame at a time: first the frame of the cursor (the
 * newest cursor wins), then the pinned frames that are missing, then, after a short rest, a few frames ahead in the
 * step direction. The seek of the next frame runs while the worker samples the last one; a frame that is no longer
 * wanted when its turn comes is not sampled.
 */
export class FrameLoader {
  private running = false;
  private paused = 0;
  private direction: -1 | 1 = 1;
  private lastCursor = 0;
  private resting = false;
  private restTimer = 0;
  /** The frames whose capture or sample is on its way. */
  private readonly busy = new Set<number>();
  private abort: AbortController | null = null;
  private current: Job | null = null;
  private readonly listeners = new Set<() => void>();

  private readonly anim: Animation;
  private readonly engine: CleanEngine;
  private readonly fail: (error: unknown) => void;

  constructor(anim: Animation, engine: CleanEngine, fail: (error: unknown) => void) {
    this.anim = anim;
    this.engine = engine;
    this.fail = fail;
    anim.onneed = () => this.need();
  }

  /** The cursor, the timeline or the grid changed: the loads follow. */
  need(): void {
    const anim = this.anim;
    const cursor = anim.cursor;
    if (cursor !== this.lastCursor) {
      this.direction = cursor > this.lastCursor ? 1 : -1;
      this.lastCursor = cursor;
      anim.touch(cursor);
      this.rest();
      // A seek that waits for its turn and is not the cursor any more gives its place to the cursor.
      if (this.current && this.current.kind !== 'pinned' && this.current.index !== cursor) this.abort?.abort();
    } else if (!this.resting && this.restTimer === 0) this.rest();
    if (!this.running) void this.run();
  }

  /** Stops the background loads until `resume`, for a run that samples on another grid. */
  pause(): void {
    this.paused++;
    this.abort?.abort();
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    if (this.paused === 0) this.need();
  }

  /**
   * Waits until these frames are in the store, or are no longer pinned. `progress` gets the frames done so far;
   * resolves false when `cancelled` turns true or the video closes.
   */
  whenReady(indices: readonly number[], progress: (done: number) => void, cancelled: () => boolean): Promise<boolean> {
    const anim = this.anim;
    const video = anim.video;
    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (cancelled() || anim.video !== video || !anim.locked) {
          finish(false);
          return;
        }
        const pinned = anim.pinnedIndices();
        const done = indices.filter((index) => anim.has(index) || !pinned.has(index)).length;
        progress(done);
        if (done >= indices.length) finish(true);
      };
      const timer = window.setInterval(check, 100);
      const finish = (ok: boolean) => {
        clearInterval(timer);
        this.listeners.delete(check);
        resolve(ok);
      };
      this.listeners.add(check);
      check();
      this.need();
    });
  }

  /**
   * Samples these video frames on another grid, for a new lock, with the background loads paused. Returns null when
   * cancelled; the thumbs of a cancelled or failed run are closed.
   */
  async sampleBatch(video: VideoSource, indices: readonly number[], grid: CellGrid, strength: number, progress: (done: number) => void, cancelled: () => boolean): Promise<Map<number, SampledFrame> | null> {
    const frames = new Map<number, SampledFrame>();
    const merge = { strength };
    let pending: Promise<void> | null = null;
    const close = () => {
      for (const frame of frames.values()) frame.thumb.close();
    };
    this.pause();
    try {
      for (let i = 0; i <= indices.length; i++) {
        const index = indices[i];
        const shot = i < indices.length && !cancelled() ? await video.capture(index, TUNING.anim.monitorPx) : null;
        if (pending) {
          await pending;
          pending = null;
          progress(frames.size);
        }
        if (!shot) break;
        if (cancelled() || this.anim.video !== video) {
          shot.frame.close();
          shot.thumb.close();
          break;
        }
        const thumb = shot.thumb;
        pending = this.engine.sampleFrame(shot.frame, grid, merge).then(
          ({ raw, own }) => {
            frames.set(index, { raw, own, thumb });
          },
          (error: unknown) => {
            thumb.close();
            throw error;
          },
        );
      }
    } catch (error) {
      // A sample that is still on its way must not reject later with nobody to catch it.
      pending?.catch(() => undefined);
      close();
      throw error;
    } finally {
      this.resume();
    }
    if (cancelled() || frames.size < indices.length) {
      close();
      return null;
    }
    return frames;
  }

  /** The prefetch waits until the cursor rests. */
  private rest(): void {
    this.resting = false;
    clearTimeout(this.restTimer);
    this.restTimer = window.setTimeout(() => {
      this.restTimer = 0;
      this.resting = true;
      if (!this.running) void this.run();
    }, TUNING.anim.prefetchIdleMs);
  }

  private next(): Job | null {
    const anim = this.anim;
    if (this.paused > 0 || !anim.video || !anim.locked) return null;
    const cursor = anim.cursor;
    if (!anim.has(cursor) && !this.busy.has(cursor)) return { index: cursor, kind: 'nav' };
    for (const index of anim.missingPinned(cursor)) if (!this.busy.has(index)) return { index, kind: 'pinned' };
    if (!this.resting) return null;
    const step = Math.max(1, anim.stepSize);
    for (let i = 1; i <= TUNING.anim.prefetchSteps; i++) {
      const index = cursor + this.direction * step * i;
      if (index < 0 || index >= anim.count) break;
      if (!anim.has(index) && !this.busy.has(index)) return { index, kind: 'prefetch' };
    }
    return null;
  }

  /** The job is still wanted: the cursor, a pinned frame, or a frame ahead of a resting cursor. */
  private wanted(job: Job): boolean {
    const anim = this.anim;
    if (anim.has(job.index)) return false;
    if (job.index === anim.cursor || anim.pinnedIndices().has(job.index)) return true;
    return job.kind === 'prefetch' && this.resting && this.paused === 0;
  }

  private async run(): Promise<void> {
    this.running = true;
    let sampling: Promise<void> | null = null;
    try {
      for (;;) {
        const job = this.next();
        if (!job) break;
        const anim = this.anim;
        const video = anim.video;
        const grid = anim.grid;
        if (!video || !grid) break;
        const generation = anim.generation;
        const strength = anim.ownStrength;
        const abort = new AbortController();
        this.abort = abort;
        this.current = job;
        this.busy.add(job.index);
        let shot: { frame: ImageBitmap; thumb: ImageBitmap };
        try {
          shot = await video.capture(job.index, TUNING.anim.monitorPx, { signal: abort.signal });
        } catch (error) {
          this.busy.delete(job.index);
          if (isAbortError(error)) continue;
          if (anim.video !== video) break;
          throw error;
        } finally {
          this.current = null;
          this.abort = null;
        }
        if (anim.video !== video || anim.generation !== generation || !this.wanted(job)) {
          shot.frame.close();
          shot.thumb.close();
          this.busy.delete(job.index);
          continue;
        }
        if (job.index === anim.cursor) await this.showPreview(job.index, shot, grid);
        // One sample at a time in the worker: a queue of stale samples there would hold back the newest one.
        if (sampling) await sampling;
        if (anim.generation !== generation || !this.wanted(job)) {
          shot.frame.close();
          shot.thumb.close();
          this.busy.delete(job.index);
          continue;
        }
        sampling = this.sample(job.index, shot, grid, strength, generation);
      }
      if (sampling) await sampling;
    } catch (error) {
      if (sampling) (sampling as Promise<void>).catch(() => undefined);
      this.fail(error);
    } finally {
      this.running = false;
    }
  }

  private sample(index: number, shot: { frame: ImageBitmap; thumb: ImageBitmap }, grid: CellGrid, strength: number, generation: number): Promise<void> {
    return this.engine.sampleFrame(shot.frame, grid, { strength }).then(
      ({ raw, own }: { raw: Sprite; own: Sprite }) => {
        this.busy.delete(index);
        this.anim.put(index, { raw, own, thumb: shot.thumb }, generation);
        for (const listener of this.listeners) listener();
      },
      (error: unknown) => {
        this.busy.delete(index);
        shot.thumb.close();
        throw error;
      },
    );
  }

  /** The grid extent of the captured frame at one pixel per tile, shown until the clean tiles arrive. */
  private async showPreview(index: number, shot: { frame: ImageBitmap; thumb: ImageBitmap }, grid: CellGrid): Promise<void> {
    const cols = grid.x.length - 1;
    const rows = grid.y.length - 1;
    if (cols <= 0 || rows <= 0) return;
    const x = grid.x[0];
    const y = grid.y[0];
    const w = grid.x[cols] - x;
    const h = grid.y[rows] - y;
    try {
      const [tiles, thumb] = await Promise.all([
        createImageBitmap(shot.frame, Math.floor(x), Math.floor(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { resizeWidth: cols, resizeHeight: rows, resizeQuality: 'pixelated' }),
        createImageBitmap(shot.thumb),
      ]);
      if (this.anim.cursor === index && !this.anim.has(index)) this.anim.setPreview(index, tiles, thumb);
      else {
        tiles.close();
        thumb.close();
      }
    } catch {
      // The preview is a convenience: the clean tiles still come.
    }
  }
}
