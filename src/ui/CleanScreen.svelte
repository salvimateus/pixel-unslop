<script lang="ts">
  import { untrack } from 'svelte';
  import { TRANSPARENT } from '../core/color.ts';
  import { borderBackground, floodRegion, lineTiles, listPalette } from '../core/sprite.ts';
  import { track } from '../app/analytics.ts';
  import type { ListVariant, ReplacedColor } from '../app/color-list.svelte.ts';
  import { opaqueBox } from '../app/image-set.svelte.ts';
  import { app, type BrushTool, type Tool } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { Tile } from './camera.ts';
  import { CleanScene, type CompareLabels, type HoverMark, type PreviewBackground } from './clean-scene.ts';
  import Icon, { type IconName } from './Icon.svelte';
  import { brushBox, stampIndices } from './brush.ts';
  import BrushSize from './BrushSize.svelte';
  import CleanupPresets from './CleanupPresets.svelte';
  import ReferenceColors from './ReferenceColors.svelte';
  import PalettePanel from './PalettePanel.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import RemoveColors from './RemoveColors.svelte';
  import ReplaceColors from './ReplaceColors.svelte';
  import { changedTiles, historyToast, removedToast, replacedToast } from './list-feedback.ts';
  import Stage from './Stage.svelte';
  import PanelSplitter from './PanelSplitter.svelte';
  import ToleranceSlider from './ToleranceSlider.svelte';
  import { bakePickFlash, bakePickMask, bakeReplaceMask, bakeSprite, PICKER_CURSOR, STALE_MASK, STAGE_COLORS, type StagePointer } from './stage-renderer.ts';

  interface ToolInfo {
    id: Tool;
    icon: IconName;
    label: TextKey;
    key: string;
  }

  const TOOLS: readonly ToolInfo[] = [
    { id: 'view', icon: 'view', label: 'clean.tool.view', key: 'V' },
    { id: 'pencil', icon: 'pencil', label: 'clean.tool.pencil', key: 'B' },
    { id: 'eraser', icon: 'eraser', label: 'clean.tool.eraser', key: 'E' },
    { id: 'bucket', icon: 'bucket', label: 'clean.tool.bucket', key: 'G' },
    { id: 'picker', icon: 'picker', label: 'clean.tool.picker', key: 'I' },
    { id: 'remove', icon: 'colorErase', label: 'clean.tool.remove', key: 'R' },
    { id: 'replace', icon: 'swap', label: 'clean.tool.replace', key: 'C' },
  ];
  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  interface Stroke {
    color: number;
    erase: boolean;
    /** The brush size of the stroke, kept from the press. */
    size: number;
    last: Tile;
    indices: number[];
    /** One flag per square: a stroke changes a square one time only. */
    seen: Uint8Array;
  }

  let stage: Stage | undefined = $state();
  let palettePanel: PalettePanel | undefined = $state();
  let scene = $state.raw<CleanScene | null>(null);
  let sceneAligned: ImageBitmap | null = null;
  let stroke: Stroke | null = null;
  /** The square under the pointer, for the hover outline and the footprint of a size change. */
  let lastTile: Tile | null = null;
  let draggingSplit = false;
  let overSplit = $state(false);
  let splitPercent = $state(0);

  /** The frame editor of an animation: one timeline entry, with the palette of the whole animation. */
  const frameMode = app.screen === 'anim-edit';
  /** The onion ghost of the previous entry, in the frame editor only. */
  let onion = $state(false);
  /** The lists of this journey: the animation in the frame editor, the set in the piece editor, else the single image. */
  const lists = $derived(app.cleanLists);
  const variant = $derived<ListVariant>(frameMode ? 'frames' : app.editingId !== null ? 'set' : 'image');
  /** The OKLab tolerance of the next pick of the active list tool. */
  const tolerance = $derived(app.tool === 'replace' ? lists.replaced.tolerance : lists.removed.tolerance);
  /** What the shown mask of a list tool was made from, so a hover on the same color bakes nothing. */
  let maskKey = STALE_MASK;
  /** The pointer is on a spot that does not reach the border: a click there erases the color inside the drawing too. */
  let pickInside = $state(false);

  const result = $derived(app.result);
  /** The frame editor shows a stand-in before view until the worker loads the real one: the compare waits. */
  const beforeWaiting = $derived(frameMode && !app.frameBeforeReady);
  const palette = $derived.by(() => {
    void app.editVersion;
    if (!result) return [];
    if (!frameMode) return listPalette(app.session.composed().pixels);
    void app.anim.version;
    return app.anim.paletteColors();
  });
  const framePosition = $derived(app.anim.timeline.findIndex((frame) => frame.id === app.editingFrameId));
  const frameCount = $derived(app.anim.timeline.length);
  /** The preview background shows only through transparent tiles; without them the control is disabled. */
  const hasTransparency = $derived.by(() => {
    void app.editVersion;
    return result ? app.session.composed().pixels.includes(TRANSPARENT) : false;
  });
  /** The box that the export writes: the opaque tiles. The stage outlines it when it is smaller than the canvas. */
  const exportBox = $derived.by(() => {
    void app.editVersion;
    return result ? opaqueBox(app.session.composed()) : null;
  });
  const trimmed = $derived(!frameMode && exportBox !== null && result !== null && (exportBox.cols !== result.sprite.cols || exportBox.rows !== result.sprite.rows));
  const canUndo = $derived(app.history.canUndo);
  const canRedo = $derived(app.history.canRedo);
  const cursor = $derived(overSplit ? 'ew-resize' : app.tool === 'view' ? 'grab' : app.tool === 'picker' ? 'copy' : app.tool === 'remove' || app.tool === 'replace' ? PICKER_CURSOR : 'crosshair');

  function compareLabels(): CompareLabels {
    return { before: t('clean.before'), after: t('clean.after') };
  }

  /** A new result (new grid) builds a new scene with the entry sweep; a merge only rewrites the sprite layer. */
  $effect(() => {
    const current = result;
    void app.baseVersion;
    untrack(() => {
      if (!current) {
        scene = null;
        return;
      }
      const composed = app.session.composed();
      const sameSize = scene !== null && scene.contentW === composed.cols && scene.contentH === composed.rows;
      if (scene && frameMode && sameSize && sceneAligned !== current.aligned) {
        // Another frame of the animation: the view stays, with no entry sweep.
        sceneAligned = current.aligned;
        scene.setAligned(current.aligned);
        scene.setSprite(composed);
      } else if (!scene || sceneAligned !== current.aligned || !sameSize) {
        sceneAligned = current.aligned;
        const next = new CleanScene(composed, current.aligned, compareLabels(), true);
        next.background = app.previewBg;
        next.showGrid = app.showTileGrid;
        scene = next;
        splitPercent = 0;
        sfx.play('sweep');
      } else {
        scene.setSprite(composed);
      }
    });
  });

  /** The previous timeline entry, in a loop, as a tinted ghost over the frame. */
  $effect(() => {
    const on = onion && frameMode;
    const id = app.editingFrameId;
    const current = scene;
    void app.baseVersion;
    if (!current) return;
    untrack(() => {
      const list = app.anim.timeline;
      const at = list.findIndex((frame) => frame.id === id);
      const previous = on && at >= 0 && list.length > 1 ? list[(at - 1 + list.length) % list.length] : null;
      const sprite = previous ? app.anim.editedFrame(previous.id) : null;
      current.setGhost(sprite ? bakeSprite(sprite, { color: STAGE_COLORS.ghostPrevious, strength: TUNING.anim.ghostTint }) : null, TUNING.anim.ghostAlpha);
    });
  });

  function toggleOnion(): void {
    onion = !onion;
    sfx.play('tick');
  }

  $effect(() => {
    const bg = app.previewBg;
    const grid = app.showTileGrid;
    if (!scene) return;
    scene.background = bg;
    scene.showGrid = grid;
    stage?.invalidate();
  });

  $effect(() => {
    const box = trimmed ? exportBox : null;
    if (!scene) return;
    scene.exportBox = box;
    stage?.invalidate();
  });

  // The labels are drawn on the canvas: a language change sets them again and repaints.
  $effect(() => {
    const labels = compareLabels();
    if (!scene) return;
    scene.labels = labels;
    stage?.invalidate();
  });

  function tileOf(p: StagePointer): Tile | null {
    if (!scene) return null;
    const col = Math.floor(p.ix);
    const row = Math.floor(p.iy);
    return col >= 0 && row >= 0 && col < scene.contentW && row < scene.contentH ? { col, row } : null;
  }

  function hoverMark(): HoverMark {
    switch (app.tool) {
      case 'pencil':
      case 'bucket':
        return { kind: 'paint', color: app.ink };
      case 'eraser':
        return { kind: 'erase' };
      case 'picker':
      case 'replace':
        return { kind: 'pick' };
      case 'remove':
        return { kind: 'remove' };
      default:
        return null;
    }
  }

  function edited(): void {
    app.editVersion++;
    if (frameMode) app.noteFrameEdit();
  }

  /** One stamp of the brush at `tile`: the squares of the footprint that are new to the stroke and change color. */
  function stamp(tile: Tile): number {
    if (!stroke || !scene) return 0;
    const pixels = app.session.composed().pixels;
    const color = stroke.color;
    const changed = stampIndices(tile.col, tile.row, stroke.size, scene.contentW, scene.contentH, stroke.seen).filter((index) => pixels[index] !== color);
    if (changed.length === 0) return 0;
    for (const index of changed) stroke.indices.push(index);
    scene.writeColor(changed, color);
    if (stroke.erase) {
      scene.shatter(changed, pixels);
    } else {
      const box = brushBox(tile.col, tile.row, stroke.size, scene.contentW, scene.contentH);
      if (box) scene.pop({ col: box.col, row: box.row }, box.w, box.h);
    }
    return changed.length;
  }

  /** One sound per pointer step, for any brush size. */
  function strokeSound(changed: number): void {
    if (changed > 0 && stroke) sfx.play(stroke.erase ? 'erase' : 'paint');
  }

  /** The tool with a brush size, or null. */
  function brushTool(): BrushTool | null {
    return app.tool === 'pencil' || app.tool === 'eraser' ? app.tool : null;
  }

  /** The brush size of the active tool. */
  function brushSize(): number {
    const tool = brushTool();
    return tool ? app.brush[tool] : 1;
  }

  /** A new size of the active brush: the footprint shows at the pointer, or at the center of the view. */
  function changeBrush(size: number): void {
    const tool = brushTool();
    if (!tool || !scene) return;
    const before = app.brush[tool];
    const next = app.setBrush(tool, size);
    if (next === before) return;
    sfx.play('tick');
    const at = lastTile ?? scene.centerTile();
    if (lastTile) scene.setHover(lastTile, hoverMark(), next);
    if (at) scene.flashBrush(at, next);
  }

  function pickAt(tile: Tile | null): void {
    if (!tile || !scene) return;
    app.ink = app.session.composed().pixels[tile.row * scene.contentW + tile.col];
    sfx.play('tick');
  }

  function fillAt(tile: Tile): void {
    if (!scene) return;
    const composed = app.session.composed();
    const start = tile.row * composed.cols + tile.col;
    if (composed.pixels[start] === app.ink) {
      sfx.play('tick');
      return;
    }
    const region = floodRegion(composed, start);
    const changed = app.session.apply(region.indices, app.ink);
    if (changed.length === 0) return;
    app.pixelStep();
    scene.startWave(region.indices, region.distance, app.session.composed().pixels);
    scene.ripple(tile);
    sfx.play('fill');
    edited();
  }

  /** "Ver" drags the divider from its line and its knob; a drawing tool only from the knob, so the border stays paintable. */
  function splitHit(p: StagePointer): boolean {
    if (!scene || beforeWaiting) return false;
    return app.tool === 'view' ? scene.hitSplit(p.sx, p.sy) : scene.hitSplitKnob(p.sx, p.sy);
  }

  function onDown(p: StagePointer): boolean | 'pan' {
    if (!scene) return false;
    if (splitHit(p)) {
      draggingSplit = true;
      return true;
    }
    if (scene.sweeping) scene.setSplit(0);
    const tile = tileOf(p);
    lastTile = tile;
    switch (app.tool) {
      case 'view':
        return 'pan';
      case 'picker':
        pickAt(tile);
        if (tile && TUNING.clean.eyedropperReturnsToPencil) app.tool = 'pencil';
        return false;
      case 'bucket':
        if (tile) fillAt(tile);
        return false;
      case 'remove':
        if (tile) removeColorAt(tile);
        return false;
      case 'replace':
        if (tile) replaceColorAt(tile, p.shift);
        return false;
      case 'pencil':
      case 'eraser': {
        const erase = app.tool === 'eraser' || app.ink === TRANSPARENT;
        const start = { col: Math.floor(p.ix), row: Math.floor(p.iy) };
        stroke = { color: app.tool === 'eraser' ? TRANSPARENT : app.ink, erase, size: brushSize(), last: start, indices: [], seen: new Uint8Array(scene.contentW * scene.contentH) };
        // A large brush reaches the sprite from outside it: the footprint is clipped, not the pointer.
        strokeSound(stamp(start));
        return true;
      }
    }
  }

  function onMove(p: StagePointer): void {
    if (draggingSplit) {
      scene?.setSplitFromScreen(p.sx);
      splitPercent = Math.round((scene?.split ?? 0) * 100);
      return;
    }
    if (!stroke || !scene) return;
    const col = Math.floor(p.ix);
    const row = Math.floor(p.iy);
    if (col === stroke.last.col && row === stroke.last.row) return;
    // Every square of the line between two pointer events gets a stamp, so a fast drag leaves no hole.
    const line = lineTiles(stroke.last.col, stroke.last.row, col, row);
    let changed = 0;
    for (let i = 0; i < line.length; i += 2) changed += stamp({ col: line[i], row: line[i + 1] });
    strokeSound(changed);
    stroke.last = { col, row };
    lastTile = tileOf(p);
    scene.setHover(lastTile, hoverMark(), brushSize());
  }

  function onUp(): void {
    if (draggingSplit) {
      draggingSplit = false;
      return;
    }
    const finished = stroke;
    stroke = null;
    if (!finished || finished.indices.length === 0) return;
    if (app.session.apply(Int32Array.from(finished.indices), finished.color).length > 0) app.pixelStep();
    edited();
  }

  function onHover(p: StagePointer | null): void {
    if (!scene) return;
    overSplit = p !== null && splitHit(p);
    lastTile = p && !overSplit ? tileOf(p) : null;
    scene.setHover(lastTile, hoverMark(), brushSize());
    updateMask();
  }

  function selectTool(tool: Tool): void {
    if (app.tool === tool) return;
    app.tool = tool;
    track('tool_change', { detail: tool });
    sfx.play('tick');
    scene?.setHover(lastTile, hoverMark(), brushSize());
    updateMask();
  }

  function indexOf(tile: Tile): number {
    return tile.row * app.session.composed().cols + tile.col;
  }

  /** The tiles that a click of a list tool on the square under the pointer changes, over the sprite. */
  function updateMask(): void {
    if (!scene) return;
    const composed = app.session.composed();
    if (app.tool === 'replace') {
      pickInside = false;
      const color = lastTile ? app.listColorAt(indexOf(lastTile)) : null;
      const pending = lists.replaced.pending;
      const key = `replace|${color}|${tolerance}|${pending.map((entry) => entry.color).join(',')}|${app.editVersion}|${app.baseVersion}`;
      if (key === maskKey) return;
      maskKey = key;
      const hover = color !== null ? app.replaceTilesOf(color, tolerance) : new Int32Array(0);
      const held = app.pendingReplaceTiles();
      scene.setMask(hover.length > 0 || held.length > 0 ? bakeReplaceMask(composed.cols, composed.rows, held, hover) : null);
      return;
    }
    const found = app.tool === 'remove' && lastTile ? app.removalPickAt(indexOf(lastTile)) : null;
    const pick = found && found.action !== 'listed' ? found : null;
    pickInside = pick?.scope === 'all';
    const key = pick ? `remove|${pick.color}|${pick.scope}|${tolerance}|${app.editVersion}|${app.baseVersion}` : '';
    if (key === maskKey) return;
    maskKey = key;
    scene.setMask(pick ? bakePickMask(composed.cols, composed.rows, pick.cleared, pick.kept, pick.scope) : null);
  }

  // The mask follows the tolerance slider and the pending group while the pointer rests.
  $effect(() => {
    void tolerance;
    void lists.replaced.pending;
    untrack(updateMask);
  });

  function setTolerance(value: number, commit: boolean): void {
    if (app.tool === 'replace') lists.replaced.setTolerance(value, commit);
    else lists.removed.setTolerance(value, commit);
    updateMask();
  }

  /** A list changed: the image shows its new base (in the frame editor, the animation built its frames again). */
  function refreshFrame(): void {
    app.baseVersion++;
    app.editVersion++;
    maskKey = STALE_MASK;
    untrack(updateMask);
  }

  /** The juice of a list change: the tiles that went fall as shards, and a flash marks every changed tile and the kept ones. */
  function showListChange(before: Uint32Array, kept: ArrayLike<number> = []): void {
    if (!scene) return;
    const after = app.session.composed();
    const changed = changedTiles(before, after.pixels);
    scene.writeTiles(changed, after.pixels);
    const gone = changed.filter((index) => after.pixels[index] === TRANSPARENT);
    if (gone.length > 0) scene.shatter(gone, before);
    if (changed.length > 0 || kept.length > 0) scene.flashMask(bakePickFlash(after.cols, after.rows, changed, kept));
    maskKey = STALE_MASK;
  }

  /**
   * "Remove color": the clicked color goes where it joins the border, or everywhere from a spot that does not (see
   * removalAt). The color joins the list of the journey, so a set piece or a frame changes all the set or the animation.
   */
  function removeColorAt(tile: Tile): void {
    const pick = app.removalPickAt(indexOf(tile));
    if (!pick) {
      sfx.play('tick');
      return;
    }
    if (pick.action === 'listed') {
      app.toast(t('toast.colorAlreadyRemoved'), 'info');
      return;
    }
    const before = app.session.composed().pixels;
    const count = app.addRemovedColor(pick.color, pick.scope);
    if (count === 0) {
      app.toast(t('toast.colorNotInFrames'), 'info');
      return;
    }
    if (app.ink === pick.color && !composedHas(pick.color)) app.ink = TRANSPARENT;
    showListChange(before, pick.kept);
    sfx.play('erase');
    app.toast(removedToast(variant, count, pick.scope), 'success');
    updateMask();
  }

  /** The replacement picker: a click picks a source and opens the target chooser; Shift+click adds it to the group only. */
  function replaceColorAt(tile: Tile, group: boolean): void {
    const color = app.listColorAt(indexOf(tile));
    if (color === null) {
      sfx.play('tick');
      return;
    }
    if (group) lists.replaced.hold(color);
    else lists.replaced.pick(color);
    sfx.play('tick');
    maskKey = STALE_MASK;
    updateMask();
  }

  /** Adds replacement entries and shows them; `to` of TRANSPARENT erases. */
  function applyReplacement(entries: readonly ReplacedColor[]): void {
    if (entries.length === 0) return;
    const before = app.session.composed().pixels;
    const count = app.addReplacedColors(entries);
    if (count === 0) {
      app.toast(t('toast.colorNotReplaced'), 'info');
      return;
    }
    const from = new Set(entries.map((entry) => entry.from));
    if (from.has(app.listColorOf(app.ink)) && !composedHas(app.ink)) app.ink = entries[entries.length - 1].to;
    showListChange(before);
    sfx.play(entries[0].to === TRANSPARENT ? 'erase' : 'fill');
    app.toast(replacedToast(variant, count, entries.every((entry) => entry.to === TRANSPARENT)), 'success');
    updateMask();
  }

  /** The target chooser of the replacement picker: one entry per pending source. */
  function chooseTarget(to: number): void {
    const entries = lists.replaced.pendingEntries(to);
    lists.replaced.cancel();
    applyReplacement(entries);
  }

  /** One step back or forward on the history of the screen: a pixel step or a list step. */
  function replay(way: 'undo' | 'redo'): void {
    if (!scene) return;
    const before = app.session.composed().pixels;
    const done = app.replayClean(way);
    if (!done) return;
    sfx.play('undo');
    if (done.kind === 'pixels') {
      scene.writeTiles(done.changed, app.session.composed().pixels);
      edited();
      return;
    }
    if (done.kind !== 'lists') return;
    showListChange(before);
    app.toast(historyToast(done.action, way), 'info');
    updateMask();
  }

  function undo(): void {
    replay('undo');
  }

  function redo(): void {
    replay('redo');
  }

  function composedHas(color: number): boolean {
    return app.session.composed().pixels.includes(color);
  }

  /** Erases tiles, as one pixel step, with the falling-shards effect. Returns how many tiles changed. */
  function eraseTiles(indices: Int32Array): number {
    if (!scene) return 0;
    const before = app.session.composed().pixels;
    const changed = app.session.apply(indices, TRANSPARENT);
    if (changed.length === 0) return 0;
    app.pixelStep();
    const composed = app.session.composed();
    scene.writeTiles(changed, composed.pixels);
    scene.shatter(changed, before);
    sfx.play('erase');
    edited();
    return changed.length;
  }

  function removeBackground(): void {
    const indices = borderBackground(app.session.composed());
    if (indices.length === 0 || eraseTiles(indices) === 0) {
      app.toast(t('toast.noBackground'), 'info');
      return;
    }
    app.toast(t('toast.bgRemoved'), 'success');
  }

  /** "Erase this color": the color joins the removed colors of the journey everywhere, at tolerance 0. */
  function deleteColor(color: number): void {
    const before = app.session.composed().pixels;
    const count = app.addRemovedColor(app.listColorOf(color), 'all', 0);
    if (count === 0) {
      app.toast(t('toast.colorNotInFrames'), 'info');
      return;
    }
    if (app.ink === color && !composedHas(color)) app.ink = TRANSPARENT;
    showListChange(before);
    sfx.play('erase');
    app.toast(removedToast(variant, count, 'all'), 'success');
  }

  /** "Replace this color everywhere": one entry of the replacement map of the journey, at tolerance 0. */
  function swapColor(from: number, to: number): void {
    applyReplacement([{ from: app.listColorOf(from), to, tolerance: 0 }]);
  }

  function selectColor(color: number): void {
    app.ink = color;
    if (app.tool === 'view' || app.tool === 'picker' || (app.tool === 'eraser' && color !== TRANSPARENT)) app.tool = 'pencil';
    sfx.play('tick');
  }

  function onCompareInput(event: Event): void {
    splitPercent = Number((event.currentTarget as HTMLInputElement).value);
    scene?.setSplit(splitPercent / 100);
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (app.exportOpen || app.confirmRequest || app.aboutOpen) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      redo();
    } else if (mod && key === 's') {
      event.preventDefault();
      if (app.editingId === null && !frameMode) app.exportOpen = true;
    } else if (event.key === 'Escape') {
      if (!palettePanel?.cancelSwap() && lists.replaced.cancel()) {
        sfx.play('tick');
        maskKey = STALE_MASK;
        updateMask();
      }
    } else if (frameMode && !mod && !event.altKey && !isEditable(event.target) && (event.key === ',' || event.key === '.' || key === 'o')) {
      event.preventDefault();
      if (key === 'o') {
        if (!event.repeat) toggleOnion();
      } else {
        app.stepAnimFrame(event.key === ',' ? -1 : 1);
      }
    } else if (!mod && !event.altKey && !isEditable(event.target) && (event.key === '[' || event.key === ']')) {
      if (!brushTool()) return;
      event.preventDefault();
      changeBrush(brushSize() + (event.key === ']' ? 1 : -1));
    } else if (!mod && !event.altKey && !isEditable(event.target)) {
      const tool = TOOLS.find((entry) => entry.key.toLowerCase() === key);
      if (tool) {
        event.preventDefault();
        selectTool(tool.id);
      }
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<section class="clean-screen">
  <nav class="tool-rail" aria-label={t('clean.toolsLabel')}>
    {#each TOOLS as tool (tool.id)}
      <button
        type="button"
        class="tool"
        aria-pressed={app.tool === tool.id}
        aria-keyshortcuts={tool.key}
        title={tool.id === 'pencil' || tool.id === 'eraser' ? `${t(tool.label)} (${tool.key}) · ${t('brush.keys')}` : `${t(tool.label)} (${tool.key})`}
        onclick={() => selectTool(tool.id)}
      >
        <Icon name={tool.icon} size={22} />
        <span class="tool-label">{t(tool.label)}</span>
        <kbd class="keycap tool-key">{tool.key}</kbd>
        {#if (tool.id === 'pencil' || tool.id === 'eraser') && app.brush[tool.id] > 1}
          <span class="tool-size" title={t('brush.value', { size: app.brush[tool.id] })}>{app.brush[tool.id]}</span>
        {/if}
      </button>
    {/each}
    <p class="rail-hint">{t('clean.rightClickHint')}</p>
    <p class="rail-hint rail-keys">
      <span class="keycap-group" role="group" aria-label={t('brush.bracketKeys')}><kbd class="keycap">[</kbd><kbd class="keycap">]</kbd></span>
      <span>{t('brush.railHint')}</span>
    </p>
  </nav>

  <div class="clean-main">
    <div class="toolbar">
      <div class="toolbar-group">
        <button type="button" class="icon-btn" aria-label={t('clean.undo')} title="{t('clean.undo')} (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!canUndo} onclick={undo}>
          <Icon name="undo" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.redo')} title="{t('clean.redo')} (Ctrl+Y)" aria-keyshortcuts="Control+Y" disabled={!canRedo} onclick={redo}>
          <Icon name="redo" />
        </button>
      </div>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button type="button" class="icon-btn" aria-label={t('clean.zoomOut')} title={t('clean.zoomOut')} onclick={() => stage?.zoomBy(1 / TUNING.zoom.buttonStep)}>
          <Icon name="zoomOut" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.zoomIn')} title={t('clean.zoomIn')} onclick={() => stage?.zoomBy(TUNING.zoom.buttonStep)}>
          <Icon name="zoomIn" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.fit')} title={t('clean.fit')} onclick={() => stage?.fitView()}>
          <Icon name="fit" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.grid')} title={t('clean.grid')} aria-pressed={app.showTileGrid} onclick={() => (app.showTileGrid = !app.showTileGrid)}>
          <Icon name="grid" />
        </button>
        {#if frameMode}
          <button type="button" class="icon-btn" aria-label={t('animEdit.onion')} title="{t('animEdit.onionHint')} (O)" aria-keyshortcuts="O" aria-pressed={onion} disabled={frameCount < 2} onclick={toggleOnion}>
            <Icon name="onion" />
          </button>
        {/if}
      </div>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <div class="toolbar-group toolbar-brush">
        {#if app.tool === 'remove' || app.tool === 'replace'}
          <ToleranceSlider id="tool-tolerance" value={tolerance} compact hint={app.tool === 'replace' ? t('replaceColor.toleranceHint') : undefined} onchange={setTolerance} />
        {:else}
          <BrushSize tool={app.tool === 'pencil' || app.tool === 'eraser' ? app.tool : null} onsize={changeBrush} />
        {/if}
      </div>
      <div class="toolbar-group toolbar-end">
        <span class="toolbar-label" id="bg-label">{t('clean.background')}</span>
        <div class="segmented bg-choice" role="group" aria-labelledby="bg-label" aria-describedby={hasTransparency ? undefined : 'bg-hint'} title={hasTransparency ? undefined : t('clean.bgOpaque')}>
          {#each BACKGROUNDS as bg (bg.id)}
            <button type="button" aria-pressed={app.previewBg === bg.id} disabled={!hasTransparency} onclick={() => app.setPreviewBackground(bg.id)}>{t(bg.label)}</button>
          {/each}
        </div>
      </div>
    </div>

    <div class="clean-stage">
      {#if scene}
        <Stage
          bind:this={stage}
          {scene}
          label={t('clean.stageLabel')}
          {cursor}
          onprimarydown={onDown}
          onprimarymove={onMove}
          onprimaryup={onUp}
          onaltclick={(p) => pickAt(tileOf(p))}
          onhover={onHover}
        >
          <!-- Overlays, so the stage never moves when a status appears, changes or goes away. The tool status comes first. -->
          <div class="stage-pills">
            {#if app.tool === 'remove' && !frameMode}
              <p class="tool-pill" class:is-warn={pickInside} role="status">{pickInside ? t(variant === 'set' ? 'removeColor.setInsideHint' : 'removeColor.imageInsideHint') : t('removeColor.imageHint')}</p>
            {:else if app.tool === 'replace'}
              <p class="tool-pill" role="status">{t('replaceColor.pickingHint')}</p>
            {/if}
            {#if !hasTransparency}
              <p class="tool-pill" id="bg-hint">{t('clean.bgOpaque')}</p>
            {/if}
          </div>
          <label class="compare" class:is-waiting={beforeWaiting}>
            <span class="compare-end">{t('clean.before')}</span>
            <input id="compare-split" name="compare-split" class="compare-range" type="range" min="0" max="100" step="1" value={splitPercent} aria-label={t('clean.compare')} disabled={beforeWaiting} oninput={onCompareInput} />
            <span class="compare-end">{t('clean.after')}</span>
            {#if beforeWaiting}
              <span class="compare-wait" role="status">{t('animEdit.beforeLoading')}</span>
            {/if}
          </label>
        </Stage>
      {/if}
      <ProgressPill />
    </div>
  </div>

  <aside class="clean-panel">
    <PanelSplitter />
    <div class="clean-panel-scroll">
      <header class="clean-head">
        {#if app.editingId !== null && app.source}<p class="piece-tag" title={app.source.name}>{t('clean.piece', { name: app.source.name })}</p>{/if}
        {#if frameMode}
          <h1 class="clean-title">{t('animEdit.title', { n: framePosition + 1, m: frameCount })}</h1>
          <div class="frame-nav" role="group" aria-label={t('animEdit.navLabel')}>
            <button type="button" class="icon-btn" aria-label={t('animEdit.prev')} title="{t('animEdit.prev')} (,)" aria-keyshortcuts="," disabled={frameCount < 2} onclick={() => app.stepAnimFrame(-1)}>
              <Icon name="stepBack" size={18} />
            </button>
            <button type="button" class="icon-btn" aria-label={t('animEdit.next')} title="{t('animEdit.next')} (.)" aria-keyshortcuts="." disabled={frameCount < 2} onclick={() => app.stepAnimFrame(1)}>
              <Icon name="stepForward" size={18} />
            </button>
            <span class="keycap-group" aria-hidden="true"><kbd class="keycap">,</kbd><kbd class="keycap">.</kbd></span>
          </div>
        {:else}
          <h1 class="clean-title">{t('clean.title')}</h1>
        {/if}
        {#if result}<p class="hint">{t('clean.size', { cols: result.sprite.cols, rows: result.sprite.rows })} · {t('rule.pixel')}</p>{/if}
        {#if trimmed && exportBox}<p class="hint export-box-note"><span class="export-box-swatch" aria-hidden="true"></span>{t('clean.exportBox', { w: exportBox.cols, h: exportBox.rows })}</p>{/if}
      </header>

      <PalettePanel bind:this={palettePanel} colors={palette} ink={app.ink} onselect={selectColor} onswap={swapColor} ondelete={deleteColor} />

      <button type="button" class="btn btn-quiet remove-bg" onclick={removeBackground}>
        <Icon name="sparkle" size={18} />
        {t('clean.removeBg')}
      </button>

      <RemoveColors list={lists.removed} {variant} picking={app.tool === 'remove'} inside={pickInside} ontogglepick={() => selectTool(app.tool === 'remove' ? 'pencil' : 'remove')} onchange={refreshFrame} />

      <ReplaceColors
        list={lists.replaced}
        {variant}
        picking={app.tool === 'replace'}
        ontogglepick={() => selectTool(app.tool === 'replace' ? 'pencil' : 'replace')}
        colors={palette}
        onchoose={chooseTarget}
        onchange={refreshFrame}
      />

      {#if !frameMode}
        <CleanupPresets hint={t('cleanup.hint')} />
      {/if}

      {#if app.editingId === null && !frameMode}<ReferenceColors />{/if}
    </div>

    <div class="clean-actions" class:is-set={app.editingId !== null || frameMode}>
      {#if frameMode}
        <p class="hint set-note">{t('animEdit.note')}</p>
        <button type="button" class="btn btn-primary btn-big" title={t('animEdit.note')} onclick={() => app.leaveFrameEditor()}>
          <Icon name="check" size={20} />
          {t('animEdit.back')}
        </button>
      {:else if app.editingId !== null}
        <p class="hint set-note">{t('clean.setNote')}</p>
        <button type="button" class="btn btn-primary btn-big" title={t('clean.setNote')} onclick={() => app.returnToSet()} disabled={app.loading}>
          <Icon name="check" size={20} />
          {t('set.backToSet')}
        </button>
      {:else}
        <button type="button" class="btn btn-quiet" title={t('clean.backToGrid')} onclick={() => app.goTo('grid')}>
          <Icon name="back" size={18} />
          <span class="back-label">{t('clean.backToGrid')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-big" aria-keyshortcuts="Control+S" title="{t('clean.export')} (Ctrl+S)" onclick={() => (app.exportOpen = true)}>
          <Icon name="download" size={20} />
          {t('clean.export')}
        </button>
      {/if}
    </div>
  </aside>
</section>

<style>
  @layer components {
    .set-note {
      grid-column: 1 / -1;
      grid-row: 1;
    }

    .frame-nav {
      display: flex;
      align-items: center;
      gap: 2px;

      & .keycap-group {
        margin-left: var(--space-2);
      }
    }

    .export-box-note {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-variant-numeric: tabular-nums;
    }

    .export-box-swatch {
      flex: none;
      width: 14px;
      height: 10px;
      border: 1px dashed var(--teal);
    }

    .clean-screen {
      display: grid;
      grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--panel-size, var(--panel-w));
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .tool-rail {
      display: grid;
      align-content: start;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-2);
      background: var(--surface-1);
      border-right: 2px solid var(--line);
      overflow: hidden auto;
    }

    .tool {
      position: relative;
      min-width: 0;
      display: grid;
      justify-items: center;
      gap: 3px;
      padding: var(--space-2) 2px;
      color: var(--text-muted);
      border: 2px solid transparent;
      border-radius: var(--radius-m);
      transition:
        transform var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym),
        color var(--dur-hover) var(--ease-sym);

      &:hover {
        color: var(--text);
        background: var(--surface-2);
      }

      &:active {
        transform: translateY(2px);
        transition-duration: 60ms;
      }

      &[aria-pressed='true'] {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
        box-shadow: 0 3px 0 var(--primary-depth);
      }
    }

    .tool-label {
      max-width: 100%;
      font: 600 0.75rem/1.1 var(--font-display);
      overflow-wrap: anywhere;
    }

    .tool-key {
      position: absolute;
      top: 3px;
      right: 3px;
      min-width: 1.7em;
      height: 1.7em;
      padding: 0 0.25em;
      border-bottom-width: 2px;
      font-size: 0.625rem;
    }

    /* The brush size of the pencil or the eraser, when it is larger than 1. */
    .tool-size {
      position: absolute;
      top: 3px;
      left: 4px;
      min-width: 18px;
      padding: 1px 3px;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      font: 700 0.6875rem/1.2 var(--font-body);
      font-variant-numeric: tabular-nums;
      text-align: center;
    }

    .rail-hint {
      margin-top: var(--space-2);
      padding: 0 2px;
      color: var(--text-muted);
      font-size: 0.6875rem;
      line-height: 1.3;
      text-align: center;
    }

    /* The bracket keys on their own line, above what they do. */
    .rail-keys {
      display: grid;
      justify-items: center;
      gap: var(--space-1);

      & .keycap-group {
        font-size: 0.875rem;
      }
    }

    .clean-main {
      container-type: inline-size;
      display: grid;
      grid-template: auto minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--surface-1);
      border-bottom: 2px solid var(--line);
    }

    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .toolbar-end {
      gap: var(--space-2);
      margin-left: auto;
    }

    .toolbar-brush {
      flex: 0 1 260px;
      min-width: 0;
    }

    .stage-pills {
      position: absolute;
      top: var(--space-3);
      left: var(--space-3);
      right: var(--space-3);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
      pointer-events: none;

      &:not(:has(.tool-pill)) {
        display: none;
      }
    }

    .tool-pill {
      max-width: 100%;
      margin: 0;
      padding: var(--space-1) var(--space-3);
      color: var(--text-muted);
      font-size: 0.8125rem;
      line-height: 1.35;
      text-align: center;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      box-shadow: 0 4px 0 var(--depth);

      &.is-warn {
        color: var(--text);
        border-color: var(--yellow);
      }
    }

    .toolbar-sep {
      width: 2px;
      height: 24px;
      background: var(--line);
    }

    .toolbar-label {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    @container (width < 560px) {
      .toolbar-label {
        display: none;
      }
    }

    .bg-choice button {
      flex: none;
      padding: 0 var(--space-2);
    }

    .clean-stage {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .compare {
      position: absolute;
      left: 50%;
      bottom: var(--space-3);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: 999px;
      box-shadow: 0 4px 0 var(--depth);
      translate: -50% 0;
    }

    .compare-end {
      font: 600 0.8125rem/1 var(--font-display);
      color: var(--text-muted);
    }

    .compare-range {
      width: 140px;
      accent-color: var(--primary);
      cursor: pointer;

      &:disabled {
        cursor: progress;
        opacity: 0.45;
      }
    }

    .compare-wait {
      font: 600 0.75rem/1 var(--font-display);
      color: var(--text-muted);
      white-space: nowrap;
    }

    .clean-panel {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .clean-panel-scroll {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      overflow-x: hidden;
      align-content: start;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-5);
      overflow-y: auto;
    }

    .clean-head {
      display: grid;
      gap: var(--space-1);
    }

    .clean-title {
      font-size: 1.5rem;
      text-wrap: balance;
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

    .remove-bg {
      justify-self: stretch;
    }

    .clean-actions {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-5) var(--space-5);
      border-top: 2px solid var(--line);
    }

    @media (max-height: 760px) {
      .clean-panel-scroll {
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }

      .clean-title {
        font-size: 1.125rem;
      }

      .clean-actions {
        grid-template-columns: auto minmax(0, 1fr);
        padding: var(--space-3) var(--space-4) var(--space-4);
      }

      .clean-actions.is-set {
        grid-template-columns: minmax(0, 1fr);
      }

      .clean-actions :global(.btn-big) {
        min-height: 44px;
        padding: 0 var(--space-3);
        font-size: 1.0625rem;
      }

      .back-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }

      .tool {
        padding-block: 6px;
      }
    }
  }
</style>
