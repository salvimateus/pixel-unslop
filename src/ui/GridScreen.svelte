<script lang="ts">
  import { untrack } from 'svelte';
  import type { CellGrid, GridFit, Selection } from '../core/types.ts';
  import { app } from '../app/state.svelte.ts';
  import { formatDecimal, t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import { clamp } from './camera.ts';
  import { GridScene, regularBounds, type FitEffect, type GridLine } from './grid-scene.ts';
  import { addLine, cellAt, coverAxis, moveLine, pushLines, removeLine, snapToEdge, strongEdge, type GridFrame } from './grid-lines.ts';
  import CleanupPresets from './CleanupPresets.svelte';
  import GridAdvanced from './GridAdvanced.svelte';
  import GridDetail from './GridDetail.svelte';
  import { holdRepeat } from './hold-repeat.ts';
  import { revealInPanel } from './reveal.ts';
  import Icon from './Icon.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import SetGridRail from './SetGridRail.svelte';
  import Stage from './Stage.svelte';
  import type { StagePointer } from './stage-renderer.ts';

  /** The other pixel size that the edges show after a marked square; the core never applies it. */
  type SizeSuggestion = { period: { x: number; y: number }; kind: 'larger' | 'smaller' };
  /** The notice under the size: a size that the edges suggest, or a mark too small to be a pixel. */
  type SizeNotice = { kind: 'suggestion'; marked: number; suggested: SizeSuggestion } | { kind: 'native' };

  function suggestionOf(next: GridFit): SizeSuggestion | null {
    return (next as GridFit & { suggestion?: SizeSuggestion }).suggestion ?? null;
  }

  const QUALITY_LABELS: Record<1 | 2 | 3, TextKey> = { 1: 'grid.quality1', 2: 'grid.quality2', 3: 'grid.quality3' };
  /** The help of "Ajustar linhas": the gesture first, then what it does. */
  const ADJUST_TIPS: ReadonlyArray<{ key: TextKey; text: TextKey }> = [
    { key: 'grid.tipDragKey', text: 'grid.tipDrag' },
    { key: 'grid.tipFirstKey', text: 'grid.tipFirst' },
    { key: 'grid.tipAltKey', text: 'grid.tipAlt' },
    { key: 'grid.tipShiftKey', text: 'grid.tipShift' },
    { key: 'grid.tipDoubleKey', text: 'grid.tipDouble' },
    { key: 'grid.tipArrowsKey', text: 'grid.tipArrows' },
  ];

  let stage: Stage | undefined = $state();
  let panelScroll: HTMLDivElement | undefined = $state();
  let cellPx = $state(0);
  let dragStart: { x: number; y: number } | null = null;
  let lastQuality = 0;
  /** The pixel size that the live preview shows; the fit that matches it replaces the preview. */
  let previewSize: { x: number; y: number } | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  /** "Ajustar linhas": the user moves, adds and removes grid lines. */
  let adjust = $state(false);
  let cursor = $state('default');
  let selectedLine = $state<GridLine | null>(null);
  let hoverLine: GridLine | null = null;
  let lineDrag: { line: GridLine; moved: boolean; from: CellGrid } | null = null;
  /** The grid during an edit, shown at once before the worker answers. */
  let working: CellGrid | null = null;
  let undoStack = $state<CellGrid[]>([]);
  let redoStack = $state<CellGrid[]>([]);
  let lastClick = { at: 0, x: 0, y: 0 };
  /** Ctrl + drag: the full grid follows the pointer with no size change. */
  let gridDrag: { startX: number; startY: number; from: CellGrid; nudge: { x: number; y: number }; dx: number; dy: number } | null = null;
  /** Ctrl is held with the pointer on the image: the cursor tells that a drag moves the grid. */
  let ctrlHeld = $state(false);
  let notice = $state<SizeNotice | null>(null);
  let hoverInside = false;

  /** The Grade step of a set: the same tools, a piece list on the left and "Limpar tudo!" at the end. */
  const setMode = $derived(app.screen === 'set-grid');
  const piece = $derived(setMode ? app.editingObject : null);
  /** A reference keeps its own automatic grid: the tools only show it. */
  const locked = $derived(piece?.reference ?? false);
  const source = $derived(app.source);
  const scene = $derived(source ? new GridScene(source.bitmap, source.width, source.height) : null);
  const fit = $derived(app.fit);
  /** An automatic fit can differ a little per axis (the core permits it): the main control shows the mean. */
  const sharedScope = $derived(app.set.grid.mode === 'shared');
  /**
   * "Uma grade para todas" shows the one size of the set: the core refines each piece by less than 1% to
   * follow its drawing, and that fine adjustment is not a second size.
   */
  const setPeriod = $derived(setMode && sharedScope && !(piece?.reference ?? true) ? app.set.grid.period : null);
  const period = $derived(setPeriod ?? app.fixedPeriod ?? (fit ? { x: fit.axes.x.period, y: fit.axes.y.period } : { x: 1, y: 1 }));
  /** The size control shows the mean of both sides; the shape slider of "Avançado" sets their ratio. */
  const sizeMean = $derived((period.x + period.y) / 2);
  const shapeRatio = $derived(app.stretched ? period.x / period.y : 1);
  const sizeMin = TUNING.grid.pixelSizeMin;
  const sizeMax = $derived(source ? Math.max(sizeMin + 1, Math.min(TUNING.grid.pixelSizeMax, Math.min(source.width, source.height) / 2)) : TUNING.grid.pixelSizeMax);
  const weak = $derived(fit?.notes.includes('weak-grid') ?? false);
  const notSquare = $derived(app.fixedPeriod !== null && Math.abs(round2(app.fixedPeriod.x) - round2(app.fixedPeriod.y)) >= 0.01);
  const native = $derived(fit?.notes.includes('native-resolution') ?? false);
  const manual = $derived(app.manualGrid !== null);
  const elasticOn = $derived(!manual && (fit?.notes.includes('elastic') ?? false));
  const edgeThreshold = $derived(app.profiles ? { x: strongEdge(app.profiles.x), y: strongEdge(app.profiles.y) } : null);
  /** The square that the user marked: the grid keeps one cell on it. */
  const marked = $derived(app.selection !== null && !manual);
  const pieceCount = $derived(app.set.pieces.length);
  const stageBanner = $derived.by((): { text: string; warn: boolean } | null => {
    if (locked) return { text: t('setGrid.referenceLocked'), warn: false };
    if (weak) return { text: t('grid.weak'), warn: true };
    if (native) return { text: setMode ? t('setGrid.nativePiece') : t('grid.native'), warn: false };
    return null;
  });

  $effect(() => {
    const current = scene;
    if (!current) return;
    current.onLock = () => sfx.play('lock');
    const first = untrack(() => app.fit);
    if (!first) return;
    lastQuality = first.quality;
    current.setFit(first, first.quality === 3 ? 'scan-lock' : 'scan');
    updateCell();
  });

  // A grid from the fit (a new size, a box, Detectar, another piece) ends the history of the hand edits.
  $effect(() => {
    void app.source;
    if (app.manualGrid === null) {
      untrack(() => {
        undoStack = [];
        redoStack = [];
      });
    }
  });

  // The mark moves with the full grid: the core keeps the marked cell at the square plus the offset.
  $effect(() => {
    const mark = app.selection;
    const nudge = app.nudge;
    scene?.setMark(marked && mark ? { ...mark, x: mark.x + nudge.x, y: mark.y + nudge.y } : null);
  });

  // The notice of a marked square belongs to the image that was marked.
  $effect(() => {
    void app.source;
    untrack(() => (notice = null));
  });

  // A reference has no tools: "Ajustar linhas" closes when one opens.
  $effect(() => {
    if (locked) untrack(() => (adjust = false));
  });

  /** Ctrl + drag starts on the image only, with a grid on screen. */
  function startGridDrag(p: StagePointer): boolean {
    const from = currentGrid();
    if (!scene || !from || !insideImage(p)) return false;
    gridDrag = { startX: p.ix, startY: p.iy, from, nudge: { ...app.nudge }, dx: 0, dy: 0 };
    selectedLine = null;
    marks();
    scene.setPressing(true);
    return true;
  }

  function moveGridDrag(p: StagePointer): void {
    if (!gridDrag || !scene) return;
    gridDrag.dx = p.ix - gridDrag.startX;
    gridDrag.dy = p.iy - gridDrag.startY;
    // A manual grid or a preview on screen moves as lines; the fit moves with its flexible lines and its mark.
    if (manual || working) scene.setPreview(shiftGrid(gridDrag.from, gridDrag.dx, gridDrag.dy), 0);
    else scene.setShift({ x: gridDrag.dx, y: gridDrag.dy });
  }

  function shiftGrid(grid: CellGrid, dx: number, dy: number): CellGrid {
    return { x: grid.x.map((v) => v + dx), y: grid.y.map((v) => v + dy) };
  }

  /**
   * The release keeps the grid where the user put it. A fitted grid takes the drag as its offset, the offset of
   * "Mover a grade inteira"; lines placed by hand move by the same distance, with free space at the ends filled.
   */
  async function endGridDrag(): Promise<void> {
    const drag = gridDrag;
    gridDrag = null;
    press(false);
    if (!drag || !scene || !source || !fit) return;
    if (Math.abs(drag.dx) < 1e-3 && Math.abs(drag.dy) < 1e-3) {
      scene.setShift(null);
      return;
    }
    sfx.play('tick');
    if (manual || working) {
      const bounds = frame();
      if (!bounds) return;
      const moved = shiftGrid(drag.from, drag.dx, drag.dy);
      const next = { x: coverAxis(Array.from(moved.x), bounds.width, bounds.period.x), y: coverAxis(Array.from(moved.y), bounds.height, bounds.period.y) };
      void commitGrid(next, drag.from);
      return;
    }
    const limit = TUNING.grid.nudgeMax;
    // A regular grid repeats every cell: the offset is kept below one cell, and the same lines stay on screen.
    const regular = !fit.notes.includes('elastic') && !marked;
    const wrap = (value: number, cell: number) => (regular ? value - Math.round(value / cell) * cell : value);
    const x = round2(clamp(wrap(drag.nudge.x + drag.dx, fit.axes.x.period), -limit, limit));
    const y = round2(clamp(wrap(drag.nudge.y + drag.dy, fit.axes.y.period), -limit, limit));
    const next = await app.setNudge(x, y);
    if (!gridDrag) scene.setShift(null);
    showFit(next);
  }

  function onModifierKey(event: KeyboardEvent): void {
    if (event.key !== 'Control' && event.key !== 'Meta') return;
    ctrlHeld = event.type === 'keydown' && hoverInside && !locked;
  }

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  function updateCell(): void {
    cellPx = scene?.cellScreenSize() ?? 0;
  }

  /** The grid flashes and locks only when the fit becomes perfect. */
  function showFit(next: GridFit | null): void {
    if (!next || !scene) return;
    const effect: FitEffect = next.quality === 3 && lastQuality !== 3 ? 'lock' : 'none';
    lastQuality = next.quality;
    scene.setFit(next, effect);
    // An older answer keeps the preview, so the grid never jumps back while the slider still moves.
    if (previewSize && Math.abs(next.axes.x.period - previewSize.x) < 0.006 && Math.abs(next.axes.y.period - previewSize.y) < 0.006) {
      previewSize = null;
      scene.setPreview(null);
    }
    updateCell();
  }

  /**
   * Draws the grid of a new pixel size at once, before the worker answers. After a marked square, the marked cell
   * keeps its center and grows or shrinks around it; else the grid keeps the offset of the current fit.
   */
  function showPreview(x: number, y: number): void {
    if (!scene || !fit || !source) return;
    previewSize = { x, y };
    const mark = app.selection;
    const offsetX = mark ? mark.x + mark.w / 2 - x / 2 + app.nudge.x : fit.axes.x.offset;
    const offsetY = mark ? mark.y + mark.h / 2 - y / 2 + app.nudge.y : fit.axes.y.offset;
    scene.setPreview({ x: regularBounds(offsetX, x, source.width), y: regularBounds(offsetY, y, source.height) }, Math.min(x, y));
    updateCell();
  }

  /** While a square is drawn, the grid that it would give: one cell on the square, the others at its size. */
  function previewBox(box: Selection): void {
    if (!scene || !source) return;
    const cell = Math.min(box.w, box.h);
    if (cell < TUNING.grid.minBoxSourcePx) {
      scene.setPreview(null);
      return;
    }
    previewSize = null;
    scene.setPreview({ x: regularBounds(box.x, box.w, source.width), y: regularBounds(box.y, box.h, source.height) }, cell);
  }

  /** "Mover a grade inteira": the grid on screen moves at once; the fit of the worker replaces it. */
  function previewNudge(dx: number, dy: number): void {
    const grid = scene?.grid;
    if (!scene || !grid || !fit) return;
    previewSize = null;
    scene.setPreview({ x: grid.x.map((v) => v + dx), y: grid.y.map((v) => v + dy) }, Math.min(fit.axes.x.period, fit.axes.y.period));
  }

  function showNudged(next: GridFit | null): void {
    if (!next) return;
    scene?.setPreview(null);
    showFit(next);
  }

  /** While a size control is pressed, the grid shows at any zoom; the normal rule returns a moment after the release. */
  function press(on: boolean): void {
    clearTimeout(pressTimer);
    if (on) scene?.setPressing(true);
    else pressTimer = setTimeout(() => scene?.setPressing(false), TUNING.grid.pressHoldMs);
  }

  function clampToImage(p: StagePointer): { x: number; y: number } {
    return { x: clamp(p.ix, 0, source?.width ?? 0), y: clamp(p.iy, 0, source?.height ?? 0) };
  }

  function insideImage(p: StagePointer): boolean {
    return !!source && p.ix >= 0 && p.iy >= 0 && p.ix <= source.width && p.iy <= source.height;
  }

  /**
   * The box is a square: its side is the larger movement, so a flat drag that measures the width of one pixel
   * still marks a square pixel. With "Minha arte está esticada" on, it is the rectangle of the drag.
   */
  function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }): Selection {
    const right = b.x >= a.x;
    const down = b.y >= a.y;
    const width = source?.width ?? 0;
    const height = source?.height ?? 0;
    if (app.stretched) {
      const w = Math.min(Math.abs(b.x - a.x), right ? width - a.x : a.x);
      const h = Math.min(Math.abs(b.y - a.y), down ? height - a.y : a.y);
      return { x: right ? a.x : a.x - w, y: down ? a.y : a.y - h, w, h };
    }
    const room = Math.min(right ? width - a.x : a.x, down ? height - a.y : a.y);
    const side = Math.min(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)), Math.max(0, room));
    return { x: right ? a.x : a.x - side, y: down ? a.y : a.y - side, w: side, h: side };
  }

  function marks(): void {
    scene?.setLineMarks({ hover: adjust ? hoverLine : null, selected: adjust ? selectedLine : null, dragging: lineDrag?.moved ?? false });
  }

  /** The current grid of the stage, as the start of an edit. */
  function currentGrid(): CellGrid | null {
    const grid = scene?.grid;
    return grid ? { x: grid.x.slice(), y: grid.y.slice() } : null;
  }

  /** The image and the period that an edit fills free space with. */
  function frame(): GridFrame | null {
    if (!source || !fit) return null;
    return { width: source.width, height: source.height, period: { x: fit.axes.x.period, y: fit.axes.y.period } };
  }

  /** One undoable edit: shows the grid at once and sends it to the worker. */
  async function commitGrid(next: CellGrid, previous: CellGrid): Promise<void> {
    undoStack = [...undoStack, previous];
    redoStack = [];
    await sendGrid(next);
  }

  async function sendGrid(next: CellGrid): Promise<void> {
    working = next;
    scene?.setPreview(next, 0);
    const fitted = await app.setManualGrid(next);
    if (fitted && working === next) {
      working = null;
      scene?.setPreview(null);
      showFit(fitted);
    }
  }

  function undoLine(): void {
    const previous = undoStack.at(-1);
    const now = currentGrid();
    if (!previous || !now) return;
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, now];
    selectedLine = null;
    sfx.play('undo');
    void sendGrid(previous);
  }

  function redoLine(): void {
    const next = redoStack.at(-1);
    const now = currentGrid();
    if (!next || !now) return;
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, now];
    selectedLine = null;
    sfx.play('undo');
    void sendGrid(next);
  }

  async function restoreGrid(): Promise<void> {
    undoStack = [];
    redoStack = [];
    selectedLine = null;
    working = null;
    scene?.setPreview(null);
    sfx.play('tick');
    showFit(await app.restoreGrid());
    marks();
  }

  function snapped(axis: 'x' | 'y', value: number, free: boolean): number {
    if (free || !app.profiles || !edgeThreshold || !scene) return value;
    const radius = TUNING.grid.lineSnapPx / Math.max(app.stage?.camera.zoom ?? 1, 1e-6);
    return snapToEdge(app.profiles[axis], edgeThreshold[axis], value, radius);
  }

  /** A double click removes the line under it, or splits the cell under it across its longer side. */
  function onDoubleClick(p: StagePointer, line: GridLine | null): void {
    const grid = currentGrid();
    const bounds = frame();
    if (!grid || !bounds) return;
    if (line) {
      const next = removeLine(grid, line.axis, line.index, bounds);
      if (!next) return;
      selectedLine = null;
      sfx.play('erase');
      void commitGrid(next, grid);
      return;
    }
    const cell = cellAt(grid, p.ix, p.iy);
    if (!cell) return;
    const axis = cell.w >= cell.h ? 'x' : 'y';
    const next = addLine(grid, axis, snapped(axis, axis === 'x' ? p.ix : p.iy, p.shift), bounds);
    if (!next) return;
    sfx.play('paint');
    void commitGrid(next, grid);
  }

  /** The default drag pushes the later lines with the dragged one; Alt moves the one line only. */
  function shiftLine(grid: CellGrid, axis: 'x' | 'y', index: number, value: number, single: boolean): CellGrid {
    const bounds = frame();
    if (!bounds) return grid;
    return single ? moveLine(grid, axis, index, value, bounds) : pushLines(grid, axis, index, value, bounds);
  }

  function onAdjustDown(p: StagePointer): boolean {
    if (!scene) return false;
    const line = scene.lineAt(p.sx, p.sy);
    const now = performance.now();
    const twice = now - lastClick.at < TUNING.grid.doubleClickMs && Math.hypot(p.sx - lastClick.x, p.sy - lastClick.y) < TUNING.grid.lineHitPx;
    lastClick = { at: twice ? 0 : now, x: p.sx, y: p.sy };
    if (twice) {
      onDoubleClick(p, line);
      return false;
    }
    selectedLine = line;
    marks();
    const from = currentGrid();
    if (!line || !from) return false;
    lineDrag = { line, moved: false, from };
    working = from;
    return true;
  }

  /** Each step of a drag starts from the grid at the press, so a long drag never piles up the corrections of the steps. */
  function onAdjustMove(p: StagePointer): void {
    if (!lineDrag || !scene) return;
    const { axis, index } = lineDrag.line;
    const value = snapped(axis, axis === 'x' ? p.ix : p.iy, p.shift);
    working = shiftLine(lineDrag.from, axis, index, value, p.alt);
    lineDrag.moved = true;
    scene.setPreview(working, 0);
    marks();
  }

  function onAdjustUp(): void {
    const drag = lineDrag;
    lineDrag = null;
    marks();
    if (!drag?.moved || !working) {
      working = null;
      return;
    }
    const next = working;
    // The moved line can change index when lines left the image: the selection follows the line, not the index.
    selectedLine = null;
    marks();
    sfx.play('tick');
    void commitGrid(next, drag.from);
  }

  /** Arrow keys move the selected line, Delete removes it, Ctrl+Z and Ctrl+Y undo and redo. */
  function onAdjustKey(event: KeyboardEvent): void {
    if (!adjust || app.confirmRequest || app.aboutOpen) return;
    const target = event.target;
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoLine();
      return;
    }
    if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      redoLine();
      return;
    }
    const line = selectedLine;
    const grid = currentGrid();
    const bounds = frame();
    if (!line || !grid || !bounds || mod) return;
    const step = event.shiftKey ? 1 : TUNING.grid.lineKeyStep;
    const moves: Record<string, number> = line.axis === 'x' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
    if (event.key in moves) {
      event.preventDefault();
      event.stopPropagation();
      const next = shiftLine(grid, line.axis, line.index, grid[line.axis][line.index] + moves[event.key], event.altKey);
      // A move that changed the number of lines before the selected one ends the selection.
      if (next[line.axis].length !== grid[line.axis].length) selectedLine = null;
      void commitGrid(next, grid);
      marks();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const next = removeLine(grid, line.axis, line.index, bounds);
      if (!next) return;
      selectedLine = null;
      void commitGrid(next, grid);
    } else if (event.key === 'Escape') {
      selectedLine = null;
      marks();
    }
  }

  /** The tool shows alone in the panel, from its top; "Pronto" brings the other controls back. */
  function toggleAdjust(): void {
    adjust = !adjust;
    selectedLine = null;
    hoverLine = null;
    sfx.play('tick');
    marks();
    if (panelScroll) panelScroll.scrollTop = 0;
  }

  /** An opened "Avançado" shows its first block in the panel. */
  function onAdvancedToggle(event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement;
    if (details.open) revealInPanel(details.querySelector('.advanced-body > :first-child'));
  }

  async function clearMark(): Promise<void> {
    notice = null;
    sfx.play('tick');
    showFit(await app.clearMark());
  }

  function onHover(p: StagePointer | null): void {
    scene?.setFocus(p && insideImage(p) ? { x: p.ix, y: p.iy } : null);
    hoverInside = !!p && insideImage(p);
    ctrlHeld = !!p && p.ctrl && hoverInside && !locked;
    if (!adjust || !scene) return;
    const line = p ? scene.lineAt(p.sx, p.sy) : null;
    if (line?.axis === hoverLine?.axis && line?.index === hoverLine?.index) return;
    hoverLine = line;
    cursor = line ? (line.axis === 'x' ? 'ew-resize' : 'ns-resize') : 'default';
    marks();
  }

  function onDown(p: StagePointer): boolean {
    if (locked) return false;
    if (p.ctrl) return startGridDrag(p);
    if (adjust) return onAdjustDown(p);
    if (!scene || !insideImage(p)) return false;
    dragStart = clampToImage(p);
    scene.setDrag(boxFrom(dragStart, dragStart), { x: p.sx, y: p.sy });
    return true;
  }

  function onMove(p: StagePointer): void {
    if (gridDrag) {
      moveGridDrag(p);
      return;
    }
    if (adjust) {
      onAdjustMove(p);
      return;
    }
    if (!dragStart || !scene) return;
    const box = boxFrom(dragStart, clampToImage(p));
    scene.setDrag(box, { x: p.sx, y: p.sy });
    previewBox(box);
  }

  async function onUp(p: StagePointer): Promise<void> {
    if (gridDrag) {
      await endGridDrag();
      return;
    }
    if (adjust) {
      onAdjustUp();
      return;
    }
    if (!dragStart || !scene) return;
    const box = boxFrom(dragStart, clampToImage(p));
    dragStart = null;
    if (box.w < TUNING.grid.minBoxSourcePx || box.h < TUNING.grid.minBoxSourcePx) {
      scene.setDrag(null, null);
      scene.setPreview(null);
      return;
    }
    scene.setDrag(box, null);
    sfx.play('tick');
    const next = await app.fitBox(box);
    scene.setPreview(null);
    if (!next) {
      scene.setDrag(null, null);
      updateCell();
      return;
    }
    showFit(next);
    scene.settleBox(box);
    const suggested = suggestionOf(next);
    if (next.notes.includes('native-resolution')) notice = { kind: 'native' };
    else if (suggested) notice = { kind: 'suggestion', marked: (next.axes.x.period + next.axes.y.period) / 2, suggested };
    else notice = null;
  }

  async function useSuggestion(): Promise<void> {
    if (notice?.kind !== 'suggestion') return;
    const { period } = notice.suggested;
    notice = null;
    sfx.play('tick');
    showFit(await app.useSuggestedSize(period));
  }

  async function setSize(x: number, y: number): Promise<void> {
    notice = null;
    const nx = round2(clamp(x, sizeMin, sizeMax));
    const ny = round2(clamp(y, sizeMin, sizeMax));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    sfx.play('tick');
    showPreview(nx, ny);
    const next = await app.setPixelSize(nx, ny);
    // The user kept the lines adjusted by hand: the preview of the new size goes away.
    if (!next && app.manualGrid && scene) {
      previewSize = null;
      scene.setPreview(null);
      updateCell();
    }
    showFit(next);
  }

  function stepSize(direction: 1 | -1, large: boolean): void {
    const step = large ? TUNING.grid.sizeButtonStepShift : TUNING.grid.sizeButtonStep;
    press(true);
    setMean(sizeMean + direction * step);
  }

  /** A new size from the size control, with the shape that the art pixel has now. */
  function setMean(value: number): void {
    const r = shapeRatio;
    void setSize((2 * value * r) / (1 + r), (2 * value) / (1 + r));
  }

  function onSliderInput(event: Event): void {
    setMean(Math.exp(Number((event.currentTarget as HTMLInputElement).value)));
  }

  function onSliderKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? TUNING.grid.sliderStepShift : TUNING.grid.sliderStep;
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    press(true);
    setMean(sizeMean + direction * step);
  }

  function onNumberChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      input.value = sizeMean.toFixed(2);
      return;
    }
    press(true);
    press(false);
    setMean(value);
  }

  async function detect(): Promise<void> {
    notice = null;
    sfx.play('tick');
    showFit(await app.detectAuto());
  }

  function zoomToGrid(): void {
    if (!stage || cellPx <= 0) return;
    stage.zoomBy(TUNING.zoom.gridFirstCellPx / cellPx);
  }

  function primary(): void {
    if (setMode) void app.cleanSet();
    else void app.clean();
  }
</script>

<svelte:window onpointerup={() => press(false)} onpointercancel={() => press(false)} onkeydowncapture={onAdjustKey} onkeydown={onModifierKey} onkeyup={onModifierKey} onblur={() => (ctrlHeld = false)} />

<section class="grid-screen" class:is-set={setMode}>
  {#if setMode}<SetGridRail />{/if}

  <div class="grid-stage">
    {#if scene}
      <Stage
        bind:this={stage}
        {scene}
        label={t('grid.stageLabel')}
        cursor={locked ? 'grab' : ctrlHeld ? 'move' : adjust ? cursor : 'crosshair'}
        onhover={onHover}
        onprimarydown={onDown}
        onprimarymove={onMove}
        onprimaryup={onUp}
        onviewchange={updateCell}
      >
        {#if stageBanner}
          <p class="stage-banner" class:is-warn={stageBanner.warn}>
            <Icon name={locked ? 'lock' : 'info'} size={18} />
            {stageBanner.text}
          </p>
        {/if}
        {#if fit && cellPx > 0 && cellPx < TUNING.grid.minCellPx}
          <button type="button" class="zoom-hint" onclick={zoomToGrid}>
            <Icon name="zoomIn" size={18} />
            {t('grid.zoomHint')}
          </button>
        {/if}
        <div class="stage-zoom">
          <button type="button" class="icon-btn" aria-label={t('clean.zoomOut')} title={t('clean.zoomOut')} onclick={() => stage?.zoomBy(1 / TUNING.zoom.buttonStep)}>
            <Icon name="zoomOut" />
          </button>
          <button type="button" class="icon-btn" aria-label={t('clean.zoomIn')} title={t('clean.zoomIn')} onclick={() => stage?.zoomBy(TUNING.zoom.buttonStep)}>
            <Icon name="zoomIn" />
          </button>
          <button type="button" class="icon-btn" aria-label={t('clean.fit')} title={t('clean.fit')} onclick={() => stage?.fitView()}>
            <Icon name="fit" />
          </button>
        </div>
      </Stage>
    {/if}
    <ProgressPill />
  </div>

  <aside class="grid-panel">
    <div class="grid-panel-scroll" bind:this={panelScroll}>
      {#if adjust}
        <section class="adjust-box" aria-labelledby="adjust-title">
          <h1 class="grid-title" id="adjust-title">{t('grid.adjustTitle')}</h1>
          <ul class="adjust-tips">
            {#each ADJUST_TIPS as tip (tip.key)}
              <li class="adjust-tip"><span class="tip-key">{t(tip.key)}</span><span class="tip-text">{t(tip.text)}</span></li>
            {/each}
          </ul>
          <div class="adjust-row">
            <button type="button" class="btn btn-quiet adjust-action" title="{t('clean.undo')} (Ctrl+Z)" disabled={undoStack.length === 0} onclick={undoLine}><Icon name="undo" size={16} />{t('clean.undo')}</button>
            <button type="button" class="btn btn-quiet adjust-action" title="{t('clean.redo')} (Ctrl+Y)" disabled={redoStack.length === 0} onclick={redoLine}><Icon name="redo" size={16} />{t('clean.redo')}</button>
          </div>
          <div class="adjust-row">
            <button type="button" class="btn btn-quiet adjust-action" title={t('grid.restore')} onclick={restoreGrid} disabled={!manual}>{t('grid.restoreShort')}</button>
            <button type="button" class="btn btn-quiet adjust-action is-done" onclick={toggleAdjust}><Icon name="check" size={16} />{t('grid.adjustDone')}</button>
          </div>
        </section>
      {:else}
      <header class="grid-head">
        {#if (setMode || app.editingId !== null) && source}<p class="piece-tag">{t('clean.piece', { name: source.name })}</p>{/if}
        <h1 class="grid-title">{t('grid.title')}</h1>
        <p class="hint grid-goal">{t('grid.goal')}</p>
      </header>

      <fieldset class="tools" disabled={locked || !fit}>
        <legend class="visually-hidden">{t('grid.toolsLabel')}</legend>

        <section class="size-hero" aria-labelledby="pixel-size-label">
          <div class="size-head">
            <label class="size-label" id="pixel-size-label" for="pixel-size-number">{t('grid.pixelSize')}</label>
            {#if setMode && !locked}
              <span class="size-scope" class:is-shared={sharedScope} title={sharedScope ? t('setGrid.scopeAllHint') : undefined}>
                <Icon name={sharedScope ? 'pieces' : 'image'} size={14} />
                {sharedScope ? t('setGrid.scopeAll', { count: pieceCount }) : t('setGrid.scopeOne')}
              </span>
            {/if}
          </div>
          <div class="size-value">
            <button
              type="button"
              class="icon-btn size-step"
              aria-label={t('grid.sizeDown')}
              title="{t('grid.sizeDown')} (Shift: {formatDecimal(TUNING.grid.sizeButtonStepShift)})"
              use:holdRepeat={{ step: (large) => stepSize(-1, large), release: () => press(false) }}
            >
              <span class="step-sign" aria-hidden="true">−</span>
            </button>
            <span class="size-number-box">
              <input
                id="pixel-size-number"
                name="pixel-size"
                class="size-number"
                type="number"
                inputmode="decimal"
                min={sizeMin}
                max={sizeMax}
                step="0.01"
                value={sizeMean.toFixed(2)}
                onchange={onNumberChange}
              />
              <span class="size-unit">{t('grid.pixelSizeUnit')}</span>
            </span>
            <button
              type="button"
              class="icon-btn size-step"
              aria-label={t('grid.sizeUp')}
              title="{t('grid.sizeUp')} (Shift: {formatDecimal(TUNING.grid.sizeButtonStepShift)})"
              use:holdRepeat={{ step: (large) => stepSize(1, large), release: () => press(false) }}
            >
              <span class="step-sign" aria-hidden="true">+</span>
            </button>
          </div>
          {#if notice}
            <div class="size-notice" role="status">
              <p class="size-notice-text">
                {#if notice.kind === 'native'}
                  {t('grid.markNative')}
                {:else}
                  {t('grid.suggestText', { marked: formatDecimal(notice.marked), size: formatDecimal((notice.suggested.period.x + notice.suggested.period.y) / 2) })}
                {/if}
              </p>
              {#if notice.kind === 'suggestion'}
                <button type="button" class="mini-btn notice-use" onclick={useSuggestion}>{t('grid.suggestUse', { size: formatDecimal((notice.suggested.period.x + notice.suggested.period.y) / 2) })}</button>
              {/if}
              <button type="button" class="icon-btn notice-close" aria-label={t('grid.noticeClose')} title={t('grid.noticeClose')} onclick={() => (notice = null)}><Icon name="close" size={14} /></button>
            </div>
          {/if}
          <input
            id="pixel-size-slider"
            name="pixel-size-slider"
            class="size-slider"
            type="range"
            min={Math.log(sizeMin)}
            max={Math.log(sizeMax)}
            step="0.0005"
            value={Math.log(sizeMean)}
            aria-label={t('grid.pixelSize')}
            aria-valuetext="{formatDecimal(sizeMean)} {t('grid.pixelSizeUnit')}"
            aria-describedby="pixel-size-hint"
            oninput={onSliderInput}
            onkeydown={onSliderKey}
            onkeyup={() => press(false)}
            onpointerdown={() => press(true)}
            onblur={() => press(false)}
          />
          <p class="visually-hidden" id="pixel-size-hint">{t('grid.pixelSizeHint')}</p>
          {#if scene}<GridDetail {scene} />{/if}

          {#if fit}
            <div class="readout">
              <p class="readout-count">{t('grid.count', { cols: fit.cols, rows: fit.rows })}</p>
              <div class="meter" role="img" aria-label={t('grid.quality', { stars: fit.quality })}>
                {#each [1, 2, 3] as star (star)}
                  <span class="meter-star" class:is-on={star <= fit.quality}>
                    <Icon name="star" size={16} filled={star <= fit.quality} />
                  </span>
                {/each}
                <span class="meter-label">{t(QUALITY_LABELS[fit.quality])}</span>
              </div>
            </div>
            {#if manual}
              <p class="grid-state is-manual"><Icon name="pencil" size={16} />{t('grid.manualNote')}</p>
            {:else if elasticOn}
              <p class="grid-state"><Icon name="grid" size={16} />{t('grid.elasticActive')}</p>
            {/if}
            {#if notSquare}
              <p class="grid-state is-warn"><Icon name="alert" size={16} />{t('grid.notSquare', { x: formatDecimal(period.x), y: formatDecimal(period.y) })}</p>
            {/if}
          {/if}
        </section>

        <section class="ways" aria-labelledby="ways-title">
          <h2 class="section-title" id="ways-title">{t('grid.otherWays')}</h2>
          <div class="way">
            <span class="way-icon" aria-hidden="true"><Icon name="fit" size={18} /></span>
            <div class="way-text">
              <p><strong>{t('grid.markTitle')}</strong> {app.stretched ? t('grid.markHelpRect') : t('grid.markHelp')}</p>
              {#if marked}
                <p class="mark-state">
                  <span class="mark-swatch" aria-hidden="true"></span>
                  <span class="mark-text">{t('grid.markActive')}</span>
                  <button type="button" class="mini-btn mark-clear" title={t('grid.markClearHint')} onclick={clearMark}>{t('grid.markClear')}</button>
                </p>
              {/if}
            </div>
          </div>
          <p class="way-move"><span class="tip-key">{t('grid.moveKey')}</span>{t('grid.moveHelp')}</p>
          <div class="way is-stacked">
            <button type="button" class="btn btn-quiet way-btn" onclick={detect}>
              <Icon name="wand" size={18} />
              {t('grid.auto')}
            </button>
            <p class="hint way-hint">{setMode && sharedScope ? t('setGrid.autoAll') : t('grid.autoHint')}</p>
          </div>
        </section>

        <section class="extras" aria-label={t('grid.extrasLabel')}>
          <button type="button" class="btn btn-quiet adjust-btn" aria-pressed={adjust} onclick={toggleAdjust}>
            <Icon name="arrows" size={18} />
            {t('grid.adjust')}
          </button>

          <details class="advanced" ontoggle={onAdvancedToggle}>
            <summary class="advanced-summary">{t('grid.advanced')}</summary>
            <GridAdvanced {period} onsize={(x, y) => void setSize(x, y)} onpress={press} onnudgepreview={previewNudge} onfit={showNudged} />
          </details>
        </section>
      </fieldset>
      {/if}
    </div>

    <div class="grid-footer">
      <CleanupPresets hint={t('cleanup.hintBefore')} />
      {#if app.gridRejected}
        <p class="footer-note is-error" role="alert"><Icon name="alert" size={16} />{t('grid.rejected')}</p>
      {:else if setMode}
        <p class="footer-note">{t('setGrid.next', { count: pieceCount })}</p>
      {/if}
      <div class="grid-actions">
        <button type="button" class="btn btn-quiet" title={setMode ? t('setGrid.back') : t('grid.back')} onclick={() => app.goTo('drop')}>
          <Icon name="back" size={18} />
          {#if setMode}<span class="visually-hidden">{t('setGrid.back')}</span>{:else}{t('grid.back')}{/if}
        </button>
        <button type="button" class="btn btn-primary btn-big" onclick={primary} disabled={!fit || app.cleaning || app.loading || app.gridRejected}>
          <Icon name="sparkle" size={20} />
          {setMode ? t('setGrid.cleanAll') : t('grid.clean')}
        </button>
      </div>
    </div>
  </aside>
</section>

<style>
  @layer components {
    .grid-screen {
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--panel-w);
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;

      &.is-set {
        grid-template-columns: var(--set-rail-w) minmax(0, 1fr) var(--panel-w);
      }
    }

    .grid-stage {
      position: relative;
      container-type: inline-size;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .stage-banner {
      position: absolute;
      top: var(--space-3);
      left: 50%;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: max-content;
      max-width: calc(100% - 32px);
      padding: var(--space-2) var(--space-4);
      color: var(--text);
      background: var(--surface-2);
      border: 2px solid var(--teal);
      border-radius: var(--radius-m);
      box-shadow: 0 4px 0 var(--depth);
      translate: -50% 0;
      animation: banner-in var(--dur-pop) var(--ease-out);

      &.is-warn {
        border-color: var(--yellow);
      }

      & :global(.icon) {
        flex: none;
      }
    }

    .zoom-hint {
      position: absolute;
      left: 50%;
      bottom: var(--space-4);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      font: 600 0.9375rem/1 var(--font-display);
      color: var(--on-primary);
      background: var(--primary);
      border-radius: 999px;
      box-shadow: 0 4px 0 var(--primary-depth);
      translate: -50% 0;
      transition: transform var(--dur-hover) var(--ease-sym);

      &:active {
        transform: translateY(2px);
      }
    }

    /* A narrow stage (a small window or a large zoom): the hint goes above the zoom buttons. */
    @container (width < 560px) {
      .zoom-hint {
        bottom: 68px;
        white-space: nowrap;
      }
    }

    .stage-zoom {
      position: absolute;
      left: var(--space-3);
      bottom: var(--space-3);
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .grid-panel {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .grid-panel-scroll {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-5) var(--space-5);
      overflow: hidden auto;
    }

    .grid-head {
      display: grid;
      gap: var(--space-1);
    }

    .grid-title {
      font-size: 1.375rem;
      line-height: 1.2;
      text-wrap: balance;
    }

    .grid-goal {
      color: var(--text-muted);
    }

    .piece-tag {
      justify-self: start;
      max-width: 100%;
      padding: 2px var(--space-2);
      overflow: hidden;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      font: 600 0.8125rem/1.3 var(--font-body);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tools {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-5);
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;

      &:disabled .size-hero,
      &:disabled .ways,
      &:disabled .extras {
        opacity: 0.55;
      }
    }

    /* The main job of the screen: the largest and first control of the panel. */
    .size-hero {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-3);
      background: var(--surface-sunken);
      border: 2px solid var(--primary-depth);
      border-radius: var(--radius-l);
      box-shadow: 0 4px 0 var(--depth);
    }

    .size-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-1) var(--space-2);
    }

    .size-label {
      font: 700 1rem/1.2 var(--font-body);
    }

    .size-scope {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 6px;
      color: var(--text-muted);
      background: var(--surface-2);
      border-radius: var(--radius-s);
      font-size: 0.75rem;
      font-weight: 600;

      &.is-shared {
        color: var(--on-primary);
        background: var(--teal);
      }
    }

    .size-value {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-2);
    }

    .size-step {
      width: 40px;
      height: 40px;
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      touch-action: none;

      &:active:not(:disabled) {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
      }
    }

    .step-sign {
      font: 700 1.625rem/1 var(--font-body);
    }

    .size-number-box {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: var(--space-1);
      min-width: 0;
    }

    .size-number {
      flex: 0 0 auto;
      width: 5.2ch;
      min-width: 0;
      padding: 0;
      color: var(--text);
      background: transparent;
      border: 0;
      border-bottom: 2px solid var(--line-strong);
      border-radius: 0;
      font: 700 1.875rem/1.15 var(--font-body);
      font-variant-numeric: tabular-nums;
      text-align: center;
      appearance: textfield;

      &::-webkit-inner-spin-button,
      &::-webkit-outer-spin-button {
        appearance: none;
        margin: 0;
      }

      &:hover {
        border-bottom-color: var(--primary-edge);
      }

      &:focus-visible {
        outline: 3px solid var(--focus);
        outline-offset: 2px;
        border-radius: var(--radius-s);
      }
    }

    .size-unit {
      flex: none;
      color: var(--text-muted);
      font: 600 1rem/1 var(--font-body);
    }

    .size-slider {
      width: 100%;
      height: 28px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .readout {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-1) var(--space-3);
    }

    .readout-count {
      font: 600 0.9375rem/1.2 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .meter {
      display: flex;
      align-items: center;
      gap: 1px;
    }

    .meter-star {
      color: var(--line-strong);

      &.is-on {
        color: var(--yellow);
        animation: star-pop var(--dur-modal) var(--ease-spring);
      }
    }

    .meter-label {
      margin-left: var(--space-1);
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .grid-state {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--teal);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;

      &.is-manual {
        color: var(--primary);
      }

      &.is-warn {
        color: var(--yellow);
      }

      & :global(.icon) {
        flex: none;
        margin-top: 1px;
      }
    }

    .ways {
      display: grid;
      gap: var(--space-3);
    }

    .way {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2) var(--space-3);
    }

    .way-icon {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      color: var(--primary);
      background: var(--surface-2);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .way-move {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-2);
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .way.is-stacked {
      grid-template-columns: minmax(0, 1fr);
      justify-items: start;
    }

    .way-text {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
      font-size: 0.875rem;
      line-height: 1.4;
      color: var(--text-muted);

      & strong {
        display: block;
        color: var(--text);
      }
    }

    .size-notice {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: var(--space-2);
      padding: var(--space-2);
      background: var(--surface-2);
      border: 2px solid var(--yellow);
      border-radius: var(--radius-m);
    }

    .size-notice-text {
      font-size: 0.8125rem;
      line-height: 1.35;
      font-variant-numeric: tabular-nums;
    }

    .notice-close {
      grid-column: 2;
      grid-row: 1;
      width: 24px;
      height: 24px;
    }

    .notice-use {
      grid-column: 1 / -1;
      justify-self: start;
      min-height: 30px;
      padding: 0 var(--space-2);
      color: var(--on-primary);
      background: var(--yellow);
      border-radius: var(--radius-s);
      font: 600 0.8125rem/1 var(--font-display);
      transition: transform var(--dur-hover) var(--ease-sym);

      &:active {
        transform: translateY(1px);
        transition-duration: 60ms;
      }
    }

    .mark-state {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-2);
      color: var(--text);
      font-size: 0.8125rem;
    }

    .mark-swatch {
      flex: none;
      width: 12px;
      height: 12px;
      border: 2px solid var(--primary);
    }

    .mark-text {
      flex: 1 1 8rem;
      min-width: 0;
    }

    .mark-clear {
      min-height: 28px;
      padding: 0 var(--space-2);
      color: var(--text-muted);
      font: 600 0.8125rem/1 var(--font-display);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
      transition:
        color var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover {
        color: var(--text);
        background: var(--surface-3);
      }

      &:active {
        transform: translateY(1px);
        transition-duration: 60ms;
      }
    }

    .way-btn {
      min-height: 36px;
      padding: 0 var(--space-3);
      font-size: 0.9375rem;
    }

    .way-hint {
      font-size: 0.8125rem;
    }

    .extras {
      display: grid;
      gap: var(--space-3);
      padding-top: var(--space-3);
      border-top: 2px solid var(--line);
    }

    .adjust-btn {
      justify-self: start;
      min-height: 36px;
      padding: 0 var(--space-3);
      font-size: 0.9375rem;

      &[aria-pressed='true'] {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
      }
    }

    .adjust-box {
      display: grid;
      gap: var(--space-3);
    }

    /* Two equal buttons per row, centered: Desfazer and Refazer, then Restaurar and Pronto. */
    .adjust-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }

    .adjust-action {
      gap: var(--space-1);
      min-width: 0;
      min-height: 36px;
      padding: 0 var(--space-2);
      font-size: 0.875rem;
      white-space: nowrap;

      &.is-done {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
      }
    }

    .adjust-tips {
      display: grid;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .adjust-tip {
      font-size: 0.875rem;
      line-height: 1.4;
    }

    .adjust-tip .tip-key {
      margin-right: var(--space-1);
    }

    .tip-key {
      display: inline-block;
      padding: 0 var(--space-1);
      color: var(--text);
      background: var(--surface-3);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-s);
      font-weight: 700;
      font-size: 0.8125rem;
    }

    .tip-text {
      color: var(--text-muted);
    }

    .advanced {
      padding-top: var(--space-1);
    }

    .advanced-summary {
      font: 600 1rem/1.4 var(--font-display);
      color: var(--text-muted);
      cursor: pointer;
      border-radius: var(--radius-s);

      &:hover {
        color: var(--text);
      }
    }

    .grid-footer {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-5) var(--space-5);
      background: var(--surface-sunken);
      border-top: 2px solid var(--line);
    }

    .footer-note {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: 0.8125rem;
      line-height: 1.35;

      &.is-error {
        color: var(--danger-text);
      }

      & :global(.icon) {
        flex: none;
        margin-top: 1px;
      }
    }

    .grid-actions {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
    }

    /* Short windows keep the helper of the cleanup level for screen readers only, so the size control keeps its room. */
    @media (max-height: 760px) {
      .grid-footer :global(.cleanup-hint) {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }

      .grid-footer {
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4) var(--space-4);
      }

      .grid-panel-scroll {
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }

      .grid-title {
        font-size: 1.1875rem;
      }

      .size-hero {
        gap: var(--space-2);
        padding: var(--space-3);
      }

      .size-number {
        font-size: 1.75rem;
      }

      .adjust-box {
        gap: var(--space-2);
      }

      .adjust-tips {
        gap: 3px;
      }

      .adjust-tip {
        font-size: 0.8125rem;
        line-height: 1.35;
      }
    }

    @keyframes star-pop {
      0% {
        transform: scale(0.4) rotate(-30deg);
      }
    }

    @keyframes banner-in {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
    }
  }
</style>
