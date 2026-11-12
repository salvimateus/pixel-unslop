import type { CellGrid, GridFit, GridOptions, Selection, Sprite } from './types.ts';

export type ErrorCode =
  | 'not-an-image'
  | 'decode-failed'
  | 'too-large'
  | 'too-small'
  | 'empty-image'
  | 'too-many-cells'
  | 'no-image'
  | 'internal';

export type Stage = 'decode' | 'fit' | 'sample' | 'merge' | 'encode';

export interface MergeOptions { strength: number; maxColors?: number }

/** The grid of a set: each image alone, one joint period for all, or one period given for all. */
export type SetGrid = { kind: 'own' } | { kind: 'shared' } | { kind: 'fixed'; period: { x: number; y: number } };

/** One image of a fit-set reply. `own` is the automatic period and quality of the image alone, in each grid mode. */
export type SetFitItem =
  | { ok: true; fit: GridFit; raw: Sprite; own: { period: { x: number; y: number }; quality: 1 | 2 | 3 } }
  | { ok: false; error: ErrorCode; detail?: string };

export type EngineRequest =
  | { id: number; type: 'load'; bytes: ArrayBuffer }
  | { id: number; type: 'fit'; selection: Selection | null; options: GridOptions }
  /** Grid lines that the user placed: they become the current fit, and the reply is a 'fit' reply. */
  | { id: number; type: 'set-grid'; grid: CellGrid }
  | { id: number; type: 'clean'; merge: MergeOptions }
  | { id: number; type: 'merge'; merge: MergeOptions }
  /** Own palette merge of each sprite. Needs no loaded image and leaves the worker state as it is. */
  | { id: number; type: 'merge-own'; raws: Sprite[]; merge: MergeOptions }
  /** The PNG of the sprite at one image pixel per tile; `optimize` makes the smallest lossless PNG. */
  | { id: number; type: 'export'; sprite: Sprite; optimize: boolean }
  /** Decodes and fits each image with the set grid. Needs no loaded image and leaves the worker state as it is. */
  | { id: number; type: 'fit-set'; images: ArrayBuffer[]; grid: SetGrid }
  /** Decodes a reference image to its tiles (see referenceTiles). Needs no loaded image and leaves the worker state as it is. */
  | { id: number; type: 'reference'; bytes: ArrayBuffer };

export type EngineReply =
  /** `profiles.x[i]` is the edge strength between column i and i + 1 (length width - 1); the same for y. */
  | { id: number; ok: true; type: 'load'; width: number; height: number; bitmap: ImageBitmap; fit: GridFit; profiles: { x: Float64Array; y: Float64Array } }
  | { id: number; ok: true; type: 'fit'; fit: GridFit }
  | { id: number; ok: true; type: 'clean'; sprite: Sprite; palette: Uint32Array; aligned: ImageBitmap }
  | { id: number; ok: true; type: 'merge'; sprite: Sprite; palette: Uint32Array }
  | { id: number; ok: true; type: 'merge-own'; sprites: Sprite[] }
  | { id: number; ok: true; type: 'export'; png: ArrayBuffer }
  | { id: number; ok: true; type: 'fit-set'; shared: { x: number; y: number } | null; suggested: 'own' | 'shared'; items: SetFitItem[] }
  /** `flat` is true when each pixel of the reference is a tile; else `sprite` holds the raw tiles of its automatic grid. */
  | { id: number; ok: true; type: 'reference'; sprite: Sprite; flat: boolean }
  | { id: number; ok: false; error: ErrorCode; detail?: string };

export type EngineEvent = { id: number; type: 'progress'; stage: Stage; ratio: number };

export type WorkerMessage = EngineReply | EngineEvent;
