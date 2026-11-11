/** Every game-feel constant of the interface. Algorithm constants live in src/core/params.ts. */
export const TUNING = {
  stage: {
    maxDpr: 2,
    fitPadding: 40,
    /** Fraction of the content that must stay inside the viewport while the user pans. */
    panKeepVisible: 0.15,
    keyPanPx: 48,
  },
  zoom: {
    smoothing: 22,
    wheelSensitivity: 0.0022,
    buttonStep: 1.6,
    /** Smallest zoom, as a fraction of the zoom that fits the content. */
    minFitRatio: 0.35,
    gridMax: 96,
    cleanMax: 160,
    setMax: 96,
    /** Screen pixels per art pixel on the first view of the Grade screen. */
    gridFirstCellPx: 24,
  },
  grid: {
    minCellPx: 6,
    haloMinCellPx: 12,
    /** The fitted grid of the Grade screen gets its dark halo from this cell size on screen. */
    fitHaloMinCellPx: 8,
    /** Screen size of one art pixel in the zoomed detail of the panel. */
    detailCellPx: 18,
    /** Smallest and largest zoom of the zoomed detail. */
    detailMinZoom: 0.25,
    detailMaxZoom: 64,
    scanMs: 700,
    flashMs: 520,
    boxSettleMs: 280,
    boxHoldMs: 700,
    boxFadeMs: 420,
    /** A box smaller than this (in source pixels) is a click, not a selection. */
    minBoxSourcePx: 0.75,
    pixelSizeMin: 1,
    pixelSizeMax: 64,
    sliderStep: 0.01,
    sliderStepShift: 0.1,
    /** Step of one click of an arrow of "Mover a grade inteira", in source pixels; Shift uses the larger one. */
    nudgeStep: 0.25,
    nudgeStepShift: 1,
    /** A held arrow or step button repeats after this delay, at this interval. */
    holdDelayMs: 380,
    holdRepeatMs: 70,
    /** Step of the - and + buttons of the pixel size; Shift uses the larger one. */
    sizeButtonStep: 0.05,
    sizeButtonStepShift: 0.5,
    /** The shape slider of a stretched pixel reaches this ratio of width to height, and its inverse. */
    shapeRatioMax: 2.5,
    /** Within this distance of the center (log of the ratio), the shape slider snaps to a square pixel. */
    shapeSnap: 0.01,
    /** Largest offset of the full grid, from the arrows or a Ctrl drag, in source pixels. */
    nudgeMax: 4096,
    /** After the slider is released, the dense grid and the loupe stay this long. */
    pressHoldMs: 700,
    /** Line alpha at the smallest cell while the slider is pressed; it grows to 1 at minCellPx. */
    denseAlphaMin: 0.3,
    /** Screen size of one cell inside the loupe while the slider is pressed. */
    loupeCellPx: 16,
    /** A line of the grid is under the pointer within this screen distance. */
    lineHitPx: 6,
    /** A dragged line snaps to an edge of the drawing within this screen distance. */
    lineSnapPx: 10,
    /** Two clicks within this time make a double click. */
    doubleClickMs: 350,
    /** Arrow key step of a selected line, in source pixels; Shift uses 1. */
    lineKeyStep: 0.25,
    /** A line counts as moved by the flexible grid when a cell next to it is off the period by this share. */
    movedLineShare: 0.15,
  },
  loupe: {
    size: 176,
    magnify: 2.2,
    maxZoom: 64,
    offset: 28,
  },
  clean: {
    sweepMs: 950,
    sweepSparksPerFrame: 6,
    splitHitPx: 12,
    splitKnobPx: 30,
    waveStepMs: 26,
    waveMaxMs: 650,
    popMs: 240,
    popScale: 0.7,
    rippleMs: 520,
    rippleRadiusTiles: 9,
    eyedropperReturnsToPencil: true,
    /** The dashed outline of the box that the export writes. */
    exportBoxAlpha: 0.75,
  },
  set: {
    maxObjects: 24,
    /** Above this many source or result tiles a drag stretches the last result and calculates on release. */
    liveResizeTiles: 120_000,
    /** Screen distance at which the handle snaps to a whole-number size. */
    snapPx: 10,
    /** Largest enlargement that the handle snaps to. */
    snapEnlargeMax: 4,
    /** The common grid shows from this cell size on screen, with faint lines below `grid.minCellPx`. */
    gridMinCellPx: 4,
    handlePx: 12,
    handleHitPx: 16,
    warnBadgePx: 18,
    popMs: 360,
    snapRingMs: 320,
    /** The cross fade of "Ver original". */
    originalFadeMs: 120,
  },
  particles: {
    budget: 900,
    maxColors: 64,
    gravity: 900,
    eraseShards: 4,
    eraseMaxTiles: 160,
    sparkLifeS: 0.55,
  },
  sfx: {
    master: 0.32,
    paintMinIntervalMs: 40,
    tickMinIntervalMs: 30,
  },
  ui: {
    toastMs: 3800,
    toastErrorMs: 6000,
    maxToasts: 4,
    progressDelayMs: 150,
    loadPopMs: 420,
    dropBurstCount: 18,
    confettiCount: 56,
    engineDebounceMs: 60,
    maxSwatches: 240,
  },
} as const;
