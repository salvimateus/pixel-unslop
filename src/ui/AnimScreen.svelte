<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { CELL_MODES, type AnimFrame } from '../app/animation.svelte.ts';
  import type { RemovalPick } from '../app/color-list.svelte.ts';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { CellMode } from '../core/frames.ts';
  import { TRANSPARENT } from '../core/color.ts';
  import { AnimScene, type AnimSource } from './anim-scene.ts';
  import AnimTimeline from './AnimTimeline.svelte';
  import type { PreviewBackground } from './clean-scene.ts';
  import CleanupPresets from './CleanupPresets.svelte';
  import FpsControl from './FpsControl.svelte';
  import Icon from './Icon.svelte';
  import KeyText from './KeyText.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import RemoveColors from './RemoveColors.svelte';
  import ReplaceColors from './ReplaceColors.svelte';
  import { changedTiles, historyToast, removedToast, replacedToast } from './list-feedback.ts';
  import { spriteThumb } from './sprite-thumb.ts';
  import Stage from './Stage.svelte';
  import { bakePickFlash, bakePickMask, bakeReplaceMask, PICKER_CURSOR, STALE_MASK, type StagePointer } from './stage-renderer.ts';
  import PanelSplitter from './PanelSplitter.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';

  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  const CELL_LABELS: Record<CellMode, { label: TextKey; hint: TextKey }> = {
    box: { label: 'animPlay.cellBox', hint: 'animPlay.cellBoxHint' },
    full: { label: 'animPlay.cellFull', hint: 'animPlay.cellFullHint' },
    crop: { label: 'animPlay.cellCrop', hint: 'animPlay.cellCropHint' },
    feet: { label: 'animPlay.cellFeet', hint: 'animPlay.cellFeetHint' },
  };

  type LegendKeys = 'space' | 'arrows' | 'brackets' | 'o' | 'delete' | 'altArrows' | 'd' | 'e' | 'r' | 'c' | 'ctrlZ' | 'ctrlS';

  const LEGEND: ReadonlyArray<{ keys: LegendKeys; text: TextKey }> = [
    { keys: 'space', text: 'animPlay.keyPlay' },
    { keys: 'arrows', text: 'animPlay.keyStep' },
    { keys: 'brackets', text: 'animPlay.keyFps' },
    { keys: 'o', text: 'animPlay.keyOnion' },
    { keys: 'delete', text: 'animPlay.keyRemove' },
    { keys: 'altArrows', text: 'animPlay.keyMove' },
    { keys: 'd', text: 'animPlay.keyDuplicate' },
    { keys: 'e', text: 'animEdit.open' },
    { keys: 'r', text: 'animPlay.keyRemoveColor' },
    { keys: 'c', text: 'animPlay.keyReplaceColor' },
    { keys: 'ctrlZ', text: 'animPlay.keyUndo' },
    { keys: 'ctrlS', text: 'animPlay.keyExport' },
  ];

  function source(): AnimSource {
    const built = app.anim.built;
    return { count: built.frames.length, cols: built.cell.cols, rows: built.cell.rows, frameOf: (i) => app.anim.built.frames[i] ?? null };
  }

  const scene = untrack(() => new AnimScene(source(), app.anim.fps));
  let stage: Stage | undefined = $state();
  /** The overlay bands of the stage, measured, so the fit keeps the frame clear of them (12 px = their offset from the edge). */
  let overlayTop = $state(0);
  let overlayBottom = $state(0);
  const insets = $derived({ top: overlayTop > 0 ? overlayTop + 12 : 0, right: 0, bottom: overlayBottom > 0 ? overlayBottom + 12 : 0, left: 0 });
  /** The timeline position that shows now. */
  let current = $state(0);
  let playing = $state(false);
  let lastVersion = untrack(() => app.anim.version);
  /** A held bracket key changes the fps without storing it; the key release stores it. */
  let fpsKeyHeld = false;
  /** The picker of the stage: a click adds the color under the pointer to the removed colors or to the replacement map. */
  let picker = $state<'remove' | 'replace' | null>(null);
  const picking = $derived(picker === 'remove');
  /** The last pointer over the stage while picking, and what its mask was made from. */
  let pickPointer: StagePointer | null = null;
  let maskKey = STALE_MASK;
  /** The pointer is on a spot that does not reach the border: a click there erases the color inside the drawing too. */
  let pickInside = $state(false);

  scene.onframe = (index) => {
    current = index;
  };

  const count = $derived(app.anim.built.frames.length);

  /** Distinct opaque colors over every output frame. */
  const colorCount = $derived.by(() => {
    void app.anim.version;
    const colors = new Set<number>();
    for (const frame of app.anim.built.frames) {
      const pixels = frame.pixels;
      // A frame holds long runs of one color: only a new run can add a color.
      let last = TRANSPARENT;
      for (let i = 0; i < pixels.length; i++) {
        const color = pixels[i];
        if (color === last) continue;
        last = color;
        if (color !== TRANSPARENT) colors.add(color);
      }
    }
    return colors.size;
  });

  const keptCount = $derived.by(() => {
    void app.anim.version;
    return app.anim.built.kept.filter(Boolean).length;
  });

  const referenceSprite = $derived.by(() => {
    void app.anim.framesVersion;
    return app.anim.displayFrame(app.anim.referenceIndex);
  });

  /** The swatches of the target chooser: the colors of every frame. */
  const paletteColors = $derived.by(() => {
    void app.anim.version;
    return app.anim.paletteColors();
  });

  const referenceInTimeline = $derived(app.anim.timeline.some((frame) => frame.index === app.anim.referenceIndex));

  /** New output frames: the scene reads them again and the stage follows a new size. */
  function syncSource(): void {
    const version = app.anim.version;
    if (version === lastVersion) return;
    lastVersion = version;
    if (scene.setSource(source())) stage?.syncContent();
    current = scene.index;
  }

  $effect(() => {
    void app.anim.version;
    untrack(syncSource);
  });

  $effect(() => {
    scene.background = app.previewBg;
    scene.onion = app.anim.onion;
    stage?.invalidate();
  });

  $effect(() => {
    scene.setFps(app.anim.fps);
  });

  onMount(() => {
    setPlaying(!prefersReducedMotion());
  });

  onDestroy(() => {
    if (fpsKeyHeld) app.anim.commitFps();
    scene.onframe = null;
    scene.setPlaying(false);
  });

  function setPlaying(on: boolean): void {
    scene.setPlaying(on);
    playing = scene.playing;
    current = scene.index;
  }

  function togglePlay(): void {
    setPlaying(!playing);
    sfx.play('tick');
  }

  function seek(position: number): void {
    setPlaying(false);
    scene.seek(position);
    current = scene.index;
    sfx.play('tick');
  }

  function step(delta: number): void {
    setPlaying(false);
    scene.step(delta);
    current = scene.index;
    sfx.play('tick');
  }

  function stepFps(direction: 1 | -1, big: boolean): void {
    app.anim.setFps(app.anim.fps + direction * (big ? 5 : 1), false);
  }

  function toggleOnion(): void {
    app.anim.setOnion(!app.anim.onion);
    sfx.play('tick');
  }

  function positionOf(id: number): number {
    return app.anim.timeline.findIndex((frame) => frame.id === id);
  }

  /** Shows an entry: a paused stage on its position. */
  function showEntry(id: number): void {
    syncSource();
    const position = positionOf(id);
    if (position < 0) return;
    setPlaying(false);
    scene.seek(position);
    current = scene.index;
  }

  function onSelect(id: number): void {
    app.anim.select(id);
    showEntry(id);
    sfx.play('tick');
  }

  function onRemove(id: number): void {
    app.anim.remove(id);
    sfx.play('erase');
    // The screen needs a timeline: an empty one goes back to the frame pick.
    if (app.anim.timeline.length === 0) {
      void app.goTo('anim-frames');
      return;
    }
    syncSource();
  }

  function onDuplicate(id: number): void {
    const frame = app.anim.duplicate(id);
    if (!frame) return;
    sfx.play('tick');
    if (playing) syncSource();
    else showEntry(frame.id);
    scene.pop();
  }

  function onMove(id: number, delta: -1 | 1): void {
    if (!app.anim.move(id, delta)) return;
    sfx.play('tick');
    if (playing) syncSource();
    else showEntry(id);
  }

  function setPicker(next: 'remove' | 'replace' | null): void {
    if (next === picker) return;
    picker = next;
    sfx.play('tick');
    // The color under the pointer must stay still while the user aims.
    if (next) setPlaying(false);
    else pickPointer = null;
    maskKey = STALE_MASK;
    updateMask();
  }

  function togglePicker(kind: 'remove' | 'replace'): void {
    setPicker(picker === kind ? null : kind);
  }

  /** The tile of the shown frame under the pointer, as an index, or -1. */
  function tileAt(p: StagePointer | null): number {
    if (!p) return -1;
    const col = Math.floor(p.ix);
    const row = Math.floor(p.iy);
    const { cols, rows } = app.anim.built.cell;
    return col >= 0 && row >= 0 && col < cols && row < rows ? row * cols + col : -1;
  }

  /** The shown entry and what a click on the tile under `p` does, in grid tiles of that entry. */
  function pickUnder(p: StagePointer | null): { id: number; pick: RemovalPick } | null {
    const entry = app.anim.timeline[scene.index];
    const tile = entry ? tileAt(p) : -1;
    const grid = tile >= 0 ? app.anim.gridTile(entry.id, tile) : -1;
    const pick = grid >= 0 ? app.anim.pickAt(entry.id, grid) : null;
    return pick ? { id: entry.id, pick } : null;
  }

  /** The shown entry and the grid tile under `p`, or null. */
  function gridUnder(p: StagePointer | null): { id: number; grid: number } | null {
    const entry = app.anim.timeline[scene.index];
    const tile = entry ? tileAt(p) : -1;
    const grid = tile >= 0 ? app.anim.gridTile(entry.id, tile) : -1;
    return grid >= 0 ? { id: entry.id, grid } : null;
  }

  /** The replacement picker: the tiles that a click recolors and the ones of the pending group, over the shown frame. */
  function updateReplaceMask(): void {
    const frame = app.anim.built.frames[scene.index];
    const entry = app.anim.timeline[scene.index];
    const list = app.anim.replaced;
    const under = frame ? gridUnder(pickPointer) : null;
    const color = under ? app.anim.colorAt(under.id, under.grid) : null;
    const key = `replace|${color}|${list.tolerance}|${list.pending.map((pending) => pending.color).join(',')}|${app.anim.version}|${scene.index}`;
    if (key === maskKey) return;
    maskKey = key;
    if (!frame || !entry) {
      scene.setMask(null, scene.index);
      return;
    }
    const hover = under && color !== null ? app.anim.toCell(under.id, app.anim.replaceTiles(under.id, color, list.tolerance)) : new Int32Array(0);
    const held = app.anim.toCell(entry.id, app.anim.pendingTiles(entry.id));
    scene.setMask(hover.length > 0 || held.length > 0 ? bakeReplaceMask(frame.cols, frame.rows, held, hover) : null, scene.index);
  }

  /** The tiles of the shown frame that a click erases and the ones that stay, over the frame. */
  function updateMask(): void {
    pickInside = false;
    if (picker === 'replace') {
      updateReplaceMask();
      return;
    }
    const frame = app.anim.built.frames[scene.index];
    const under = picking && frame ? pickUnder(pickPointer) : null;
    const pick = under && under.pick.action !== 'listed' ? under.pick : null;
    pickInside = pick?.scope === 'all';
    const key = under && pick ? `${pick.color}|${pick.scope}|${app.anim.removed.tolerance}|${app.anim.version}|${scene.index}` : '';
    if (key === maskKey) return;
    maskKey = key;
    if (!under || !pick || !frame) {
      scene.setMask(null, scene.index);
      return;
    }
    const cleared = app.anim.toCell(under.id, pick.cleared);
    const kept = app.anim.toCell(under.id, pick.kept);
    scene.setMask(bakePickMask(frame.cols, frame.rows, cleared, kept, pick.scope), scene.index);
  }

  // The mask follows the tolerance sliders and the pending group while the pointer rests.
  $effect(() => {
    void app.anim.removed.tolerance;
    void app.anim.replaced.tolerance;
    void app.anim.replaced.pending;
    untrack(updateMask);
  });

  function onStageHover(p: StagePointer | null): void {
    if (!picker) return;
    pickPointer = p;
    updateMask();
  }

  /** The replacement picker: a click picks a source and opens the target chooser; Shift+click adds it to the group only. */
  function replacePick(p: StagePointer): void {
    const under = gridUnder(p);
    const color = under ? app.anim.colorAt(under.id, under.grid) : null;
    if (color === null) {
      sfx.play('tick');
      return;
    }
    if (p.shift) app.anim.replaced.hold(color);
    else app.anim.replaced.pick(color);
    sfx.play('tick');
    maskKey = STALE_MASK;
    updateMask();
  }

  /** A flash on the tiles of the shown frame that changed since `before`. */
  function flashChange(before: Uint32Array | undefined): void {
    const frame = app.anim.built.frames[scene.index];
    if (!before || !frame || frame.pixels.length !== before.length) return;
    const changed = changedTiles(before, frame.pixels);
    if (changed.length > 0) scene.flash(bakePickFlash(frame.cols, frame.rows, changed, []));
  }

  /** The target chooser: one entry per pending source, in every frame. */
  function chooseTarget(to: number): void {
    const list = app.anim.replaced;
    const entries = list.pendingEntries(to);
    list.cancel();
    if (entries.length === 0) return;
    const before = app.anim.built.frames[scene.index]?.pixels;
    const frames = app.anim.addReplacedColors(entries);
    if (frames === 0) {
      app.toast(t('toast.colorNotReplaced'), 'info');
      return;
    }
    syncSource();
    flashChange(before);
    sfx.play(to === TRANSPARENT ? 'erase' : 'fill');
    app.toast(replacedToast('frames', frames, to === TRANSPARENT), 'success');
    maskKey = STALE_MASK;
    updateMask();
  }

  /** One step of the history of the animation: a list step, the container or an offset. */
  function replay(way: 'undo' | 'redo'): void {
    const before = app.anim.built.frames[scene.index]?.pixels;
    const done = way === 'undo' ? app.anim.undo() : app.anim.redo();
    if (!done) return;
    sfx.play('undo');
    syncSource();
    if (done.kind === 'lists') {
      flashChange(before);
      app.toast(historyToast(done.action, way), 'info');
    }
    maskKey = STALE_MASK;
    updateMask();
  }

  function onStageDown(p: StagePointer): boolean | void {
    if (!picker) return;
    pickPointer = p;
    if (picker === 'replace') {
      replacePick(p);
      return false;
    }
    const frame = app.anim.built.frames[scene.index];
    const under = frame ? pickUnder(p) : null;
    if (!frame || !under) {
      sfx.play('tick');
      return false;
    }
    const { id, pick } = under;
    if (pick.action === 'listed') {
      app.toast(t('toast.colorAlreadyRemoved'), 'info');
      return false;
    }
    // In cell tiles before the build: the crop or the feet can move the cell.
    const cleared = app.anim.toCell(id, pick.cleared);
    const kept = app.anim.toCell(id, pick.kept);
    const frames = app.anim.addRemovedColor(pick.color, pick.scope);
    if (frames === 0) {
      app.toast(t('toast.colorNotInFrames'), 'info');
      return false;
    }
    scene.shatter(cleared, frame.pixels, bakePickFlash(frame.cols, frame.rows, cleared, kept));
    sfx.play('erase');
    app.toast(removedToast('frames', frames, pick.scope), 'success');
    return false;
  }

  function openExport(): void {
    if (app.loading) return;
    app.animExportOpen = true;
  }

  function pickReference(): void {
    app.anim.seek(app.anim.referenceIndex);
    void app.goTo('anim-frames');
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function stopKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  /** Capture phase: Space and the arrows act on the playback before the stage pans with them. */
  function onKeyDown(event: KeyboardEvent): void {
    if (app.animExportOpen || app.confirmRequest || app.aboutOpen) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod) {
      const key = event.key.toLowerCase();
      if (key === 's' && !event.altKey) {
        event.preventDefault();
        openExport();
      } else if (!isEditable(event.target) && (key === 'z' || key === 'y')) {
        event.preventDefault();
        replay(key === 'y' || event.shiftKey ? 'redo' : 'undo');
      }
      return;
    }
    if (isEditable(event.target)) return;
    const key = event.key;
    const selected = app.anim.selectedId;
    if (event.altKey) {
      // Alt+arrow is also the history navigation of a browser: it never leaves the screen.
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        stopKey(event);
        if (selected !== null) onMove(selected, key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }
    if (key === ' ') {
      if (event.target instanceof HTMLButtonElement) return;
      stopKey(event);
      if (!event.repeat) togglePlay();
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      stopKey(event);
      step(key === 'ArrowLeft' ? -1 : 1);
    } else if (key === ',' || key === '.') {
      event.preventDefault();
      step(key === ',' ? -1 : 1);
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      seek(key === 'Home' ? 0 : count - 1);
    } else if (key === '[' || key === '{' || key === ']' || key === '}') {
      event.preventDefault();
      fpsKeyHeld = true;
      stepFps(key === '[' || key === '{' ? -1 : 1, event.shiftKey);
    } else if (key.toLowerCase() === 'o') {
      event.preventDefault();
      if (!event.repeat) toggleOnion();
    } else if ((key === 'Delete' || key === 'Backspace') && selected !== null) {
      event.preventDefault();
      if (!event.repeat) onRemove(selected);
    } else if (key.toLowerCase() === 'd' && selected !== null) {
      event.preventDefault();
      if (!event.repeat) onDuplicate(selected);
    } else if (key.toLowerCase() === 'e' && selected !== null) {
      event.preventDefault();
      if (!event.repeat) void app.editAnimFrame(selected);
    } else if (key.toLowerCase() === 'r' || key.toLowerCase() === 'c') {
      event.preventDefault();
      if (!event.repeat) togglePicker(key.toLowerCase() === 'r' ? 'remove' : 'replace');
    } else if (key === 'Escape' && (picker || app.anim.replaced.pending.length > 0)) {
      event.preventDefault();
      // Esc first drops the pending group of the replacement picker, then stops the picker.
      if (app.anim.replaced.cancel()) {
        sfx.play('tick');
        maskKey = STALE_MASK;
        updateMask();
      } else setPicker(null);
    }
  }

  function commitFpsKey(): void {
    if (!fpsKeyHeld) return;
    fpsKeyHeld = false;
    app.anim.commitFps();
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === '[' || event.key === '{' || event.key === ']' || event.key === '}') commitFpsKey();
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} onkeyup={onKeyUp} onblur={commitFpsKey} />

<section class="anim-screen">
  <div class="anim-main">
    <div class="anim-stage">
      <Stage
        bind:this={stage}
        {scene}
        {insets}
        label={t('anim.stageLabel')}
        cursor={picker ? PICKER_CURSOR : 'default'}
        onprimarydown={onStageDown}
        onhover={onStageHover}
      >
        <div class="stage-top" bind:offsetHeight={overlayTop}>
          <div class="stage-zoom">
            <button type="button" class="icon-btn" aria-label={t('clean.undo')} title="{t('clean.undo')} (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!app.anim.canUndo} onclick={() => replay('undo')}>
              <Icon name="undo" />
            </button>
            <button type="button" class="icon-btn" aria-label={t('clean.redo')} title="{t('clean.redo')} (Ctrl+Y)" aria-keyshortcuts="Control+Y Control+Shift+Z" disabled={!app.anim.canRedo} onclick={() => replay('redo')}>
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
          <div class="stage-top-end">
            <button type="button" class="tool-btn" aria-pressed={app.anim.onion} aria-keyshortcuts="O" title="{t('anim.onionHint')} (O)" onclick={toggleOnion}>
              <Icon name="onion" size={18} />
              {t('anim.onion')}
            </button>
            <div class="stage-bg" role="group" aria-labelledby="anim-bg-label">
              <span class="bg-label" id="anim-bg-label">{t('clean.background')}</span>
              <div class="segmented bg-choice">
                {#each BACKGROUNDS as bg (bg.id)}
                  <button type="button" aria-pressed={app.previewBg === bg.id} onclick={() => app.setPreviewBackground(bg.id)}>{t(bg.label)}</button>
                {/each}
              </div>
            </div>
          </div>
        </div>

        <div class="transport" role="group" aria-label={t('animPlay.transport')} bind:offsetHeight={overlayBottom}>
          <div class="transport-group">
            <button type="button" class="icon-btn" aria-label={t('anim.first')} title="{t('anim.first')} (Home)" aria-keyshortcuts="Home" onclick={() => seek(0)}>
              <Icon name="first" size={18} />
            </button>
            <button type="button" class="icon-btn" aria-label={t('anim.prev')} title="{t('anim.prev')} (←)" aria-keyshortcuts="ArrowLeft" onclick={() => step(-1)}>
              <Icon name="stepBack" size={18} />
            </button>
            <button
              type="button"
              class="icon-btn play-btn"
              aria-label={playing ? t('anim.pause') : t('anim.play')}
              title="{playing ? t('anim.pause') : t('anim.play')} ({t('animPlay.keySpace')})"
              aria-keyshortcuts="Space"
              disabled={count < 2}
              onclick={togglePlay}
            >
              <Icon name={playing ? 'pause' : 'play'} size={20} />
            </button>
            <button type="button" class="icon-btn" aria-label={t('anim.next')} title="{t('anim.next')} (→)" aria-keyshortcuts="ArrowRight" onclick={() => step(1)}>
              <Icon name="stepForward" size={18} />
            </button>
            <button type="button" class="icon-btn" aria-label={t('anim.last')} title="{t('anim.last')} (End)" aria-keyshortcuts="End" onclick={() => seek(count - 1)}>
              <Icon name="last" size={18} />
            </button>
            <span class="counter" aria-live="off">{Math.min(current + 1, count)} / {count}</span>
          </div>

          <FpsControl />
        </div>
      </Stage>
      <ProgressPill />
    </div>

    <div class="anim-timeline">
      <AnimTimeline
        frames={app.anim.timeline}
        thumbOf={(_frame: AnimFrame, position: number) => app.anim.built.frames[position] ?? null}
        version={app.anim.version}
        selectedId={app.anim.selectedId}
        {current}
        referenceIndex={app.anim.referenceColors ? app.anim.referenceIndex : null}
        background={app.previewBg}
        onselect={onSelect}
        onremove={onRemove}
        onduplicate={onDuplicate}
        onmove={onMove}
        onedit={(id) => void app.editAnimFrame(id)}
        edited={(frame) => app.anim.isEdited(frame.id)}
      />
    </div>
  </div>

  <aside class="anim-panel">
    <PanelSplitter />
    <div class="anim-panel-scroll">
      <header class="anim-head">
        <h1 class="anim-title">{t('animPlay.title')}</h1>
      </header>

      <div class="anim-section">
        <CleanupPresets hint={t('animPlay.cleanupHint')} aside={colorCount === 1 ? t('set.colorCountOne') : t('set.colorCount', { count: colorCount })} />
      </div>

      <div class="anim-section">
        <ToggleSwitch
          id="anim-ref-colors"
          label={t('animPlay.refColors')}
          hint={t('animPlay.refColorsHint')}
          checked={app.anim.referenceColors}
          onchange={(on) => app.anim.setReferenceColors(on)}
        />
        <div class="reference" class:is-off={!app.anim.referenceColors}>
          <canvas class="reference-thumb" use:spriteThumb={referenceSprite} aria-hidden="true"></canvas>
          <div class="reference-text">
            <span class="reference-name">
              <Icon name="star" size={14} />
              {t('anim.frameNumber', { n: app.anim.referenceIndex + 1 })}
            </span>
            {#if !referenceInTimeline}<span class="hint">{t('animPlay.refFromVideo')}</span>{/if}
          </div>
          <button type="button" class="btn btn-quiet reference-pick" onclick={pickReference} disabled={app.loading}>{t('animPlay.refPick')}</button>
        </div>
        <p class="hint">{t('animPlay.refPickHint')}</p>
      </div>

      <div class="anim-section">
        <ToggleSwitch
          id="anim-erase-bg"
          label={t('animPlay.eraseBg')}
          hint={t('animPlay.eraseBgHint')}
          checked={app.anim.eraseBackground}
          onchange={(on) => app.anim.setEraseBackground(on)}
        />
        {#if app.anim.eraseBackground && keptCount > 0}
          <p class="kept-note" role="status">{keptCount === 1 ? t('animPlay.keptOne') : t('animPlay.kept', { count: keptCount })}</p>
        {/if}
      </div>

      <div class="anim-section">
        <RemoveColors list={app.anim.removed} variant="frames" {picking} inside={pickInside} ontogglepick={() => togglePicker('remove')} />
      </div>

      <div class="anim-section">
        <ReplaceColors list={app.anim.replaced} variant="frames" picking={picker === 'replace'} ontogglepick={() => togglePicker('replace')} colors={paletteColors} onchoose={chooseTarget} />
      </div>

      <section class="anim-section field" aria-labelledby="anim-cell-title">
        <h2 class="section-title" id="anim-cell-title">{t('animPlay.cell')}</h2>
        <div class="segmented cell-choice" role="group" aria-labelledby="anim-cell-title">
          {#each CELL_MODES as mode (mode)}
            <button type="button" aria-pressed={app.anim.cell === mode} title={t(CELL_LABELS[mode].hint)} onclick={() => app.anim.setCell(mode)}>{t(CELL_LABELS[mode].label)}</button>
          {/each}
        </div>
        <p class="hint output-size">
          {app.anim.built.cell.cols} × {app.anim.built.cell.rows} px ·
          {count === 1 ? t('animPlay.frameCountOne') : t('animPlay.frameCount', { count })}
        </p>
      </section>

      <section class="anim-section keys" aria-labelledby="anim-keys-title">
        <h2 class="section-title" id="anim-keys-title">{t('animPlay.keysTitle')}</h2>
        <ul class="key-list">
          {#each LEGEND as item (item.text)}
            <li class="key-item">
              <span class="key-caps">
                {#if item.keys === 'space'}
                  <kbd class="keycap">{t('animPlay.keySpace')}</kbd>
                {:else if item.keys === 'arrows'}
                  <span class="keycap-group"><kbd class="keycap">←</kbd><kbd class="keycap">→</kbd></span>
                {:else if item.keys === 'brackets'}
                  <span class="keycap-group"><kbd class="keycap">[</kbd><kbd class="keycap">]</kbd></span>
                {:else if item.keys === 'altArrows'}
                  <span class="keycap-group"><kbd class="keycap">Alt</kbd><kbd class="keycap">←</kbd><kbd class="keycap">→</kbd></span>
                {:else if item.keys === 'ctrlS'}
                  <span class="keycap-group"><kbd class="keycap">Ctrl</kbd><kbd class="keycap">S</kbd></span>
                {:else if item.keys === 'ctrlZ'}
                  <span class="keycap-group"><kbd class="keycap">Ctrl</kbd><kbd class="keycap">Z</kbd></span>
                {:else if item.keys === 'delete'}
                  <kbd class="keycap">Delete</kbd>
                {:else}
                  <kbd class="keycap">{item.keys.toUpperCase()}</kbd>
                {/if}
              </span>
              <span class="key-text"><KeyText text={t(item.text)} /></span>
            </li>
          {/each}
        </ul>
      </section>
    </div>

    <div class="anim-footer">
      <div class="anim-actions">
        <button type="button" class="btn btn-quiet" title={t('animPlay.back')} onclick={() => app.goTo('anim-frames')} disabled={app.loading}>
          <Icon name="back" size={18} />
          <span class="visually-hidden">{t('animPlay.back')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-big export-btn" aria-keyshortcuts="Control+S" title="{t('animPlay.export')} (Ctrl+S)" onclick={openExport} disabled={app.loading}>
          <Icon name="download" size={20} />
          {t('animPlay.export')}
        </button>
      </div>
    </div>
  </aside>
</section>

<style>
  @layer components {
    .anim-screen {
      --anim-panel-w: clamp(320px, 24vw, 380px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--panel-size, var(--anim-panel-w));
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .anim-main {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .anim-stage {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .anim-timeline {
      min-width: 0;
      border-top: 2px solid var(--line);
      background: var(--surface-1);
    }

    .stage-top {
      position: absolute;
      top: var(--space-3);
      left: var(--space-3);
      right: var(--space-3);
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-2);
      pointer-events: none;

      & > * {
        pointer-events: auto;
      }
    }

    .stage-top-end {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--space-2);
    }

    .stage-zoom {
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
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

    .tool-btn {
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
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not([aria-pressed='true']) {
        background: var(--surface-2);
      }

      &:active {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &[aria-pressed='true'] {
        color: var(--on-primary);
        background: var(--teal);
        border-color: var(--teal);
      }
    }

    /* One compact bar at the bottom center; it wraps to two rows on a narrow stage. */
    .transport {
      position: absolute;
      left: 50%;
      bottom: var(--space-3);
      translate: -50% 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: var(--space-1) var(--space-3);
      width: max-content;
      max-width: calc(100% - 2 * var(--space-3));
      padding: 3px var(--space-2);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .transport-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .transport .icon-btn {
      width: 36px;
      height: 36px;
    }

    .play-btn:not(:disabled) {
      color: var(--on-primary);
      background: var(--primary);

      &:hover {
        color: var(--on-primary);
        background: var(--primary);
      }
    }

    .counter {
      min-width: 7ch;
      padding: 0 var(--space-1);
      color: var(--text);
      font: 600 0.875rem/1 var(--font-mono);
      font-variant-numeric: tabular-nums;
      text-align: center;
      white-space: nowrap;
    }

    .anim-panel {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .anim-panel-scroll {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: var(--space-4);
      min-height: 0;
      padding: var(--space-3) var(--space-5) var(--space-4);
      overflow: hidden auto;
    }

    .anim-title {
      font-size: 0.9375rem;
    }

    .anim-section {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }

    /* With no room, the button goes under the frame name instead of squeezing it. */
    .reference {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      transition: opacity var(--dur-hover) var(--ease-sym);

      &.is-off {
        opacity: 0.6;
      }
    }

    .reference-thumb {
      flex: none;
      width: 44px;
      height: 44px;
      object-fit: contain;
      image-rendering: pixelated;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
    }

    .reference-text {
      display: grid;
      flex: 1 1 auto;
      gap: 2px;
      min-width: min-content;
    }

    .reference-name {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      font-weight: 600;
      font-size: 0.875rem;
      white-space: nowrap;

      & :global(.icon) {
        color: var(--yellow);
      }
    }

    .reference-pick {
      flex: none;
      min-height: 36px;
      padding-inline: var(--space-3);
      font-size: 0.875rem;
    }

    .kept-note {
      padding: var(--space-1) var(--space-2);
      color: var(--text);
      font-size: 0.8125rem;
      line-height: 1.4;
      border-left: 3px solid var(--yellow);
      background: var(--surface-sunken);
      border-radius: var(--radius-s);
    }

    /* Four modes in two rows, so each label keeps one line in the narrow panel. */
    .cell-choice {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));

      & button {
        font-size: 0.8125rem;
      }
    }

    .output-size {
      font-variant-numeric: tabular-nums;
    }

    .key-list {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .key-item {
      display: grid;
      grid-template-columns: 7.5em minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2);
      font-size: 0.8125rem;
      line-height: 1.35;
    }

    .key-caps {
      color: var(--text);
      font-weight: 700;
      white-space: nowrap;
    }

    .key-text {
      color: var(--text-muted);
    }

    .anim-footer {
      padding: var(--space-3) var(--space-5) var(--space-4);
      background: var(--surface-sunken);
      border-top: 2px solid var(--line);
    }

    .anim-actions {
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

    /* A short window: the key legend goes first, so the options and the export stay in view. */
    @media (max-height: 760px) {
      .keys {
        display: none;
      }

      .anim-panel-scroll {
        gap: var(--space-3);
        padding-inline: var(--space-4);
      }

      .anim-footer {
        padding: var(--space-2) var(--space-4) var(--space-3);
      }
    }
  }
</style>
