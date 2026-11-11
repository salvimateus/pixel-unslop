import { CoreError, errorCode, errorMessage } from './errors.ts';
import {
  AUTO_OPTIONS,
  alignSource,
  checkSetGrid,
  exportSprite,
  fitSetSource,
  fitSource,
  jointFit,
  manualFitSource,
  mergeSprite,
  sampleSource,
  sharedPeriodOf,
  sourceFromImage,
  sourceFromPng,
  suggestedSetGrid,
  type Source,
} from './pipeline.ts';
import { isPng } from './png.ts';
import type { EngineReply, EngineRequest, SetFitItem, SetGrid, Stage, WorkerMessage } from './protocol.ts';
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

function failedItem(error: unknown): SetFitItem {
  return { ok: false, error: errorCode(error), detail: errorMessage(error) };
}

/** Decodes and fits each image of a set. One failed image fails alone. */
async function fitSet(id: number, images: ArrayBuffer[], grid: SetGrid): Promise<{ reply: EngineReply; transfer: Transferable[] }> {
  if (!Array.isArray(images)) throw new CoreError('internal', 'fit-set needs a list of images.');
  checkSetGrid(grid);
  progress(id, 'decode', 0);
  const decoded: Array<Source | SetFitItem> = [];
  for (const image of images) {
    try {
      decoded.push(await decode(new Uint8Array(image)));
    } catch (error) {
      decoded.push(failedItem(error));
    }
  }
  const sources = decoded.filter((entry): entry is Source => !('ok' in entry));
  const shared = sharedPeriodOf(sources);
  const fits: Array<{ own: GridFit; joint: GridFit | null }> = [];
  const items: SetFitItem[] = [];
  const transfer = new Set<Transferable>();
  progress(id, 'fit', 0);
  for (const entry of decoded) {
    if ('ok' in entry) {
      items.push(entry);
    } else {
      try {
        const own = fitSource(entry, null, AUTO_OPTIONS);
        const joint = shared ? jointFit(entry, shared) : null;
        fits.push({ own, joint });
        const fit = fitSetSource(entry, grid, own, joint);
        const raw = sampleSource(entry, fit);
        items.push({ ok: true, fit, raw, own: { period: { x: own.axes.x.period, y: own.axes.y.period }, quality: own.quality } });
        transfer.add(raw.pixels.buffer).add(fit.grid.x.buffer).add(fit.grid.y.buffer);
      } catch (error) {
        items.push(failedItem(error));
      }
    }
    progress(id, 'fit', items.length / decoded.length);
  }
  const suggested = suggestedSetGrid(fits);
  return { reply: { id, ok: true, type: 'fit-set', shared, suggested, items }, transfer: [...transfer] };
}

function isNumberList(value: unknown): value is ArrayLike<number> {
  return value instanceof Float64Array || (Array.isArray(value) && value.every((entry) => typeof entry === 'number'));
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
      const profiles = { x: source.edges.x.profile.slice(), y: source.edges.y.profile.slice() };
      const reply: EngineReply = { id, ok: true, type: 'load', width: source.image.width, height: source.image.height, bitmap, fit, profiles };
      post(reply, [bitmap, profiles.x.buffer, profiles.y.buffer]);
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
    case 'set-grid': {
      const current = requireState();
      const grid = request.grid;
      if (!grid || !isNumberList(grid.x) || !isNumberList(grid.y)) throw new CoreError('internal', 'set-grid needs x and y lists of grid lines.');
      const fit = manualFitSource(current.source, grid);
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
    case 'merge-own': {
      if (!Array.isArray(request.raws)) throw new CoreError('internal', 'merge-own needs a list of sprites.');
      const total = request.raws.length;
      const sprites: Sprite[] = [];
      progress(id, 'merge', 0);
      for (const raw of request.raws) {
        sprites.push(mergeSprite(raw, { strength: request.merge.strength }).sprite);
        progress(id, 'merge', sprites.length / total);
      }
      post({ id, ok: true, type: 'merge-own', sprites }, sprites.map((sprite) => sprite.pixels.buffer));
      return;
    }
    case 'fit-set': {
      const { reply, transfer } = await fitSet(id, request.images, request.grid);
      post(reply, transfer);
      return;
    }
    case 'export': {
      // Stateless: it encodes only the sprite of the request.
      progress(id, 'encode', 0);
      const bytes = exportSprite(request.sprite, { optimize: request.optimize === true });
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
