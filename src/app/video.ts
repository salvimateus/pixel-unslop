import { PARAMS } from '../core/params.ts';
import { formatOf } from './analytics.ts';

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm)$/i;

/** Frame rate when neither the container nor the playback timing gives one. */
const FALLBACK_FPS = 30;
/** Frame rates that a measured rate snaps to. */
const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60] as const;
/** A measured rate snaps to a common rate within this share of it. */
const SNAP_SHARE = 0.03;
/** Container timing is ignored when its length differs from the element duration by more than this share (or 0.5 s). */
const LENGTH_SHARE = 0.1;

/** Longest wait for the metadata of a file. */
const OPEN_TIMEOUT_MS = 15_000;
/** Longest wait for one seek. */
const SEEK_TIMEOUT_MS = 10_000;
/** Longest wait for the presentation of the seeked frame after `seeked`. */
const PRESENT_TIMEOUT_MS = 120;
/** Retries of a capture that still shows the previous frame after a seek. */
const STALE_RETRIES = 4;
/** Wait between those retries where no frame callback arrives. */
const STALE_WAIT_MS = 25;
/** Longest playback that the frame rate detection uses. */
const DETECT_TIMEOUT_MS = 2_500;
/** Frame callbacks that the frame rate detection collects. */
const DETECT_FRAMES = 14;
/** Seek targets stay this far before the end of the media. */
const END_MARGIN_S = 0.001;

/** Largest box that the container reader loads into memory (a `moov` or `moof`). */
const MAX_BOX_BYTES = 64 * 1024 * 1024;
/** Bytes that the container reader loads at once, so many small boxes cost one read. */
const READ_WINDOW_BYTES = 1024 * 1024;
/** Largest number of top-level boxes that the container reader visits. */
const MAX_TOP_BOXES = 500_000;
/** Largest number of frames that the container reader accepts. */
const MAX_FRAMES = 2_000_000;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name);
}

export interface VideoInfo {
  /** The file name without extension. */
  name: string;
  /** The lowercase extension, as `formatOf` gives it. */
  format: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** In seconds. */
  duration: number;
  /** True when `fps` and `frameCount` come from the container timing. */
  exact: boolean;
}

export type VideoProblem = 'unsupported' | 'too-large' | 'too-small';

export class VideoError extends Error {
  readonly problem: VideoProblem;

  constructor(problem: VideoProblem, message: string) {
    super(message);
    this.name = 'VideoError';
    this.problem = problem;
  }
}

interface ContainerTiming {
  fps: number;
  frameCount: number;
  /** Start time of each frame in seconds, plus the end of the last frame (frameCount + 1 values). */
  starts: Float64Array;
}

interface Frame {
  frame: ImageBitmap;
  thumb: ImageBitmap;
}

type Cancel = (error: VideoError) => void;

/**
 * Frame-exact access to one video file through a hidden `<video>` element. Every capture seeks to the middle of
 * its frame, so the same index always gives the same picture.
 */
export class VideoSource {
  readonly info: VideoInfo;

  private readonly element: HTMLVideoElement;
  private readonly url: string;
  private readonly starts: Float64Array | null;
  private readonly cancels = new Set<Cancel>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** The frame index that the element shows, or -1 when unknown. */
  private shown = -1;
  /** The media timestamp of the last captured frame, in microseconds. */
  private timestamp: number | null = null;

  private constructor(element: HTMLVideoElement, url: string, info: VideoInfo, starts: Float64Array | null) {
    this.element = element;
    this.url = url;
    this.info = info;
    this.starts = starts;
  }

  /** Opens a video file. Rejects with `VideoError`. */
  static async open(file: File): Promise<VideoSource> {
    const url = URL.createObjectURL(file);
    const element = createElement(url);
    const timing = readContainerTiming(file).catch(() => null);
    try {
      await waitEvent(element, 'loadedmetadata', OPEN_TIMEOUT_MS);
      if (element.videoWidth === 0 || element.videoHeight === 0) {
        throw new VideoError('unsupported', 'The file has no video track that this browser can decode.');
      }
      checkSize(element.videoWidth, element.videoHeight);
      if (element.duration === Infinity) await resolveDuration(element);
      const duration = element.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new VideoError('unsupported', 'The video has no known duration.');
      }
      if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitEvent(element, 'loadeddata', OPEN_TIMEOUT_MS);

      const container = plausible(await timing, duration);
      const fps = container?.fps ?? (await detectFps(element)) ?? FALLBACK_FPS;
      const frameCount = container?.frameCount ?? Math.max(1, Math.round(duration * fps));
      const info: VideoInfo = {
        name: file.name.replace(/\.[a-z0-9]{1,8}$/i, '') || 'video',
        format: formatOf(file.name),
        width: element.videoWidth,
        height: element.videoHeight,
        fps,
        frameCount,
        duration,
        exact: container !== null,
      };
      return new VideoSource(element, url, info, container?.starts ?? null);
    } catch (error) {
      release(element, url);
      if (error instanceof VideoError) throw error;
      throw new VideoError('unsupported', error instanceof Error ? error.message : String(error));
    }
  }

  /** The full-size frame and a thumb `thumbWidth` wide. Captures run one at a time, in call order. */
  capture(index: number, thumbWidth: number): Promise<Frame> {
    return this.enqueue(async () => {
      const frame = await this.grab(index);
      try {
        const width = Math.max(1, Math.round(thumbWidth));
        const height = Math.max(1, Math.round((width * frame.height) / frame.width));
        const thumb = await createImageBitmap(frame, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
        if (this.closed) {
          thumb.close();
          throw closedError();
        }
        return { frame, thumb };
      } catch (error) {
        frame.close();
        throw error;
      }
    });
  }

  /** The PNG bytes of the full-size frame. */
  framePng(index: number): Promise<ArrayBuffer> {
    return this.enqueue(async () => {
      const frame = await this.grab(index);
      try {
        const canvas = new OffscreenCanvas(frame.width, frame.height);
        const context = canvas.getContext('2d');
        if (!context) throw new VideoError('unsupported', 'No 2D canvas.');
        context.drawImage(frame, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const bytes = await blob.arrayBuffer();
        if (this.closed) throw closedError();
        return bytes;
      } finally {
        frame.close();
      }
    });
  }

  /** Frees the element and the file. Pending and later calls reject with `VideoError('unsupported')`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = closedError();
    for (const cancel of this.cancels) cancel(error);
    this.cancels.clear();
    release(this.element, this.url);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = () => (this.closed ? Promise.reject(closedError()) : job());
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async grab(index: number): Promise<ImageBitmap> {
    const frame = Math.min(Math.max(Math.round(index), 0), this.info.frameCount - 1);
    const moved = frame !== this.shown;
    if (moved) {
      this.shown = -1;
      await this.seek(this.frameMiddle(frame));
      this.shown = frame;
    }
    return this.snapshot(moved);
  }

  /**
   * A bitmap of the decoded frame. `seeked` can fire before the new frame replaces the old one, mostly when nothing
   * is rendered (a hidden tab), so after a move a frame with the previous timestamp is retried a few times.
   */
  private async snapshot(moved: boolean): Promise<ImageBitmap> {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw closedError();
      let still: VideoFrame;
      try {
        still = new VideoFrame(this.element);
      } catch {
        return createImageBitmap(this.element);
      }
      if (moved && still.timestamp === this.timestamp && attempt < STALE_RETRIES) {
        still.close();
        await this.nextFrame();
        continue;
      }
      this.timestamp = still.timestamp;
      try {
        return await createImageBitmap(still);
      } finally {
        still.close();
      }
    }
  }

  /** Waits for the next presented frame, or a short time where nothing is rendered. */
  private nextFrame(): Promise<void> {
    const video = this.element;
    return new Promise<void>((resolve, reject) => {
      let handle = 0;
      const finish = (error?: VideoError) => {
        clearTimeout(timer);
        if (handle) video.cancelVideoFrameCallback(handle);
        this.cancels.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel: Cancel = (error) => finish(error);
      const timer = window.setTimeout(() => finish(), STALE_WAIT_MS);
      if (typeof video.requestVideoFrameCallback === 'function' && !document.hidden) {
        handle = video.requestVideoFrameCallback(() => {
          handle = 0;
          finish();
        });
      }
      this.cancels.add(cancel);
    });
  }

  private frameMiddle(index: number): number {
    const middle = this.starts ? (this.starts[index] + this.starts[index + 1]) / 2 : (index + 0.5) / this.info.fps;
    return Math.max(0, Math.min(middle, this.info.duration - END_MARGIN_S));
  }

  /** Seeks and waits until the element presents the new frame. */
  private seek(time: number): Promise<void> {
    const video = this.element;
    return new Promise<void>((resolve, reject) => {
      let presented = typeof video.requestVideoFrameCallback !== 'function' || document.hidden;
      let seeked = false;
      let frameHandle = 0;
      let graceTimer = 0;
      const finish = (error?: VideoError) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (frameHandle) video.cancelVideoFrameCallback(frameHandle);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        this.cancels.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel: Cancel = (error) => finish(error);
      const onSeeked = () => {
        seeked = true;
        if (presented) finish();
        // A seek that lands on the frame already on screen may present nothing new.
        else graceTimer = window.setTimeout(() => finish(), PRESENT_TIMEOUT_MS);
      };
      const onError = () => finish(mediaError(video));
      const timer = window.setTimeout(() => finish(new VideoError('unsupported', 'The video did not seek in time.')), SEEK_TIMEOUT_MS);
      if (!presented) {
        frameHandle = video.requestVideoFrameCallback(() => {
          frameHandle = 0;
          presented = true;
          if (seeked) finish();
        });
      }
      this.cancels.add(cancel);
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.currentTime = time;
    });
  }
}

function closedError(): VideoError {
  return new VideoError('unsupported', 'The video is closed.');
}

function mediaError(video: HTMLVideoElement): VideoError {
  const detail = video.error?.message || `media error ${video.error?.code ?? '?'}`;
  return new VideoError('unsupported', `The browser cannot decode the video: ${detail}`);
}

function checkSize(width: number, height: number): void {
  const { minSide, maxPixels } = PARAMS.limits;
  if (width < minSide || height < minSide) {
    throw new VideoError('too-small', `The video is ${width} x ${height}; each side must be at least ${minSide} pixels.`);
  }
  if (width * height > maxPixels) {
    throw new VideoError('too-large', `The video has ${width * height} pixels per frame; the limit is ${maxPixels}.`);
  }
}

/** A video element out of view but in the document, so the browser keeps decoding and presenting frames. */
function createElement(url: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.disablePictureInPicture = true;
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  Object.assign(video.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '64px',
    height: '64px',
    pointerEvents: 'none',
  });
  video.src = url;
  document.body.append(video);
  return video;
}

function release(video: HTMLVideoElement, url: string): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
  URL.revokeObjectURL(url);
}

function waitEvent(video: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: VideoError) => {
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(mediaError(video));
    const timer = window.setTimeout(() => finish(new VideoError('unsupported', `The video did not fire ${event} in time.`)), timeoutMs);
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

/** Files without a duration in the header (some WebM recordings) get it after a seek past the end. */
async function resolveDuration(video: HTMLVideoElement): Promise<void> {
  const changed = waitEvent(video, 'durationchange', OPEN_TIMEOUT_MS);
  video.currentTime = Number.MAX_SAFE_INTEGER;
  await changed.catch(() => undefined);
  if (video.seeking) await waitEvent(video, 'seeked', OPEN_TIMEOUT_MS).catch(() => undefined);
  const back = waitEvent(video, 'seeked', OPEN_TIMEOUT_MS);
  video.currentTime = 0;
  await back.catch(() => undefined);
}

function snapRate(fps: number): number {
  let best = Math.round(fps * 1000) / 1000;
  let bestShare = SNAP_SHARE;
  for (const rate of COMMON_RATES) {
    const share = Math.abs(fps - rate) / rate;
    if (share <= bestShare) {
      best = rate;
      bestShare = share;
    }
  }
  return best;
}

/** The frame rate from `requestVideoFrameCallback` media times during a short muted playback, or null. */
async function detectFps(video: HTMLVideoElement): Promise<number | null> {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const deltas: number[] = [];
  let handle = 0;
  try {
    await new Promise<void>((resolve) => {
      let last: { time: number; frames: number } | null = null;
      const timer = window.setTimeout(resolve, DETECT_TIMEOUT_MS);
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (last && meta.presentedFrames - last.frames === 1 && meta.mediaTime > last.time) deltas.push(meta.mediaTime - last.time);
        last = { time: meta.mediaTime, frames: meta.presentedFrames };
        if (deltas.length >= DETECT_FRAMES || video.ended) {
          clearTimeout(timer);
          resolve();
        } else handle = video.requestVideoFrameCallback(onFrame);
      };
      handle = video.requestVideoFrameCallback(onFrame);
      video.play().catch(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    if (handle) video.cancelVideoFrameCallback(handle);
    video.pause();
    const back = waitEvent(video, 'seeked', OPEN_TIMEOUT_MS);
    video.currentTime = 0;
    await back.catch(() => undefined);
  }
  if (deltas.length < 3) return null;
  deltas.sort((a, b) => a - b);
  const median = deltas[deltas.length >> 1];
  return median > 0 ? snapRate(1 / median) : null;
}

/** Container timing that agrees with the element duration, or null. */
function plausible(timing: ContainerTiming | null, duration: number): ContainerTiming | null {
  if (!timing || timing.frameCount < 1 || !(timing.fps >= 1 && timing.fps <= 1000)) return null;
  const length = timing.starts[timing.frameCount];
  return Math.abs(length - duration) <= Math.max(0.5, duration * LENGTH_SHARE) ? timing : null;
}

// ISO base media file format (MP4, MOV, M4V). Only box headers and the timing boxes are read.

interface BoxRef {
  type: string;
  /** Offset of the box body. */
  body: number;
  end: number;
}

const FOURCC = /^[\x20-\x7e]{4}$/;
const FIRST_BOXES = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid']);

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** The box header at `offset` of `view`, or null when no valid box fits before `limit`. */
function boxAt(view: DataView, offset: number, limit: number): BoxRef | null {
  if (offset + 8 > limit) return null;
  let size = view.getUint32(offset);
  const type = fourcc(view, offset + 4);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = Number(view.getBigUint64(offset + 8));
    header = 16;
  } else if (size === 0) size = limit - offset;
  if (!FOURCC.test(type) || size < header || offset + size > limit) return null;
  return { type, body: offset + header, end: offset + size };
}

function children(view: DataView, start: number, end: number): BoxRef[] {
  const boxes: BoxRef[] = [];
  for (let offset = start; ; ) {
    const box = boxAt(view, offset, end);
    if (!box) return boxes;
    boxes.push(box);
    offset = box.end;
  }
}

function child(view: DataView, parent: BoxRef, type: string): BoxRef | undefined {
  return children(view, parent.body, parent.end).find((box) => box.type === type);
}

function path(view: DataView, parent: BoxRef, types: string[]): BoxRef | undefined {
  let box: BoxRef | undefined = parent;
  for (const type of types) box = box && child(view, box, type);
  return box;
}

/** Reads byte ranges of a file through one cached window, so runs of small boxes cost one read. */
class FileWindow {
  readonly file: File;
  private start = 0;
  private bytes = new Uint8Array(0);

  constructor(file: File) {
    this.file = file;
  }

  async view(start: number, end: number): Promise<DataView> {
    if (start < this.start || end > this.start + this.bytes.length) {
      const windowEnd = Math.min(this.file.size, Math.max(end, start + READ_WINDOW_BYTES));
      this.bytes = new Uint8Array(await this.file.slice(start, windowEnd).arrayBuffer());
      this.start = start;
    }
    const at = start - this.start;
    return new DataView(this.bytes.buffer, at, Math.min(end, this.start + this.bytes.length) - start);
  }
}

interface TopBox {
  type: string;
  start: number;
  end: number;
}

/** The top-level boxes of the file, from their headers only. Null when the file is not an ISO media file. */
async function topBoxes(reader: FileWindow): Promise<TopBox[] | null> {
  const size = reader.file.size;
  const boxes: TopBox[] = [];
  for (let offset = 0; offset < size && boxes.length < MAX_TOP_BOXES; ) {
    const view = await reader.view(offset, Math.min(offset + 16, size));
    const box = boxAt(view, 0, size - offset);
    if (!box) break;
    if (boxes.length === 0 && !FIRST_BOXES.has(box.type)) return null;
    boxes.push({ type: box.type, start: offset, end: offset + box.end });
    offset += box.end;
  }
  return boxes.length > 0 ? boxes : null;
}

async function loadBox(reader: FileWindow, box: TopBox): Promise<{ view: DataView; ref: BoxRef } | null> {
  if (box.end - box.start > MAX_BOX_BYTES) return null;
  const view = await reader.view(box.start, box.end);
  const ref = boxAt(view, 0, view.byteLength);
  return ref ? { view, ref } : null;
}

/** Decode times of the video samples, in timescale units. A fragment may restart the clock with its `tfdt`. */
class Timeline {
  readonly starts: number[] = [];
  private next = 0;

  /** False when the table is too long to be real. */
  add(count: number, duration: number): boolean {
    if (this.starts.length + count > MAX_FRAMES) return false;
    for (let i = 0; i < count; i++) {
      this.starts.push(this.next);
      this.next += duration;
    }
    return true;
  }

  setBase(time: number): void {
    this.next = time;
  }

  get end(): number {
    return this.next;
  }
}

/** Frame rate and frame times from the MP4 or MOV sample tables, including fragmented files. Null when unknown. */
async function readContainerTiming(file: File): Promise<ContainerTiming | null> {
  const reader = new FileWindow(file);
  const boxes = await topBoxes(reader);
  const moovBox = boxes?.find((box) => box.type === 'moov');
  if (!boxes || !moovBox) return null;
  const moov = await loadBox(reader, moovBox);
  if (!moov) return null;
  const { view } = moov;

  let track: { id: number; timescale: number; trak: BoxRef } | null = null;
  for (const trak of children(view, moov.ref.body, moov.ref.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = path(view, trak, ['mdia', 'hdlr']);
    if (!hdlr || hdlr.body + 12 > hdlr.end || fourcc(view, hdlr.body + 8) !== 'vide') continue;
    const tkhd = child(view, trak, 'tkhd');
    const mdhd = path(view, trak, ['mdia', 'mdhd']);
    if (!tkhd || !mdhd) continue;
    const id = view.getUint32(tkhd.body + (view.getUint8(tkhd.body) === 1 ? 20 : 12));
    const timescale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));
    if (timescale > 0) {
      track = { id, timescale, trak };
      break;
    }
  }
  if (!track) return null;

  const timeline = new Timeline();
  const stts = path(view, track.trak, ['mdia', 'minf', 'stbl', 'stts']);
  if (stts) {
    const entries = view.getUint32(stts.body + 4);
    if (stts.body + 8 + entries * 8 > stts.end) return null;
    for (let i = 0; i < entries; i++) {
      const at = stts.body + 8 + i * 8;
      if (!timeline.add(view.getUint32(at), view.getUint32(at + 4))) return null;
    }
  }

  let trexDuration = 0;
  const mvex = child(view, moov.ref, 'mvex');
  for (const trex of mvex ? children(view, mvex.body, mvex.end) : []) {
    if (trex.type === 'trex' && view.getUint32(trex.body + 4) === track.id) trexDuration = view.getUint32(trex.body + 12);
  }
  for (const box of boxes) {
    if (box.type !== 'moof') continue;
    const moof = await loadBox(reader, box);
    if (moof && !readFragment(moof.view, moof.ref, track.id, trexDuration, timeline)) return null;
  }

  const frameCount = timeline.starts.length;
  if (frameCount === 0) return null;
  const ticks = [...timeline.starts, timeline.end];
  const fps = rateOf(ticks, track.timescale);
  if (fps === null) return null;
  return { fps, frameCount, starts: Float64Array.from(ticks, (tick) => tick / track.timescale) };
}

/**
 * The timescale over the most common frame interval. Screen and canvas recordings stamp each frame with its capture
 * time, so when no interval holds a majority, the median interval snapped to a common rate is used.
 */
function rateOf(ticks: number[], timescale: number): number | null {
  const votes = new Map<number, number>();
  for (let i = 1; i < ticks.length; i++) {
    const interval = ticks[i] - ticks[i - 1];
    if (interval > 0) votes.set(interval, (votes.get(interval) ?? 0) + 1);
  }
  let common = 0;
  let best = 0;
  let total = 0;
  for (const [interval, count] of votes) {
    total += count;
    if (count > best) {
      common = interval;
      best = count;
    }
  }
  if (total === 0) return null;
  if (best * 2 > total) return timescale / common;
  let seen = 0;
  for (const interval of [...votes.keys()].sort((a, b) => a - b)) {
    seen += votes.get(interval) ?? 0;
    if (seen * 2 >= total) return snapRate(timescale / interval);
  }
  return null;
}

/** Adds the video samples of one `moof` to the timeline. False when the table is too long to be real. */
function readFragment(view: DataView, moof: BoxRef, trackId: number, trexDuration: number, timeline: Timeline): boolean {
  for (const traf of children(view, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(view, traf, 'tfhd');
    if (!tfhd || view.getUint32(tfhd.body + 4) !== trackId) continue;
    const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
    let at = tfhd.body + 8;
    if (tfhdFlags & 0x1) at += 8;
    if (tfhdFlags & 0x2) at += 4;
    const defaultDuration = tfhdFlags & 0x8 ? view.getUint32(at) : trexDuration;

    const tfdt = child(view, traf, 'tfdt');
    if (tfdt) timeline.setBase(view.getUint8(tfdt.body) === 1 ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4));

    for (const trun of children(view, traf.body, traf.end)) {
      if (trun.type !== 'trun') continue;
      const flags = view.getUint32(trun.body) & 0xffffff;
      const count = view.getUint32(trun.body + 4);
      if (!(flags & 0x100)) {
        if (!timeline.add(count, defaultDuration)) return false;
        continue;
      }
      let sample = trun.body + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length;
      if (sample + count * stride > trun.end) continue;
      for (let i = 0; i < count; i++, sample += stride) if (!timeline.add(1, view.getUint32(sample))) return false;
    }
  }
  return true;
}
