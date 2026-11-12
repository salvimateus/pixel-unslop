/** Every algorithm constant. Calibrated on synthetic samples and on real AI pixel art. */
export const PARAMS = {
  limits: {
    /** Largest accepted image area, in pixels. */
    maxPixels: 40_000_000,
    /** Smallest accepted side, in pixels. */
    minSide: 8,
    /** Largest side of an exported PNG. */
    maxExportSide: 16_384,
    /** Largest number of tiles in one fit. */
    maxCells: 4_000_000,
  },
  edges: {
    /** Histogram bins per source pixel for the sub-pixel edge positions. */
    binsPerPixel: 8,
    /** Edge energy (L1 of premultiplied RGBA) below noiseFactor times the median energy is noise, within the limits. */
    noiseFactor: 2,
    minThreshold: 10,
    maxThreshold: 60,
    /** An edge is sharp when both neighbor energies are at most this share of its energy. */
    sharpRatio: 0.25,
  },
  pitch: {
    /** Smallest period that the automatic detection searches. */
    minPeriod: 1.5,
    /** Largest period that the automatic detection searches. */
    maxPeriod: 256,
    /** The automatic detection searches up to len / this value. */
    minCellsPerAxis: 4,
    /** Below this cell count, the silhouette of the sprite also repeats: the period needs fewCellsCoherence. */
    reliableCells: 12,
    fewCellsCoherence: 0.6,
    /** Largest relative difference between the period of one axis and the joint (square) period. */
    squareSlack: 0.03,
    /** A peak nearer to the joint period than this share, or to a harmonic of it, is not a rival. */
    rivalDistance: 0.12,
    /** With no user input, the grid is weak when the joint peak beats every rival by less than this factor... */
    minProminence: 1.25,
    /** ...unless the joint significance (geometric mean of both axes) reaches this value. */
    strongJointSignificance: 15,
    /** The wide search (the suggestion of a drawn box) keeps the peak within this share unless a peak farther away
     * is hintTrust times stronger. A typed size refines only within this share. */
    hintWindow: 0.08,
    hintTrust: 1.25,
    /** A drawn box defines the tile: its period stays within this share of the box side, with no harmonic change. */
    boxWindow: 0.1,
    /** Ratio between two steps of the log-spaced search. */
    logStep: 1.003,
    /** Range of the prior search, as factors of the prior. */
    priorLow: 0.75,
    priorHigh: 1.33,
    coarseSteps: 600,
    fineSteps: 60,
    /** A sub-harmonic of the box must beat the box period by this factor. */
    subHarmonicGain: 1.5,
    /** A multiple of the period wins when it keeps this share of the coherence. */
    superHarmonicKeep: 0.8,
    /** Whole-cell snap: the distance to a whole cell count and the coherence share to keep. */
    snapTolerance: 0.25,
    snapKeep: 0.98,
    /** Below this significance (coherence times the square root of the effective edge count) an axis is weak. */
    weakSignificance: 6,
    /** At or above this significance an axis is good. */
    goodSignificance: 15,
    /** Square sync: largest relative difference between box width and height. */
    squareTolerance: 0.15,
    /** With no grid, an image whose edges are this sharp is native resolution. */
    nativeSharpShare: 0.5,
    /** With no grid, an image with at most this many opaque colors is native resolution. */
    nativeMaxColors: 256,
    /** Below this period on both axes the image is native resolution. */
    nativeBelow: 1.5,
  },
  elastic: {
    /** Positions per source pixel of the boundary lattice. */
    lattice: 4,
    /** Smallest period for the automatic elastic fit. */
    minPeriod: 4,
    /** Smallest grid quality for the automatic elastic fit: a weak grid often has a harmonic period. */
    minQuality: 2,
    /** Edge energy that the fit must capture over the regular grid. */
    minGain: 1.3,
    /** Edge energy gain that is enough when the fit has a different cell count than the regular grid. */
    countChangeGain: 1.15,
    /**
     * With a drawn box, the automatic elastic fit needs one of its cells centered near the box center: within
     * anchorTolerance source pixels or anchorShare of the period, the larger one. A box farther off moves the whole grid.
     */
    anchorTolerance: 0.3,
    anchorShare: 0.045,
    /**
     * With a period that the user set (fixedPeriod or a box), the elastic fit may change the cell count of an axis by
     * at most userCountSlack cells or userCountShare of the regular count, the larger one; else the regular grid stays.
     */
    userCountSlack: 1,
    userCountShare: 0.03,
    minSpacing: 0.75,
    maxSpacing: 1.3,
    /** A cell off the period by this share costs as much as a strong edge earns. */
    slack: 0.25,
    /** Percentile that normalizes the edge strength. */
    normalizePercentile: 0.9,
  },
  manualGrid: {
    /** Smallest spacing between two grid lines that the user placed, in source pixels. */
    minSpacing: 0.5,
  },
  cells: {
    /** Share of the cell size removed on each side before the vote. */
    innerMargin: 0.2,
    /** Smallest core weight, in source pixels, before the full cell votes. */
    minCoreWeight: 0.25,
    /** Alpha below this value counts as transparent. */
    alphaCut: 128,
    /** A tile is transparent when this share of its weight is transparent. */
    transparentShare: 0.5,
    /** Bin width of the RGB histograms is 2^binShift levels. */
    binShift: 5,
    /** Offset of the second histogram, in levels. */
    binOffset: 16,
    /** Below this share of the opaque weight the winner bin falls back to the median of all opaque pixels. */
    minWinnerShare: 0.25,
  },
  palette: {
    presets: {
      off: 0,
      light: 0.03,
      normal: 0.055,
      strong: 0.08,
    },
    refinePasses: 2,
    /** The shared palette of several sprites merges their own palettes with this share of the strength. */
    sharedFactor: 0.6,
    reference: {
      /** The plan, the curve fit and the gate read this many colors of each palette, the heaviest first. */
      topColors: 64,
      /** A palette with more than topColors colors first merges its near colors at this strength. */
      planStrength: 0.03,
      /** No tile pairs with a reference color at this OKLab distance or farther. It is also the largest lightness move of one pass. */
      reach: 0.1,
      /** Number of plan and curve fit passes. Each pass starts from the lightness of the pass before. */
      passes: 3,
      /** Two colors nearer than this (OKLab) add to the gate score. */
      radius: 0.05,
      /** The curve must raise the gate score of "no change" by more than this share, else each color takes its nearest color. */
      minGain: 0.4,
      /** After a tone change, two reference colors are equally near when their distances to a color differ by less than this. */
      close: 0.015,
    },
  },
  sizing: {
    /** Largest k of a 1/k reduction that a height snaps to. */
    maxReduction: 8,
    /** Largest enlargement of one object. */
    maxEnlargement: 4,
    /** A resampled tile is transparent only above this transparent share, so outlines survive a reduction. */
    clearAbove: 0.5,
  },
  set: {
    /** A set suggests one shared grid only when each image with a good grid of its own is within this share of the joint period... */
    sharedTolerance: 0.08,
    /**
     * ...and the lower median image keeps at least this share of its own grid coherence under the joint period.
     * Pieces of one drawing keep most of it; a weak image of another density loses more than half.
     */
    minSharedKeep: 0.75,
  },
  background: {
    /** A border color must cover this share of the border tiles. */
    minBorderShare: 0.2,
    /** Largest number of background colors (a solid color or a fake checkerboard). */
    maxColors: 2,
  },
  preview: {
    /** The grid preview upscales the source until one art pixel is at least this size. */
    minCellSide: 12,
    /** Largest side of a grid preview. */
    maxSide: 4096,
  },
} as const;
