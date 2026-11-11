import type { GridFit, GridOptions, Selection, Sprite } from './types.ts';

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

export type EngineRequest =
  | { id: number; type: 'load'; bytes: ArrayBuffer }
  | { id: number; type: 'fit'; selection: Selection | null; options: GridOptions }
  | { id: number; type: 'clean'; merge: MergeOptions }
  | { id: number; type: 'merge'; merge: MergeOptions }
  | { id: number; type: 'export'; sprite: Sprite; scale: number };

export type EngineReply =
  | { id: number; ok: true; type: 'load'; width: number; height: number; bitmap: ImageBitmap; fit: GridFit }
  | { id: number; ok: true; type: 'fit'; fit: GridFit }
  | { id: number; ok: true; type: 'clean'; sprite: Sprite; palette: Uint32Array; aligned: ImageBitmap }
  | { id: number; ok: true; type: 'merge'; sprite: Sprite; palette: Uint32Array }
  | { id: number; ok: true; type: 'export'; png: ArrayBuffer }
  | { id: number; ok: false; error: ErrorCode; detail?: string };

export type EngineEvent = { id: number; type: 'progress'; stage: Stage; ratio: number };

export type WorkerMessage = EngineReply | EngineEvent;
