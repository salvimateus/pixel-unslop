/** RGBA8, straight alpha (not premultiplied), row-major. */
export interface RasterImage { width: number; height: number; data: Uint8ClampedArray }

/** n+1 ascending cell bounds per axis, in source pixels. A bound can lie below 0 or above the image size. */
export interface CellGrid { x: Float64Array; y: Float64Array }

/** One packed color per tile, row-major. 0 is transparent. See color.ts for the packing. */
export interface Sprite { cols: number; rows: number; pixels: Uint32Array }

/** The box that the user draws over ONE art pixel, in source pixels (float). */
export interface Selection { x: number; y: number; w: number; h: number }

export type ElasticMode = 'auto' | 'on' | 'off';

export interface GridOptions {
  elastic: ElasticMode;
  /** Set by the pixel-size control: the fit uses these periods as given and skips the refinement. */
  fixedPeriod?: { x: number; y: number };
  /** Manual phase shift, in source pixels. */
  nudge?: { x: number; y: number };
}

export type GridNote = 'harmonic-down' | 'harmonic-up' | 'weak-grid' | 'native-resolution' | 'elastic';

export interface AxisFit { period: number; offset: number; coherence: number; adapted: boolean }

export interface GridFit {
  grid: CellGrid;
  cols: number;
  rows: number;
  axes: { x: AxisFit; y: AxisFit };
  quality: 1 | 2 | 3;
  notes: GridNote[];
}
