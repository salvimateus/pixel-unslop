import { CoreError, errorCode, errorMessage } from './errors.ts';
import {
  AUTO_OPTIONS,
  alignSource,
  exportSprite,
  fitSource,
  mergeSprite,
  sampleSource,
  sourceFromImage,
  sourceFromPng,
  type Source,
} from './pipeline.ts';
import { isPng } from './png.ts';
import type { EngineReply, EngineRequest, Stage, WorkerMessage } from './protocol.ts';
import type { GridFit, RasterImage, Sprite } from './types.ts';

/** The worker global, typed by hand because the DOM lib types `self` as Window. */
interface WorkerScope {
  postMessage(message: WorkerMessage, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

interface State { source: Source; fit: GridFit; raw: Sprite | null }

let state: State | null = null;

function post(message: WorkerMessage, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function progress(id: number, stage: Stage, ratio: number): void {
  post({ id, type: 'progress', stage, ratio });
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  return bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP';
}

async function decodeWithBrowser(bytes: Uint8Array, type: string): Promise<RasterImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  } catch (error) {
    throw new CoreError('decode-failed', `The image is damaged: ${errorMessage(error)}`);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new CoreError('internal', 'No 2D canvas in the worker.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: pixels.width, height: pixels.height, data: pixels.data };
  } finally {
    bitmap.close();
  }
}

async function decode(bytes: Uint8Array): Promise<Source> {
  if (isPng(bytes)) return sourceFromPng(bytes);
  if (isJpeg(bytes)) return sourceFromImage(await decodeWithBrowser(bytes, 'image/jpeg'));
  if (isWebp(bytes)) return sourceFromImage(await decodeWithBrowser(bytes, 'image/webp'));
  throw new CoreError('not-an-image', 'The file is not a PNG, JPEG or WebP image.');
}

function toBitmap(image: RasterImage): Promise<ImageBitmap> {
  const data = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  return createImageBitmap(data, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

function requireState(): State {
  if (!state) throw new CoreError('no-image', 'Load an image first.');
  return state;
}

async function handle(request: EngineRequest): Promise<void> {
  const { id } = request;
  switch (request.type) {
    case 'load': {
      progress(id, 'decode', 0);
      const source = await decode(new Uint8Array(request.bytes));
      progress(id, 'fit', 0);
      const fit = fitSource(source, null, AUTO_OPTIONS);
      state = { source, fit, raw: null };
      const bitmap = await toBitmap(source.image);
      const reply: EngineReply = { id, ok: true, type: 'load', width: source.image.width, height: source.image.height, bitmap, fit };
      post(reply, [bitmap]);
      return;
    }
    case 'fit': {
      const current = requireState();
      progress(id, 'fit', 0);
      const fit = fitSource(current.source, request.selection, request.options);
      state = { source: current.source, fit, raw: null };
      post({ id, ok: true, type: 'fit', fit });
      return;
    }
    case 'clean': {
      const current = requireState();
      progress(id, 'sample', 0);
      const raw = sampleSource(current.source, current.fit, (ratio) => progress(id, 'sample', ratio));
      current.raw = raw;
      progress(id, 'merge', 0);
      const { sprite, palette } = mergeSprite(raw, request.merge);
      const aligned = await toBitmap(alignSource(current.source, current.fit));
      post({ id, ok: true, type: 'clean', sprite, palette, aligned }, [sprite.pixels.buffer, palette.buffer, aligned]);
      return;
    }
    case 'merge': {
      const current = requireState();
      if (!current.raw) current.raw = sampleSource(current.source, current.fit);
      const { sprite, palette } = mergeSprite(current.raw, request.merge);
      post({ id, ok: true, type: 'merge', sprite, palette }, [sprite.pixels.buffer, palette.buffer]);
      return;
    }
    case 'export': {
      requireState();
      progress(id, 'encode', 0);
      const bytes = exportSprite(request.sprite, request.scale);
      const png = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      post({ id, ok: true, type: 'export', png }, [png]);
      return;
    }
    default: {
      const unknown = request as { id?: unknown; type?: unknown };
      throw new CoreError('internal', `Unknown request type ${String(unknown.type)}.`);
    }
  }
}

// Requests run one at a time, in arrival order, so a reply never sees the state of a later request.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  const id = typeof request?.id === 'number' ? request.id : -1;
  queue = queue.then(() =>
    handle(request).catch((error: unknown) => {
      post({ id, ok: false, error: errorCode(error), detail: errorMessage(error) });
    }),
  );
};
