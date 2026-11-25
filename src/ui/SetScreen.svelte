<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { TRANSPARENT } from '../core/color.ts';
  import { combinedColors } from '../core/palette.ts';
  import type { Sprite } from '../core/types.ts';
  import { snapHeights } from '../app/image-set.svelte.ts';
  import { app } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import { clamp } from './camera.ts';
  import type { PreviewBackground } from './clean-scene.ts';
  import CleanupPresets from './CleanupPresets.svelte';
  import Icon from './Icon.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import SetPieceControls from './SetPieceControls.svelte';
  import SetPieceList from './SetPieceList.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import { SetScene, type SetLabels } from './set-scene.ts';
  import Stage from './Stage.svelte';
  import PanelSplitter from './PanelSplitter.svelte';
  import RemoveColors from './RemoveColors.svelte';
  import ReplaceColors from './ReplaceColors.svelte';
  import { changedTiles, historyToast, removedToast, replacedToast } from './list-feedback.ts';
  import { bakePickFlash, bakePickMask, bakeReplaceMask, PICKER_CURSOR, STALE_MASK, type StagePointer } from './stage-renderer.ts';

  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  interface Drag {
    id: number;
    startH: number;
    startW: number;
    startIx: number;
    startIy: number;
    snapped: number | null;
  }

  let stage: Stage | undefined = $state();
  /** "Ver original": while it is held, each piece shows its original image in place. */
  let original = $state(false);
  let cursor = $state('default');
  let zoom = $state(1);
  let drag: Drag | null = null;
  let lastVersion = '';
  /** The last press on an object, for the double click that opens the pixel editor. */
  let lastPress: { id: number | null; at: number } = { id: null, at: 0 };
  /** A press on the body of an object: a move along the ground line once the pointer passes the threshold. */
  let move: { id: number; startSx: number; startIx: number; startX: number; moving: boolean } | null = null;
  /** The list picker of the board: a press picks the color under the pointer, and pieces neither select nor move. */
  let picker = $state<'remove' | 'replace' | null>(null);
  /** The last pointer over the board while a picker is on, and what the masks were made from. */
  let pickPointer: StagePointer | null = null;
  let maskKey = STALE_MASK;
  /** The pointer is on a spot that does not reach the border: a click there erases the color inside the drawing too. */
  let pickInside = $state(false);

  function sceneLabels(): SetLabels {
    return { height: (h) => t('set.pieceHeight', { h }), empty: t('set.pieceEmpty'), reference: t('set.reference') };
  }

  const scene = new SetScene(app.set, sceneLabels());

  const allHidden = $derived.by(() => {
    void app.set.placeVersion;
    void app.set.version;
    return app.set.allHidden;
  });
  const moved = $derived.by(() => {
    void app.set.placeVersion;
    void app.set.version;
    return app.set.moved;
  });
  const hasReferences = $derived.by(() => {
    void app.set.version;
    return app.set.hasReferences;
  });
  const palette = $derived.by(() => {
    void app.set.version;
    return app.set.palette();
  });
  /** The top hint while a picker is on: the same text as the picker hint of its panel. */
  const pickerHint = $derived.by(() => {
    if (picker === 'remove') return pickInside ? t('removeColor.setInsideHint') : t('removeColor.pickingHint');
    if (picker === 'replace') return app.set.replaced.pending.length > 0 && !app.set.replaced.choosing ? t('replaceColor.groupHint') : t('replaceColor.pickingHint');
    return null;
  });
  /** The swatches of the target chooser: the colors of every piece on the board. */
  const boardColors = $derived.by(() => {
    void app.set.version;
    return combinedColors(app.set.pieces.map((object) => object.cleared).filter((sprite): sprite is Sprite => sprite !== null));
  });

  /** A committed change of the set lays the scene out again; new objects frame the view again. */
  $effect(() => {
    const version = `${app.set.version}:${app.set.placeVersion}`;
    untrack(() => {
      if (version === lastVersion) return;
      lastVersion = version;
      const { added, anchor } = scene.refresh(drag?.id ?? app.set.selectedId);
      maskKey = STALE_MASK;
      updateMasks();
      if (!stage) return;
      stage.syncContent(anchor ?? undefined);
      if (added.length > 0) stage.fitView();
    });
  });

  onDestroy(() => scene.dispose());

  $effect(() => {
    scene.setOriginal(original);
  });

  $effect(() => {
    scene.background = app.previewBg;
    scene.selectedId = app.set.selectedId;
    stage?.invalidate();
  });

  // The labels are drawn on the canvas: a language change sets them again and repaints.
  $effect(() => {
    scene.labels = sceneLabels();
    stage?.invalidate();
  });

  function updateZoom(): void {
    zoom = scene.zoom;
  }

  /** The piece under a screen point and the tile of its full grid there, for a picker. */
  function pieceUnder(p: StagePointer | null): { id: number; tile: number } | null {
    if (!p) return null;
    const id = scene.hitObject(p.sx, p.sy);
    const object = id === null ? null : app.set.find(id);
    if (!object || object.reference || id === null) return null;
    const at = scene.pointIn(id, p.sx, p.sy);
    const tile = at ? app.set.tileAt(id, at.fx, at.fy) : -1;
    return tile >= 0 ? { id, tile } : null;
  }

  /** The hover previews of the picker: what a press erases or recolors, and the pending group of the replacement map. */
  function updateMasks(): void {
    const under = picker ? pieceUnder(pickPointer) : null;
    const list = app.set.replaced;
    const pending = list.pending.map((entry) => entry.color).join(',');
    const key = picker ? `${picker}|${under?.id}|${under?.tile}|${app.set.removed.tolerance}|${list.tolerance}|${pending}|${app.set.version}` : '';
    if (key === maskKey) return;
    maskKey = key;
    const masks = new Map<number, HTMLCanvasElement>();
    pickInside = false;
    if (picker === 'remove' && under) {
      const pick = app.set.pickAt(under.id, under.tile);
      const prepared = app.set.find(under.id)?.prepared;
      if (pick && pick.action !== 'listed' && prepared) {
        pickInside = pick.scope === 'all';
        masks.set(under.id, bakePickMask(prepared.cols, prepared.rows, app.set.toPrepared(under.id, pick.cleared), app.set.toPrepared(under.id, pick.kept), pick.scope));
      }
    } else if (picker === 'replace') {
      const color = under ? app.set.colorAt(under.id, under.tile) : null;
      for (const object of app.set.pieces) {
        if (!object.prepared || object.hidden) continue;
        const held = list.pending.length > 0 ? app.set.toPrepared(object.id, app.set.pendingTiles(object.id)) : new Int32Array(0);
        const hover = color !== null ? app.set.toPrepared(object.id, app.set.replaceTiles(object.id, color, list.tolerance)) : new Int32Array(0);
        if (held.length > 0 || hover.length > 0) masks.set(object.id, bakeReplaceMask(object.prepared.cols, object.prepared.rows, held, hover));
      }
    }
    scene.setMasks(masks);
  }

  // The masks follow the tolerance sliders and the pending group while the pointer rests.
  $effect(() => {
    void app.set.removed.tolerance;
    void app.set.replaced.tolerance;
    void app.set.replaced.pending;
    untrack(updateMasks);
  });

  function setPicker(next: 'remove' | 'replace' | null): void {
    if (next === picker) return;
    picker = next;
    sfx.play('tick');
    if (!next) pickPointer = null;
    cursor = next ? PICKER_CURSOR : 'default';
    updateMasks();
  }

  function togglePicker(kind: 'remove' | 'replace'): void {
    setPicker(picker === kind ? null : kind);
  }

  /** The full-grid sprites of the pieces now, to flash what a list change touches. */
  function boardNow(): Map<number, Uint32Array> {
    return new Map(app.set.pieces.flatMap((object) => (object.cleared ? [[object.id, object.cleared.pixels] as const] : [])));
  }

  /** A flash on every piece tile that changed since `before`, and shards where tiles went. */
  function flashChange(before: Map<number, Uint32Array>, kept?: { id: number; tiles: ArrayLike<number> }): void {
    const flashes = new Map<number, HTMLCanvasElement>();
    for (const object of app.set.pieces) {
      const old = before.get(object.id);
      if (!old || !object.cleared || !object.prepared) continue;
      const changed = app.set.toPrepared(object.id, changedTiles(old, object.cleared.pixels));
      const keep = kept?.id === object.id ? app.set.toPrepared(object.id, kept.tiles) : [];
      if (changed.length > 0 || keep.length > 0) flashes.set(object.id, bakePickFlash(object.prepared.cols, object.prepared.rows, changed, keep));
    }
    scene.flash(flashes);
  }

  function removePick(p: StagePointer): void {
    const under = pieceUnder(p);
    const pick = under ? app.set.pickAt(under.id, under.tile) : null;
    if (!under || !pick) {
      sfx.play('tick');
      return;
    }
    if (pick.action === 'listed') {
      app.toast(t('toast.colorAlreadyRemoved'), 'info');
      return;
    }
    const before = boardNow();
    const pieces = app.set.addRemovedColor(pick.color, pick.scope);
    if (pieces === 0) {
      app.toast(t('toast.colorNotInFrames'), 'info');
      return;
    }
    flashChange(before, { id: under.id, tiles: pick.kept });
    sfx.play('erase');
    app.toast(removedToast('set', pieces, pick.scope), 'success');
  }

  function replacePick(p: StagePointer): void {
    const under = pieceUnder(p);
    const color = under ? app.set.colorAt(under.id, under.tile) : null;
    if (color === null) {
      sfx.play('tick');
      return;
    }
    if (p.shift) app.set.replaced.hold(color);
    else app.set.replaced.pick(color);
    sfx.play('tick');
    maskKey = STALE_MASK;
    updateMasks();
  }

  /** The target chooser: one entry per pending source, in every piece. */
  function chooseTarget(to: number): void {
    const list = app.set.replaced;
    const entries = list.pendingEntries(to);
    list.cancel();
    if (entries.length === 0) return;
    const before = boardNow();
    const pieces = app.set.addReplacedColors(entries);
    if (pieces === 0) {
      app.toast(t('toast.colorNotReplaced'), 'info');
      return;
    }
    flashChange(before);
    sfx.play(to === TRANSPARENT ? 'erase' : 'fill');
    app.toast(replacedToast('set', pieces, to === TRANSPARENT), 'success');
  }

  /** One step of the history of the board: a list step. */
  function replay(way: 'undo' | 'redo'): void {
    const before = boardNow();
    const done = way === 'undo' ? app.set.history.undo() : app.set.history.redo();
    if (!done) return;
    sfx.play('undo');
    flashChange(before);
    if (done.kind === 'lists') app.toast(historyToast(done.action, way), 'info');
  }

  function onDown(p: StagePointer): boolean | 'pan' {
    if (picker) {
      // A picker never selects, moves or resizes a piece; the empty board still pans.
      if (scene.hitObject(p.sx, p.sy) === null) return 'pan';
      pickPointer = p;
      if (picker === 'remove') removePick(p);
      else replacePick(p);
      return false;
    }
    const warn = scene.hitWarning(p.sx, p.sy);
    if (warn !== null) {
      void app.openSetGrid(warn);
      return false;
    }
    const kept = scene.hitBackground(p.sx, p.sy);
    if (kept !== null) {
      app.set.select(kept);
      sfx.play('tick');
      return false;
    }
    const handle = scene.hitHandle(p.sx, p.sy);
    if (handle !== null) {
      const box = scene.boxOf(handle);
      if (!box) return false;
      app.set.select(handle);
      drag = { id: handle, startH: box.h, startW: box.w, startIx: p.ix, startIy: p.iy, snapped: null };
      scene.beginDrag(handle);
      sfx.play('tick');
      return true;
    }
    const hit = scene.hitObject(p.sx, p.sy);
    if (hit === null) return 'pan';
    // A double click on a piece opens its pixel editor; a reference is locked and does nothing.
    const now = performance.now();
    const twice = lastPress.id === hit && now - lastPress.at < TUNING.grid.doubleClickMs;
    lastPress = { id: twice ? null : hit, at: now };
    if (twice) {
      if (!app.set.find(hit)?.reference) void app.editObject(hit);
      return false;
    }
    if (hit !== app.set.selectedId) {
      app.set.select(hit);
      sfx.play('tick');
    }
    const box = scene.boxOf(hit);
    if (!box) return false;
    move = { id: hit, startSx: p.sx, startIx: p.ix, startX: box.x, moving: false };
    return true;
  }

  /** The object follows the pointer horizontally and stays on the ground line; its size never changes. */
  function onMoveObject(p: StagePointer): void {
    if (!move) return;
    if (!move.moving) {
      if (Math.abs(p.sx - move.startSx) < TUNING.set.moveThresholdPx) return;
      move.moving = true;
      scene.beginMove(move.id);
      cursor = 'grabbing';
    }
    app.set.placeLive(move.id, move.startX + (p.ix - move.startIx));
    scene.updateLive();
  }

  function endMoveObject(): void {
    const done = move;
    move = null;
    if (!done?.moving) return;
    scene.endMove();
    const object = app.set.find(done.id);
    if (object?.place !== null && object?.place !== undefined) app.set.moveTo(done.id, object.place);
    cursor = 'grab';
  }

  /** "Arrumar": every object back to its automatic place. */
  function tidy(): void {
    if (!app.set.moved) return;
    app.set.tidy();
    sfx.play('tick');
  }

  /** The handle follows the axis that moved more, so a drag to the right also grows the object. */
  function onMove(p: StagePointer): void {
    if (move) {
      onMoveObject(p);
      return;
    }
    if (!drag) return;
    const object = app.set.find(drag.id);
    const prepared = object?.prepared;
    if (!object || !prepared) return;
    const byY = (drag.startH + drag.startIy - p.iy) / drag.startH;
    const byX = (drag.startW + p.ix - drag.startIx) / drag.startW;
    const scale = Math.abs(byX - 1) > Math.abs(byY - 1) ? byX : byY;
    const limit = app.set.limitOf(object);
    const raw = clamp(drag.startH * scale, 1, limit);
    let height = Math.round(raw);
    let snapped: number | null = null;
    if (!p.shift) {
      const tolerance = Math.max(0.5, TUNING.set.snapPx / Math.max(scene.zoom, 1e-6));
      let best = Infinity;
      for (const candidate of snapHeights(prepared.rows, limit)) {
        const distance = Math.abs(candidate - raw);
        if (distance <= tolerance && distance < best) {
          best = distance;
          snapped = candidate;
        }
      }
      if (snapped !== null) height = snapped;
    }
    if (app.set.resizeLive(drag.id, height)) scene.updateLive();
    if (snapped !== null && snapped !== drag.snapped) {
      scene.flashHandle(drag.id);
      sfx.play('tick');
    }
    drag.snapped = snapped;
  }

  function onUp(): void {
    if (move) {
      endMoveObject();
      return;
    }
    if (!drag) return;
    scene.endDrag();
    app.set.commit();
    drag = null;
  }

  function onHover(p: StagePointer | null): void {
    if (picker) {
      pickPointer = p;
      scene.setHover(p ? scene.hitObject(p.sx, p.sy) : null, false);
      cursor = PICKER_CURSOR;
      updateMasks();
      return;
    }
    if (!p) {
      scene.setHover(null, false);
      cursor = 'default';
      return;
    }
    const handle = scene.hitHandle(p.sx, p.sy);
    const warn = handle === null ? (scene.hitWarning(p.sx, p.sy) ?? scene.hitBackground(p.sx, p.sy)) : null;
    const object = handle ?? warn ?? scene.hitObject(p.sx, p.sy);
    scene.setHover(object, handle !== null);
    // A badge is a button; the body of an object moves it; the empty scene pans the view.
    cursor = handle !== null ? 'nesw-resize' : warn !== null ? 'pointer' : object !== null ? 'grab' : 'default';
  }

  /** One pixel up or down, or the next whole size with Shift. */
  function stepHeight(direction: 1 | -1, whole: boolean): void {
    const object = app.set.selected;
    const prepared = object?.prepared;
    if (!object || !prepared) return;
    const limit = app.set.limitOf(object);
    let next = clamp(object.height + direction, 1, limit);
    if (whole) {
      const sizes = snapHeights(prepared.rows, limit);
      const found = direction > 0 ? sizes.filter((h) => h > object.height).sort((a, b) => a - b)[0] : sizes.filter((h) => h < object.height).sort((a, b) => b - a)[0];
      if (found === undefined) return;
      next = found;
    }
    if (next === object.height) return;
    app.set.setHeight(object.id, next);
    sfx.play('tick');
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function openExport(): void {
    if (app.set.exportFiles().length === 0) {
      sfx.play('error');
      app.toast(app.set.pieces.length === 0 ? t('setExport.onlyRefs') : t('setExport.none'), 'error');
      return;
    }
    app.setExportOpen = true;
  }

  /** Capture phase: the arrow keys change the selected object before the stage pans with them. */
  function onKeyDown(event: KeyboardEvent): void {
    if (app.setExportOpen || app.confirmRequest || app.aboutOpen || drag) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key.toLowerCase() === 'o' && !mod && !event.altKey && !isEditable(event.target)) {
      event.preventDefault();
      if (!event.repeat) original = true;
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      openExport();
      return;
    }
    if (mod && !event.altKey && !isEditable(event.target) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault();
      replay(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (mod || event.altKey || isEditable(event.target)) return;
    if (event.key.toLowerCase() === 'r' || event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (!event.repeat) togglePicker(event.key.toLowerCase() === 'r' ? 'remove' : 'replace');
      return;
    }
    if (event.key === 'Escape' && (picker || app.set.replaced.pending.length > 0)) {
      event.preventDefault();
      // Esc first drops the pending group of the replacement picker, then leaves the picker.
      if (app.set.replaced.cancel()) {
        sfx.play('tick');
        maskKey = STALE_MASK;
        updateMasks();
      } else setPicker(null);
      return;
    }
    const object = app.set.selected;
    if (!object) return;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !object.reference) {
      event.preventDefault();
      event.stopPropagation();
      stepHeight(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // Left and right move the selected object along the ground line: 1 scene pixel, 8 with Shift.
      event.preventDefault();
      event.stopPropagation();
      const box = scene.boxOf(object.id);
      if (!box) return;
      app.set.moveTo(object.id, box.x + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 8 : 1));
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void app.removeObject(object.id);
    } else if (event.key.toLowerCase() === 'h' && !event.shiftKey) {
      // Hide is for the view only.
      event.preventDefault();
      app.set.setHidden(object.id, !object.hidden);
      sfx.play('tick');
    } else if (event.key === 'Enter' && !object.reference && !(event.target instanceof HTMLButtonElement)) {
      // Enter opens the pixel editor of the selected piece; a focused button keeps its own Enter.
      event.preventDefault();
      void app.editObject(object.id);
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === 'o') original = false;
  }

  /** Space and Enter hold the "Ver original" button like a pointer press. */
  function onOriginalKey(event: KeyboardEvent, down: boolean): void {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    original = down;
  }

  function zoomToGrid(): void {
    stage?.zoomBy(TUNING.zoom.gridFirstCellPx / Math.max(scene.zoom, 1e-6));
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} onkeyup={onKeyUp} onblur={() => (original = false)} />

<section class="set-screen">
  <div class="set-stage">
    <Stage
      bind:this={stage}
      {scene}
      label={t('set.stageLabel')}
      {cursor}
      onprimarydown={onDown}
      onprimarymove={onMove}
      onprimaryup={onUp}
      onhover={onHover}
      onviewchange={updateZoom}
    >
      <div class="stage-top">
      <div class="stage-tip" class:is-add={app.set.objects.length < 2 && !pickerHint} role={pickerHint ? 'status' : undefined}>
        <Icon name={original ? 'compare' : pickerHint ? (picker === 'remove' ? 'colorErase' : 'swap') : app.set.objects.length < 2 ? 'plus' : 'arrows'} size={16} />
        <p class="stage-tip-text">
          {#if original}
            <span class="stage-tip-main">{t('set.originalShown')}</span>
          {:else if pickerHint}
            <span class="stage-tip-main">{pickerHint}</span>
          {:else if app.set.objects.length < 2}
            {t('set.addMoreTip')}
          {:else}
            <span class="stage-tip-main">{t('set.help')}</span>
          {/if}
        </p>
      </div>
      {#if allHidden}
        <p class="all-hidden" role="status">
          <Icon name="eyeOff" size={16} />
          <span>{t('set.allHidden')}</span>
          <button type="button" class="mini-show" onclick={() => app.set.showAll()}>{t('set.showAll')}</button>
        </p>
      {:else if zoom < TUNING.set.gridMinCellPx}
        <button type="button" class="zoom-hint" onclick={zoomToGrid}>
          <Icon name="zoomIn" size={18} />
          {t('grid.zoomHint')}
        </button>
      {/if}
      </div>
      <div class="stage-tools">
        <div class="stage-zoom">
        <button type="button" class="icon-btn" aria-label={t('clean.undo')} title="{t('clean.undo')} (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!app.set.history.canUndo} onclick={() => replay('undo')}>
          <Icon name="undo" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.redo')} title="{t('clean.redo')} (Ctrl+Y)" aria-keyshortcuts="Control+Y Control+Shift+Z" disabled={!app.set.history.canRedo} onclick={() => replay('redo')}>
          <Icon name="redo" />
        </button>
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
        <button type="button" class="original-btn" title={t('set.tidyHint')} disabled={!moved} onclick={tidy}>
          <Icon name="pieces" size={18} />
          {t('set.tidy')}
        </button>
        <button
          type="button"
          class="original-btn"
          aria-pressed={original}
          aria-keyshortcuts="O"
          title={t('set.originalHint')}
          onpointerdown={(event) => {
            if (event.button === 0) original = true;
          }}
          onpointerup={() => (original = false)}
          onpointerleave={() => (original = false)}
          onpointercancel={() => (original = false)}
          onkeydown={(event) => onOriginalKey(event, true)}
          onkeyup={(event) => onOriginalKey(event, false)}
          onblur={() => (original = false)}
        >
          <Icon name="compare" size={18} />
          {t('set.original')}
        </button>
        <div class="stage-bg" role="group" aria-labelledby="set-bg-label">
          <span class="bg-label" id="set-bg-label">{t('clean.background')}</span>
          <div class="segmented bg-choice">
            {#each BACKGROUNDS as bg (bg.id)}
              <button type="button" aria-pressed={app.previewBg === bg.id} onclick={() => app.setPreviewBackground(bg.id)}>{t(bg.label)}</button>
            {/each}
          </div>
        </div>
      </div>
    </Stage>
    <ProgressPill />
  </div>

  <aside class="set-panel">
    <PanelSplitter />
    <div class="set-panel-scroll">
      <header class="set-head">
        <h1 class="set-title">{t('set.title')}</h1>
      </header>

      <div class="set-list">
        <SetPieceList view="result" />
      </div>

      <div class="set-piece">
        <SetPieceControls onstep={stepHeight} />
      </div>

      <div class="set-lists">
        <RemoveColors list={app.set.removed} variant="set" picking={picker === 'remove'} inside={pickInside} ontogglepick={() => togglePicker('remove')} />
        <ReplaceColors list={app.set.replaced} variant="set" picking={picker === 'replace'} ontogglepick={() => togglePicker('replace')} colors={boardColors} onchoose={chooseTarget} />
      </div>
    </div>

    <div class="set-footer">
      <CleanupPresets hint={t('set.cleanupHint')} aside={palette.length === 1 ? t('set.colorCountOne') : t('set.colorCount', { count: palette.length })} />

      <ToggleSwitch id="set-erase-bg" label={t('set.eraseBg')} hint={t('set.eraseBgHint')} checked={app.set.eraseBackground} onchange={(on) => app.setEraseBackground(on)} />
      {#if hasReferences}
        <ToggleSwitch id="set-ref-colors" label={t('set.refColors')} hint={t('set.refColorsHint')} checked={app.set.referenceColors} onchange={(on) => app.setReferenceColors(on)} />
      {/if}

      <div class="set-actions">
        <button type="button" class="btn btn-quiet" title={t('set.backToGrid')} onclick={() => app.goTo('set-grid')} disabled={app.loading}>
          <Icon name="back" size={18} />
          <span class="visually-hidden">{t('set.backToGrid')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-big export-btn" aria-keyshortcuts="Control+S" title="{t('set.export')} (Ctrl+S)" onclick={openExport} disabled={app.loading}>
          <Icon name="download" size={20} />
          {t('set.export')}
        </button>
      </div>
    </div>
  </aside>
</section>

<style>
  @layer components {
    .set-screen {
      /* A bit wider than the other panels: the set panel holds the grid, the pieces and the set controls. */
      --set-panel-w: clamp(336px, 25vw, 400px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--panel-size, var(--set-panel-w));
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .set-stage {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    /* The tip and the zoom hint in one column, so a tip of two or three lines never covers the hint. */
    .stage-top {
      position: absolute;
      top: var(--space-3);
      left: var(--space-3);
      right: var(--space-3);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
      pointer-events: none;

      & > :global(*) {
        pointer-events: auto;
      }
    }

    .stage-tip {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      max-width: 100%;
      padding: var(--space-1) var(--space-3);
      color: var(--text-muted);
      font-size: 0.8125rem;
      line-height: 1.35;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      pointer-events: none;
      animation: tip-in var(--dur-pop) var(--ease-out);

      & :global(.icon) {
        color: var(--teal);
      }

      &.is-add {
        color: var(--text);
        border-color: var(--teal);
      }
    }

    .all-hidden {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      max-width: 100%;
      padding: var(--space-1) var(--space-3);
      color: var(--text);
      font-size: 0.875rem;
      background: var(--surface-1);
      border: 2px solid var(--yellow);
      border-radius: var(--radius-m);
    }

    .mini-show {
      min-height: 28px;
      padding: 0 var(--space-2);
      color: var(--on-primary);
      background: var(--primary);
      border-radius: var(--radius-s);
      font: 600 0.8125rem/1 var(--font-display);
    }

    .stage-tip-text {
      display: grid;
    }

    .stage-tip-main {
      color: var(--text);
    }

    .zoom-hint {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      font: 600 0.9375rem/1 var(--font-display);
      color: var(--on-primary);
      background: var(--primary);
      border-radius: 999px;
      box-shadow: 0 4px 0 var(--primary-depth);
      white-space: nowrap;
      transition: transform var(--dur-hover) var(--ease-sym);

      &:active {
        transform: translateY(2px);
      }
    }

    .stage-tools {
      position: absolute;
      left: var(--space-3);
      right: var(--space-3);
      bottom: var(--space-3);
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: var(--space-2);
      pointer-events: none;

      & > * {
        pointer-events: auto;
      }
    }

    .stage-bg {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 3px 3px 3px var(--space-2);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .stage-zoom {
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .set-panel {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    /* A short window: the list keeps two rows, and this part scrolls; the footer with the export stays in view. */
    .set-panel-scroll {
      display: grid;
      grid-template: auto minmax(min-content, 1fr) auto / minmax(0, 1fr);
      min-height: 0;
      overflow: hidden auto;
    }

    .set-head {
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3) var(--space-5) var(--space-2);
    }

    .set-title {
      font-size: 0.9375rem;
    }

    .set-list {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      padding: 0 var(--space-5) var(--space-3);
    }

    .set-piece {
      padding: 0 var(--space-5) var(--space-3);
    }

    .set-lists {
      display: grid;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-5);
      border-top: 2px solid var(--line);
    }

    .set-footer {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
      padding: var(--space-3) var(--space-5) var(--space-4);
      background: var(--surface-sunken);
      border-top: 2px solid var(--line);
    }

    .bg-label {
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .bg-choice button {
      flex: 1 1 auto;
      min-height: 28px;
      padding: 0 4px;
      font-size: 0.8125rem;
    }

    .set-actions {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
    }

    .export-btn {
      width: 100%;
      min-width: 0;
      padding-inline: var(--space-3);
      font-size: 1.125rem;
    }

    .original-btn {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 40px;
      padding: 0 var(--space-3);
      color: var(--text);
      font: 600 0.9375rem/1 var(--font-display);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      touch-action: none;
      user-select: none;
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        background: var(--surface-2);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }

      &[aria-pressed='true'] {
        color: var(--on-primary);
        background: var(--teal);
        border-color: var(--teal);
        transform: translateY(1px);
        transition-duration: 60ms;
      }
    }

    /* The panel shows every control without a scroll: below this height the helper lines stay for screen readers only. */
    @media (max-height: 860px) {
      .set-footer :global(.cleanup-hint) {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    }

    @media (max-height: 760px) {
      .set-head {
        padding: var(--space-3) var(--space-4) var(--space-2);
      }

      .set-title {
        font-size: 0.9375rem;
        text-wrap: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .set-list,
      .set-piece {
        padding-inline: var(--space-4);
        padding-bottom: var(--space-2);
      }

      .set-lists {
        padding-inline: var(--space-4);
      }

      .set-footer {
        gap: var(--space-2);
        padding: var(--space-2) var(--space-4) var(--space-3);
      }

      .set-footer :global(.btn-big) {
        min-height: 44px;
        font-size: 1.0625rem;
      }
    }

    @keyframes tip-in {
      from {
        opacity: 0;
        transform: translateY(-6px);
      }
    }
  }
</style>
