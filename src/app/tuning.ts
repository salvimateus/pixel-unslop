/** Every game-feel constant of the interface. Algorithm constants live in src/core/params.ts. */
export const TUNING = {
  stage: {
    maxDpr: 2,
    fitPadding: 40,
    /** Fraction of the content that must stay inside the viewport while the user pans. */
    panKeepVisible: 0.15,
    keyPanPx: 48,
    /** Space between an overlay of the stage and the fitted content. */
    insetGap: 12,
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
    /** The largest pencil and eraser size, in grid squares; the larger side of the sprite also limits it. */
    brushMax: 32,
    /** The footprint shows this long after a size change, with a short pop. */
    brushFlashMs: 650,
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
    /** A moved object that overlaps another one draws with this opacity, so both show. */
    overlapAlpha: 0.6,
    /** A press on an object moves it only after this many screen pixels; a shorter press selects it. */
    moveThresholdPx: 4,
    /** The cross fade of "Ver original". */
    originalFadeMs: 120,
  },
  anim: {
    /** Playback speed of a new animation, and its range. */
    defaultFps: 12,
    minFps: 1,
    maxFps: 60,
    fpsChips: [6, 8, 10, 12, 15, 24],
    /** The step of the Frames screen at first use; Shift steps this many frames, and so does Shift on the wheel of the step. */
    defaultStep: 4,
    shiftStep: 10,
    stepWheelShift: 5,
    /** Trackpad wheel pixels that make one step of the step control; a mouse notch is one step. */
    stepWheelPx: 50,
    /**
     * The cache of the Frames screen: unpinned frames that were shown or fetched ahead, at most this many and this
     * many raw plus own tiles (4 bytes each). Ahead of the cursor, it fetches this many steps once the user rests this long.
     */
    cacheFrames: 24,
    cacheTiles: 6_000_000,
    prefetchSteps: 3,
    prefetchIdleMs: 220,
    /** While pinned frames arrive one by one, the timeline builds at most once in this time. */
    arrivalBuildMs: 400,
    /** The frame count of the Frames screen shows its limit from this share of it. */
    limitNearShare: 0.8,
    /** Width of the small picture of each video frame, in pixels. */
    monitorPx: 192,
    maxZoom: 96,
    /** The ghost of another frame, drawn over the current frame: its opacity and how far its colors move toward the tint. */
    ghostAlpha: 0.45,
    ghostTint: 0.5,
    /** The pop of an added frame, and its sparks. */
    popMs: 280,
    addSparks: 12,
    /** Side of the thumbnails of the timeline and of the small loop, in CSS pixels. */
    timelineThumbPx: 56,
    loopPreviewPx: 120,
    /** The automatic GIF scale makes the long side about this size, up to the largest scale. */
    gifTargetPx: 384,
    gifMaxScale: 16,
    /** The first container: the opaque box of the first frame plus this margin, in tiles, or this share of its side. */
    containerMarginMin: 2,
    containerMarginShare: 0.2,
    /** The container handles: their size and their hit distance, in screen pixels. */
    handlePx: 10,
    handleHitPx: 12,
    /** The outside of the container on the Frames screen, and the frame content outside the cell on the Align step. */
    outsideDim: 0.55,
    /** The Align step: the tiles of frame shown around the cell, the Shift nudge and the axis highlight. */
    alignPadTiles: 8,
    nudgeShift: 5,
    nudgeTickMs: 60,
    axisFlashMs: 360,
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
    /**
     * Interface zoom of the desktop window, in percent: the range, the step of one key press, and the zoom of
     * the first start when the monitor holds the smallest layout at it (else 100).
     */
    zoom: { min: 50, max: 200, step: 5, default: 125 },
    /** The zoom indicator hides after this time with no change and no pointer on it. */
    zoomIndicatorMs: 2000,
    /** The smallest layout viewport, in CSS pixels; the smallest window grows with the zoom to keep it. */
    minViewport: { width: 960, height: 640 },
    /**
     * The side panel that the user resizes. With no stored width, each screen keeps its own CSS width. The
     * smallest width still holds the panel content; the largest is a share of the screen, and the stage keeps
     * at least `stageMinPx`. Arrow keys move by `stepPx`, with Shift by `bigStepPx`.
     */
    panel: { minPx: 300, maxShare: 0.5, stageMinPx: 360, stepPx: 16, bigStepPx: 64 },
  },
} as const;
