<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { track } from '../app/analytics.ts';
  import type { AnimFrame } from '../app/animation.svelte.ts';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import { activeLocale } from '../app/locale.svelte.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { FrameOffset } from '../core/frames.ts';
  import { diffShare, diffSprites, loopReturn, matchLevel, medianStep, type MatchLevel } from '../core/loop.ts';
  import { PARAMS } from '../core/params.ts';
  import type { TileBox } from '../core/sprite.ts';
  import type { Sprite } from '../core/types.ts';
  import type { AnimSource } from './anim-scene.ts';
  import AnimTimeline from './AnimTimeline.svelte';
  import type { PreviewBackground } from './clean-scene.ts';
  import { holdRepeat } from './hold-repeat.ts';
  import { historyToast } from './list-feedback.ts';
  import Icon from './Icon.svelte';
  import KeyText from './KeyText.svelte';
  import LoopMeter from './LoopMeter.svelte';
  import LoopPreview from './LoopPreview.svelte';
  import LoopSeam from './LoopSeam.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import Stage from './Stage.svelte';
  import PanelSplitter from './PanelSplitter.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import { cursorOf, draggedTileBox, sameTileBox } from './box-handles.ts';
  import { ContainerScene, type ContainerMode, type ContainerPart } from './container-scene.ts';
  import type { StagePointer } from './stage-renderer.ts';

  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  const anim = app.anim;

  function sourceOf(): AnimSource {
    const { cols, rows } = anim.gridSize;
    return {
      count: anim.count,
      cols,
      rows,
      frameOf: (index) => anim.displayFrame(index),
      previewOf: (index) => {
        const preview = anim.preview;
        return preview && preview.index === index ? preview.tiles : null;
      },
    };
  }

  function videoFps(): number {
    return anim.info?.fps ?? TUNING.anim.defaultFps;
  }

  let stage: Stage | undefined = $state();
  /** The overlay bands of the stage, measured, so the fit keeps the frame clear of them (12 px = their offset from the edge). */
  let overlayTop = $state(0);
  let overlayBottom = $state(0);
  const insets = $derived({ top: overlayTop > 0 ? overlayTop + 12 : 0, right: 0, bottom: overlayBottom > 0 ? overlayBottom + 12 : 0, left: 0 });
  let monitor: HTMLCanvasElement | undefined = $state();
  let playing = $state(false);
  /** The video frames whose slider marks pop once, after an add. */
  let popped = $state.raw<ReadonlySet<number>>(new Set());
  /** "Adicionar intervalo": one frame every this many; it follows the step size until the user types another. */
  let rangeEvery = $state(untrack(() => anim.stepSize));
  let lastSource = untrack(() => sourceOf());
  let lastFramesVersion = untrack(() => anim.framesVersion);

  function sceneLabels() {
    return { size: (cols: number, rows: number) => t('frames.containerSize', { w: cols, h: rows }) };
  }

  const scene = new ContainerScene(lastSource, videoFps(), untrack(() => sceneLabels()));
  scene.onframe = (index) => anim.seek(index);
  /** The ghost is the nearest picked frame before the shown one; the loop check shows the first entry instead. */
  scene.ghostOf = (index) => {
    if (anim.loopCheck) {
      const first = anim.first;
      return first && first.index !== index ? first.index : null;
    }
    let best: number | null = null;
    for (const frame of anim.timeline) if (frame.index < index && (best === null || frame.index > best)) best = frame.index;
    return best;
  };
  /** The first entry sits where the output places it, relative to the shown frame. */
  scene.ghostShift = (index) => {
    const first = anim.first;
    if (!anim.loopCheck || !first) return null;
    const shown = shownOffsetOf(index);
    return { x: first.offset.x - shown.x, y: first.offset.y - shown.y };
  };

  /** The offset of a video frame on the stage: the selected entry when it shows the frame, else its entry, else the inherited one. */
  function shownOffsetOf(index: number): FrameOffset {
    const selected = anim.selected;
    if (selected && selected.index === index) return selected.offset;
    return anim.entryOf(index)?.offset ?? anim.inheritedOffset(index);
  }

  /** The timeline entry that the container edits on the shown frame: the selected one when it shows this frame. */
  const entry = $derived.by((): AnimFrame | null => {
    const selected = anim.selected;
    return selected && selected.index === anim.cursor ? selected : anim.entryOf(anim.cursor);
  });
  const hasContainer = $derived(anim.container !== null && anim.timeline.length > 0);
  const containerMode = $derived<ContainerMode>(!entry ? 'preview' : entry.id === anim.first?.id ? 'resize' : 'move');
  const shownBox = $derived(hasContainer ? anim.containerFor(entry ? entry.offset : anim.inheritedOffset(anim.cursor)) : null);
  let cursor = $state('default');

  type ContainerDrag =
    | { kind: 'box'; part: ContainerPart; start: TileBox; startIx: number; startIy: number; offset: { x: number; y: number }; last: TileBox }
    | { kind: 'offset'; id: number; start: { x: number; y: number }; startIx: number; startIy: number; last: { x: number; y: number } };
  let drag: ContainerDrag | null = null;

  const lastIndex = $derived(Math.max(0, anim.count - 1));
  const cursorReady = $derived(anim.has(anim.cursor));
  /** The count of the timeline; "of max" shows only near the limit. */
  const budget = $derived(anim.budget);
  const nearLimit = $derived(budget.max > 0 && budget.used >= budget.max * TUNING.anim.limitNearShare);
  const uses = $derived(anim.uses(anim.cursor));
  const marks = $derived([...new Set(anim.timeline.map((frame) => frame.index))].sort((a, b) => a - b));
  const isReference = $derived(anim.referenceIndex === anim.cursor);
  const seconds = $derived(new Intl.NumberFormat(activeLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(anim.cursor / videoFps()));
  const monitorH = $derived.by(() => {
    const info = anim.info;
    if (!info || info.width <= 0) return TUNING.anim.monitorPx;
    return Math.max(1, Math.round((TUNING.anim.monitorPx * info.height) / info.width));
  });

  $effect(() => {
    scene.seek(anim.cursor);
  });

  $effect(() => {
    scene.setFps(videoFps());
  });

  /** A frame or a preview arrived: the stage looks for the frame of the cursor again. */
  $effect(() => {
    void anim.storeVersion;
    void anim.preview;
    scene.invalidate();
  });

  /** New sampled frames: the same grid repaints; another grid size or count gives the scene a new source. */
  $effect(() => {
    const version = anim.framesVersion;
    untrack(() => {
      if (version === lastFramesVersion) return;
      lastFramesVersion = version;
      const next = sourceOf();
      const same = next.count === lastSource.count && next.cols === lastSource.cols && next.rows === lastSource.rows;
      lastSource = next;
      if (same) {
        scene.refresh();
        return;
      }
      if (scene.setSource(next)) stage?.syncContent();
      scene.seek(anim.cursor);
    });
  });

  $effect(() => {
    scene.background = app.previewBg;
    scene.onion = anim.onion || anim.loopCheck;
    scene.setGhostKind(anim.loopCheck ? 'first' : 'previous');
    void anim.first;
    void anim.selectedId;
    void anim.timeline;
    stage?.invalidate();
  });

  /** The live entries placed in the container as the output places them, each with its entry. */
  function boxedTimeline(): { entries: AnimFrame[]; frames: Sprite[] } {
    const entries: AnimFrame[] = [];
    const frames: Sprite[] = [];
    for (const frame of anim.timeline) {
      if (!anim.has(frame.index)) continue;
      const sprite = anim.boxedFrame(frame.index, frame.offset);
      if (!sprite) continue;
      entries.push(frame);
      frames.push(sprite);
    }
    return { entries, frames };
  }

  /** The median change between neighbor entries, the unit of the match meter; measured after the changes rest. */
  let loopStep = $state<number | null>(null);
  /** The video frame that "Find the loop end" picked, for its scrub mark. */
  let loopFound = $state<number | null>(null);

  $effect(() => {
    if (!anim.loopCheck) {
      loopStep = null;
      return;
    }
    void anim.storeVersion;
    void anim.framesVersion;
    void anim.timeline;
    void anim.container;
    void anim.eraseBackground;
    const timer = setTimeout(() => {
      const { frames } = boxedTimeline();
      try {
        loopStep = frames.length >= PARAMS.loop.minFrames ? medianStep(frames) : null;
      } catch {
        loopStep = null;
      }
    }, TUNING.anim.seamCheckMs);
    return () => clearTimeout(timer);
  });

  /** How much the shown frame matches the first entry, both placed in the container. */
  const loopMatch = $derived.by((): { percent: number; level: MatchLevel | null } | null => {
    const first = anim.first;
    const at = anim.cursor;
    if (!anim.loopCheck || !first || at === first.index) return null;
    void anim.storeVersion;
    void anim.framesVersion;
    void anim.container;
    const shown = anim.boxedFrame(at, shownOffsetOf(at));
    const base = anim.boxedFrame(first.index, first.offset);
    if (!shown || !base) return null;
    try {
      const share = diffShare(diffSprites(shown, base));
      let step = loopStep;
      if (step === null) {
        const back = at - anim.stepSize;
        const before = back >= 0 && anim.has(back) ? anim.boxedFrame(back, shownOffsetOf(back)) : null;
        if (before) step = diffShare(diffSprites(shown, before));
      }
      return { percent: Math.round((1 - share) * 100), level: step === null ? null : matchLevel(share, step) };
    } catch {
      // The container changed between the two frames: the next change measures again.
      return null;
    }
  });

  let lastMatchLevel: MatchLevel | null = null;

  $effect(() => {
    const level = loopMatch?.level ?? null;
    untrack(() => {
      const before = lastMatchLevel;
      lastMatchLevel = level;
      if (level !== 'match' || before === 'match' || playing) return;
      scene.flash();
      sfx.play('lock');
    });
  });

  /** The largest video index of the timeline below `at`, or null. */
  function lastIndexBefore(at: number): number | null {
    let best: number | null = null;
    for (const frame of anim.timeline) if (frame.index < at && (best === null || frame.index > best)) best = frame.index;
    return best;
  }

  /** The action of the meter at the cursor: close the loop on a later entry, or fill the gap up to the cursor. */
  const loopAction = $derived.by(() => {
    const first = anim.first;
    const at = anim.cursor;
    if (!anim.loopCheck || !first || at <= first.index) return null;
    if (anim.timeline.some((frame) => frame.index >= at)) {
      return { label: t('frames.loopClose'), hint: t('frames.loopCloseHint'), primary: loopMatch?.level === 'match', run: () => void closeLoopHere() };
    }
    const before = lastIndexBefore(at);
    const every = rangeStep();
    if (before === null || before + every >= at) return null;
    return { label: t('frames.loopFill'), hint: t('frames.loopFillHint', { every }), primary: false, run: () => void fillLoopToHere() };
  });

  const loopNote = $derived(anim.first && anim.cursor === anim.first.index ? t('frames.loopOnFirst') : loopMatch ? null : t('loop.waiting'));
  const lastEntry = $derived(anim.timeline.at(-1) ?? null);

  $effect(() => {
    rangeEvery = anim.stepSize;
  });

  $effect(() => {
    scene.setContainer(shownBox, containerMode);
  });

  // The size label is drawn on the canvas: a language change sets it again and repaints.
  $effect(() => {
    void activeLocale();
    scene.labels = sceneLabels();
    scene.invalidate();
  });

  /** The monitor shows the frame of the original video, scaled to its box. */
  $effect(() => {
    const canvas = monitor;
    const bitmap = anim.thumbOf(anim.cursor);
    const height = monitorH;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(TUNING.anim.monitorPx * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (bitmap) ctx.drawImage(bitmap, 0, 0, w, h);
  });

  onDestroy(() => {
    scene.setPlaying(false);
    scene.onframe = null;
  });

  function setPlaying(on: boolean): void {
    const next = on && anim.count > 1;
    if (next === playing) return;
    playing = next;
    scene.setPlaying(next);
  }

  function seekTo(index: number): void {
    setPlaying(false);
    if (anim.seek(index)) sfx.play('tick');
  }

  function stepBy(direction: -1 | 1, shift: boolean): void {
    seekTo(anim.cursor + direction * (shift ? TUNING.anim.shiftStep : anim.stepSize));
  }

  function setStepSize(size: number): void {
    if (anim.setStepSize(size)) sfx.play('tick');
    stepDraft = String(anim.stepSize);
  }

  /** The typed step: a good number takes effect; anything else goes back to the step. */
  let stepDraft = $state(untrack(() => String(anim.stepSize)));
  let stepFocused = false;

  $effect(() => {
    const size = anim.stepSize;
    if (!stepFocused) stepDraft = String(size);
  });

  function commitStepDraft(): void {
    const value = Number(stepDraft.trim());
    if (stepDraft.trim() !== '' && Number.isFinite(value) && value >= 1) setStepSize(value);
    stepDraft = String(anim.stepSize);
  }

  function onStepKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitStepDraft();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setStepSize(anim.stepSize + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? TUNING.anim.stepWheelShift : 1));
    } else if (event.key === 'Escape') {
      stepDraft = String(anim.stepSize);
    }
  }

  /**
   * The wheel over the step control: up adds 1 and down takes 1, with Shift 5. Not passive, so the panel does not
   * scroll; trackpad deltas add up, so one notch is one step.
   */
  function stepWheel(node: HTMLElement) {
    let total = 0;
    let last = 0;
    const onWheel = (event: WheelEvent): void => {
      // Shift turns a vertical wheel into a horizontal one on some systems.
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      const now = performance.now();
      if (now - last > 200) total = 0;
      last = now;
      let direction = 0;
      if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(delta) >= TUNING.anim.stepWheelPx) {
        direction = Math.sign(delta);
        total = 0;
      } else {
        total += delta;
        if (Math.abs(total) >= TUNING.anim.stepWheelPx) {
          direction = Math.sign(total);
          total = 0;
        }
      }
      if (direction === 0) return;
      setStepSize(anim.stepSize - direction * (event.shiftKey ? TUNING.anim.stepWheelShift : 1));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return {
      destroy: () => node.removeEventListener('wheel', onWheel),
    };
  }

  function toggleFrame(): void {
    setPlaying(false);
    const index = anim.cursor;
    if (anim.uses(index) > 0) {
      if (anim.removeIndex(index)) sfx.play('erase');
      return;
    }
    if (!app.addAnimFrame(index)) return;
    scene.pop();
    sfx.play('paint');
    if (!prefersReducedMotion()) popped = new Set([index]);
  }

  function rangeStep(): number {
    return Math.max(1, Math.round(rangeEvery) || 1);
  }

  /** Adds 1 frame every range step from `from`, up to `until` (exclusive, default the video end). Returns the count added. */
  async function addFrames(from: number, until?: number): Promise<number> {
    setPlaying(false);
    const before = anim.timeline.length;
    // The entries join before the first wait; their frames arrive after it.
    const done = app.addAnimRange(from, rangeStep(), until);
    if (anim.timeline.length === before) return 0;
    sfx.play('sweep');
    const added = await done;
    if (added.length === 0) return 0;
    if (!prefersReducedMotion()) popped = new Set(added.map((frame) => frame.index));
    app.toast(added.length === 1 ? t('frames.rangeAddedOne') : t('frames.rangeAdded', { count: added.length }), 'success');
    return added.length;
  }

  /** Removes every entry at or after the cursor in the video, so the loop ends on the frame before it. */
  async function closeLoopHere(): Promise<void> {
    setPlaying(false);
    const at = anim.cursor;
    const leaving = () => anim.timeline.filter((frame) => frame.index >= at);
    if (leaving().length === 0) return;
    if (leaving().some((frame) => anim.isEdited(frame.id))) {
      if (!(await app.confirm(t('frames.loopConfirmTitle'), t('frames.loopConfirmBody'), t('frames.loopConfirmOk')))) return;
    }
    const ids = new Set(leaving().map((frame) => frame.id));
    if (ids.size === 0) return;
    anim.removeMany(ids);
    const last = anim.timeline.at(-1);
    if (last) anim.select(last.id);
    sfx.play('erase');
    const count = ids.size;
    app.toast(count === 1 ? t('frames.loopClosedOne') : t('frames.loopClosed', { count }), 'success');
    track('anim_loop', { kind: 'close', count });
  }

  async function fillLoopToHere(): Promise<void> {
    const at = anim.cursor;
    const before = lastIndexBefore(at);
    if (before === null) return;
    const count = await addFrames(before + rangeStep(), at);
    if (count > 0) track('anim_loop', { kind: 'fill', count });
  }

  function findLoopEnd(): void {
    setPlaying(false);
    const { entries, frames } = boxedTimeline();
    let found: { position: number } | null = null;
    try {
      found = loopReturn(frames);
    } catch {
      found = null;
    }
    anim.setLoopCheck(true);
    const target = found ? entries[found.position] : undefined;
    if (!target) {
      app.toast(t('frames.loopNotFound'), 'info');
      track('anim_loop', { kind: 'find', detail: false });
      return;
    }
    anim.select(target.id);
    seekTo(target.index);
    scene.pop();
    sfx.play('sweep');
    loopFound = target.index;
    app.toast(t('frames.loopFound', { n: target.index + 1 }), 'success');
    track('anim_loop', { kind: 'find', detail: true });
  }

  /** Shows the last entry on the stage with the first entry as its ghost. */
  function compareSeam(): void {
    const last = anim.timeline.at(-1);
    if (!last) return;
    anim.setLoopCheck(true);
    anim.select(last.id);
    seekTo(last.index);
  }

  function removeLast(): void {
    const last = anim.timeline.at(-1);
    if (last) removeEntry(last.id);
  }

  function setReference(): void {
    if (anim.referenceIndex === anim.cursor) return;
    anim.setReference(anim.cursor);
    sfx.play('tick');
  }

  function selectEntry(id: number): void {
    anim.select(id);
    const frame = anim.selected;
    if (frame) seekTo(frame.index);
  }

  function removeEntry(id: number): void {
    anim.remove(id);
    sfx.play('erase');
  }

  function duplicateEntry(id: number): void {
    if (anim.duplicate(id)) sfx.play('paint');
  }

  function moveEntry(id: number, delta: -1 | 1): void {
    if (anim.move(id, delta)) sfx.play('tick');
  }

  function onStageDown(p: StagePointer): boolean | 'pan' {
    const part = scene.hit(p.sx, p.sy);
    const box = shownBox;
    const current = entry;
    if (part === null || !box || !current || containerMode === 'preview') return 'pan';
    setPlaying(false);
    anim.beginEdit();
    if (containerMode === 'resize') {
      drag = { kind: 'box', part, start: box, startIx: p.ix, startIy: p.iy, offset: current.offset, last: box };
    } else {
      drag = { kind: 'offset', id: current.id, start: current.offset, startIx: p.ix, startIy: p.iy, last: current.offset };
    }
    scene.setActive(part);
    cursor = cursorOf(part);
    return true;
  }

  function onStageMove(p: StagePointer): void {
    const current = drag;
    if (!current) return;
    const dx = Math.round(p.ix - current.startIx);
    const dy = Math.round(p.iy - current.startIy);
    if (current.kind === 'box') {
      const next = draggedTileBox(current.start, current.part, dx, dy);
      if (sameTileBox(next, current.last)) return;
      current.last = next;
      anim.setContainer({ col: next.col + current.offset.x, row: next.row + current.offset.y, cols: next.cols, rows: next.rows });
    } else {
      const next = { x: current.start.x - dx, y: current.start.y - dy };
      if (next.x === current.last.x && next.y === current.last.y) return;
      current.last = next;
      anim.setOffset(current.id, next);
    }
    scene.flash();
  }

  function onStageUp(p: StagePointer): void {
    const done = drag;
    drag = null;
    scene.setActive(null);
    onStageHover(p);
    if (!done || !anim.endEdit()) return;
    track('option_change', { kind: 'anim_container', detail: done.kind === 'box' ? 'resize' : 'move' });
    sfx.play('tick');
  }

  function onStageHover(p: StagePointer | null): void {
    if (drag) return;
    const part = p ? scene.hit(p.sx, p.sy) : null;
    scene.setHover(part);
    cursor = cursorOf(part);
  }

  /**
   * One step of the history of the animation. A list step of the Animation screen gets its own feedback; the frames
   * built from the lists (the loop preview) follow `anim.version`.
   */
  function replay(way: 'undo' | 'redo'): void {
    if (drag) return;
    const done = way === 'undo' ? anim.undo() : anim.redo();
    if (!done) return;
    if (done.kind !== 'lists') {
      sfx.play('tick');
      return;
    }
    sfx.play('undo');
    app.toast(historyToast(done.action, way), 'info');
  }

  function undo(): void {
    replay('undo');
  }

  function redo(): void {
    replay('redo');
  }

  function goToFirst(): void {
    const first = anim.first;
    if (first) selectEntry(first.id);
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  /** The arrows belong to this screen with any focus: a focused input, slider or select never gets them. */
  function onArrowKey(event: KeyboardEvent): void {
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (event.altKey) {
      const selected = anim.selectedId;
      if (selected === null) return;
      event.preventDefault();
      event.stopPropagation();
      moveEntry(selected, direction);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stepBy(direction, event.shiftKey);
  }

  /** Capture phase: the arrows and Space drive the frames before the stage pans with them. */
  function onKeyDown(event: KeyboardEvent): void {
    if (app.animExportOpen || app.confirmRequest || app.aboutOpen) return;
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey) {
      onArrowKey(event);
      return;
    }
    if (isEditable(event.target)) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.altKey) return;
      const letter = event.key.toLowerCase();
      if (letter === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (letter === 'y' || (letter === 'z' && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
      return;
    }
    const onButton = event.target instanceof HTMLButtonElement;
    const key = event.key;
    const selected = anim.selectedId;
    if (event.altKey) return;
    if (key === ',' || key === '.' || key === '<' || key === '>') {
      event.preventDefault();
      event.stopPropagation();
      stepBy(key === ',' || key === '<' ? -1 : 1, event.shiftKey);
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      seekTo(key === 'Home' ? 0 : lastIndex);
    } else if (key === ' ') {
      if (onButton) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) setPlaying(!playing);
    } else if (key === 'Enter') {
      if (onButton || event.repeat) return;
      event.preventDefault();
      toggleFrame();
    } else if (/^[1-9]$/.test(key)) {
      event.preventDefault();
      setStepSize(Number(key));
    } else if (key.toLowerCase() === 'o') {
      event.preventDefault();
      if (event.repeat) return;
      anim.setOnion(!anim.onion);
      sfx.play('tick');
    } else if (key.toLowerCase() === 'l') {
      event.preventDefault();
      if (!event.repeat) anim.setLoopCheck(!anim.loopCheck);
    } else if ((key === 'Delete' || key === 'Backspace') && selected !== null) {
      event.preventDefault();
      removeEntry(selected);
    } else if (key.toLowerCase() === 'd' && selected !== null) {
      event.preventDefault();
      if (!event.repeat) duplicateEntry(selected);
    } else if (key.toLowerCase() === 'e' && selected !== null) {
      event.preventDefault();
      if (!event.repeat) void app.editAnimFrame(selected);
    }
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<section class="frames-screen">
  <div class="frames-stage">
    <div class="stage-box">
      <Stage
        bind:this={stage}
        {scene}
        {insets}
        {cursor}
        label={t('anim.stageLabel')}
        onprimarydown={onStageDown}
        onprimarymove={onStageMove}
        onprimaryup={onStageUp}
        onhover={onStageHover}
      >
        <div class="stage-top" bind:offsetHeight={overlayTop}>
          <p class="frame-counter" aria-live="off">
            <span class="counter-main">{t('frames.counter', { n: anim.cursor + 1, total: anim.count })}</span>
            <span class="counter-time">{t('frames.time', { time: seconds })}</span>
            {#if playing}
              <span class="counter-playing"><Icon name="play" size={14} />{t('frames.playing')}</span>
            {/if}
            {#if !cursorReady}
              <span class="counter-cleaning"><span class="cleaning-dot" aria-hidden="true"></span>{t('frames.cleaning')}</span>
            {/if}
          </p>
          {#if anim.loopCheck && anim.first}
            <LoopMeter percent={loopMatch?.percent ?? null} level={loopMatch?.level ?? null} note={loopNote} action={loopAction} />
          {/if}
          {#if hasContainer}
            <div class="container-bar">
              <p class="container-hint">
                <Icon name={containerMode === 'preview' ? 'plus' : 'arrows'} size={16} />
                <span>{containerMode === 'resize' ? t('frames.containerResizeHint') : containerMode === 'move' ? t('frames.containerMoveHint') : t('frames.containerAddHint')}</span>
                {#if containerMode === 'move'}
                  <button type="button" class="btn btn-quiet container-first" onclick={goToFirst}>{t('frames.containerGoFirst')}</button>
                {/if}
              </p>
              <div class="container-history">
                <button type="button" class="icon-btn" aria-label={t('clean.undo')} title="{t('clean.undo')} (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!anim.canUndo} onclick={undo}>
                  <Icon name="undo" />
                </button>
                <button type="button" class="icon-btn" aria-label={t('clean.redo')} title="{t('clean.redo')} (Ctrl+Y)" aria-keyshortcuts="Control+Y Control+Shift+Z" disabled={!anim.canRedo} onclick={redo}>
                  <Icon name="redo" />
                </button>
              </div>
            </div>
          {/if}
        </div>
        <div class="stage-tools" bind:offsetHeight={overlayBottom}>
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
          <div class="stage-bg" role="group" aria-labelledby="frames-bg-label">
            <span class="bg-label" id="frames-bg-label">{t('clean.background')}</span>
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

    <div class="frames-timeline">
      <AnimTimeline
        frames={anim.timeline}
        thumbOf={(frame) => anim.editsOf(frame.id) ?? anim.displayFrame(frame.index)}
        version={anim.framesVersion + anim.storeVersion}
        pending={(frame) => anim.isPending(frame.index)}
        selectedId={anim.selectedId}
        referenceIndex={anim.referenceIndex}
        background={app.previewBg}
        onselect={selectEntry}
        onremove={removeEntry}
        onduplicate={duplicateEntry}
        onmove={moveEntry}
        onedit={(id) => void app.editAnimFrame(id)}
        edited={(frame) => anim.isEdited(frame.id)}
      />
    </div>
  </div>

  <aside class="frames-panel">
    <PanelSplitter />
    <div class="frames-panel-scroll">
      <header class="frames-head">
        <h1 class="frames-title">{t('frames.title')}</h1>
        {#if anim.info}
          <p class="video-chip" title="{anim.info.name}.{anim.info.format}">
            <Icon name="film" size={16} />
            <span class="video-name">{anim.info.name}.{anim.info.format}</span>
            <span class="video-meta">{t('frames.videoMeta', { w: anim.info.width, h: anim.info.height, fps: anim.info.fps, count: anim.count })}</span>
          </p>
          {#if !anim.info.exact}
            <p class="fps-guess" role="note"><Icon name="alert" size={16} />{t('frames.fpsGuessed', { fps: anim.info.fps })}</p>
          {/if}
        {/if}
      </header>

      <section class="frames-block" aria-labelledby="frames-monitor-label">
        <h2 class="section-title" id="frames-monitor-label">{t('frames.monitor')}</h2>
        <canvas
          bind:this={monitor}
          class="monitor"
          style:width="{TUNING.anim.monitorPx}px"
          style:aspect-ratio="{TUNING.anim.monitorPx} / {monitorH}"
          aria-hidden="true"
        ></canvas>
        <span class="visually-hidden">{t('frames.monitorLabel', { n: anim.cursor + 1 })}</span>
      </section>

      <section class="frames-block" aria-labelledby="frames-nav-label">
        <h2 class="visually-hidden" id="frames-nav-label">{t('frames.navigation')}</h2>
        <div class="transport">
          <button type="button" class="icon-btn" aria-label={t('anim.first')} title="{t('anim.first')} (Home)" disabled={anim.cursor === 0} onclick={() => seekTo(0)}>
            <Icon name="first" />
          </button>
          <button type="button" class="icon-btn" aria-label={t('anim.prev')} title={t('anim.prev')} disabled={anim.cursor === 0} use:holdRepeat={{ step: (shift) => stepBy(-1, shift) }}>
            <Icon name="stepBack" />
          </button>
          <button type="button" class="icon-btn play-btn" aria-label={playing ? t('anim.pause') : t('anim.play')} aria-pressed={playing} title="{playing ? t('anim.pause') : t('anim.play')} ({t('frames.keySpace')})" disabled={anim.count < 2} onclick={() => setPlaying(!playing)}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button type="button" class="icon-btn" aria-label={t('anim.next')} title={t('anim.next')} disabled={anim.cursor >= lastIndex} use:holdRepeat={{ step: (shift) => stepBy(1, shift) }}>
            <Icon name="stepForward" />
          </button>
          <button type="button" class="icon-btn" aria-label={t('anim.last')} title="{t('anim.last')} (End)" disabled={anim.cursor >= lastIndex} onclick={() => seekTo(lastIndex)}>
            <Icon name="last" />
          </button>
        </div>

        <div class="scrub">
          <input
            id="frames-scrub"
            name="frames-scrub"
            class="scrub-range"
            type="range"
            min="0"
            max={lastIndex}
            step="1"
            value={anim.cursor}
            aria-label={t('frames.scrub')}
            aria-valuetext={t('frames.counter', { n: anim.cursor + 1, total: anim.count })}
            oninput={(event) => seekTo(Number((event.currentTarget as HTMLInputElement).value))}
          />
          <span class="scrub-marks" aria-hidden="true">
            {#each marks as index (index)}
              <span class="scrub-mark" class:is-new={popped.has(index)} class:is-ref={index === anim.referenceIndex} class:is-first={anim.loopCheck && index === anim.first?.index} class:is-loop={index === loopFound} style:--at={lastIndex > 0 ? index / lastIndex : 0}></span>
            {/each}
          </span>
        </div>

        <div class="field">
          <label class="field-label" for="frames-step">{t('frames.stepSize')}</label>
          <div class="step-control" title={t('frames.stepWheel')} use:stepWheel>
            <button
              type="button"
              class="icon-btn small"
              aria-label={t('frames.stepDown')}
              title={t('frames.stepDown')}
              disabled={anim.stepSize <= 1}
              use:holdRepeat={{ step: (shift) => setStepSize(anim.stepSize - (shift ? TUNING.anim.stepWheelShift : 1)) }}
            >
              <span aria-hidden="true">−</span>
            </button>
            <input
              id="frames-step"
              name="frames-step"
              class="step-input"
              type="text"
              inputmode="numeric"
              role="spinbutton"
              autocomplete="off"
              aria-valuemin="1"
              aria-valuemax={anim.maxStep}
              aria-valuenow={anim.stepSize}
              aria-keyshortcuts="1 2 3 4 5 6 7 8 9"
              bind:value={stepDraft}
              onfocus={() => (stepFocused = true)}
              onblur={() => {
                stepFocused = false;
                commitStepDraft();
              }}
              onkeydown={onStepKey}
            />
            <button
              type="button"
              class="icon-btn small"
              aria-label={t('frames.stepUp')}
              title={t('frames.stepUp')}
              disabled={anim.stepSize >= anim.maxStep}
              use:holdRepeat={{ step: (shift) => setStepSize(anim.stepSize + (shift ? TUNING.anim.stepWheelShift : 1)) }}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
      </section>

      <section class="frames-block" aria-labelledby="frames-actions-label">
        <h2 class="visually-hidden" id="frames-actions-label">{t('frames.actions')}</h2>
        <button type="button" class="btn btn-big toggle-btn" class:btn-primary={uses === 0} aria-keyshortcuts="Enter" onclick={toggleFrame}>
          <Icon name={uses === 0 ? 'plus' : 'trash'} size={20} />
          {uses === 0 ? t('frames.add') : t('frames.remove')}
        </button>
        {#if uses > 1}
          <p class="hint uses">{t('frames.uses', { count: uses })}</p>
        {/if}

        <div class="range-row">
          <button type="button" class="btn range-btn" onclick={() => void addFrames(anim.cursor)}>
            <Icon name="sparkle" size={18} />
            {t('frames.addRange')}
          </button>
          <label class="range-every" for="frames-every">
            <span>{t('frames.every')}</span>
            <input id="frames-every" name="frames-every" class="every-input" type="number" min="1" max={Math.max(1, anim.count)} step="1" bind:value={rangeEvery} />
          </label>
        </div>
        <p class="hint">{t('frames.addRangeHint', { every: rangeStep() })}</p>

        <div class="ref-row">
          <button type="button" class="btn btn-quiet ref-btn" aria-pressed={isReference} onclick={setReference}>
            <Icon name="star" size={18} filled={isReference} />
            {isReference ? t('frames.isReference') : t('frames.useReference')}
          </button>
          <span class="ref-current">{t('frames.referenceIs', { n: anim.referenceIndex + 1 })}</span>
        </div>
        <p class="hint">{t('frames.referenceHint')}</p>

        <button type="button" class="btn btn-quiet calibrate-btn" disabled={app.loading} onclick={() => app.calibrateAt(anim.cursor)}>
          <Icon name="grid" size={18} />
          {t('frames.calibrate')}
        </button>
        <p class="hint">{t('frames.calibrateHint')}</p>

        <ToggleSwitch id="frames-onion" label={t('anim.onion')} hint={t('anim.onionHint')} checked={anim.onion} onchange={(on) => anim.setOnion(on)} />
      </section>

      <section class="frames-block" aria-labelledby="frames-loop-label">
        <h2 class="section-title" id="frames-loop-label">{t('frames.loopTitle')}</h2>
        <LoopPreview frames={anim.built.frames} version={anim.version} background={app.previewBg} label={t('anim.loopLabel')} />
        <p class="hint" class:is-near={nearLimit}>
          {anim.timeline.length === 0
            ? t('anim.timelineEmpty')
            : nearLimit
              ? t('frames.countOf', { count: budget.used, max: budget.max })
              : anim.timeline.length === 1
                ? t('frames.countOne')
                : t('frames.count', { count: anim.timeline.length })}
        </p>
        <LoopSeam
          frames={anim.built.frames}
          version={anim.version}
          waiting={anim.pendingCount > 0}
          background={app.previewBg}
          firstLabel={anim.first ? t('anim.frameNumber', { n: anim.first.index + 1 }) : ''}
          lastLabel={lastEntry ? t('anim.frameNumber', { n: lastEntry.index + 1 }) : ''}
          oncompare={compareSeam}
          onremovelast={removeLast}
          onfind={findLoopEnd}
        />
        <ToggleSwitch id="frames-loop-check" label={t('frames.loopCheck')} hint={t('frames.loopCheckHint')} checked={anim.loopCheck} onchange={(on) => anim.setLoopCheck(on)} />
      </section>

      <details class="frames-block keys">
        <summary class="keys-summary">{t('frames.keysTitle')}</summary>
        <dl class="key-list">
          <dt><span class="keycap-group"><kbd class="keycap">←</kbd><kbd class="keycap">→</kbd></span></dt>
          <dd><KeyText text={t('frames.keyStep')} /></dd>
          <dt><kbd class="keycap">{t('frames.keySpace')}</kbd></dt>
          <dd>{t('frames.keyPlay')}</dd>
          <dt><KeyText text="Enter" /></dt>
          <dd>{t('frames.keyToggle')}</dd>
          <dt><span class="keycap-group"><kbd class="keycap">1</kbd>–<kbd class="keycap">9</kbd></span></dt>
          <dd>{t('frames.stepSize')}</dd>
          <dt><kbd class="keycap">O</kbd></dt>
          <dd>{t('anim.onion')}</dd>
          <dt><kbd class="keycap">L</kbd></dt>
          <dd>{t('frames.loopCheck')}</dd>
          <dt><KeyText text="Delete" /></dt>
          <dd>{t('frames.keyRemove')}</dd>
          <dt><span class="keycap-group"><KeyText text="Alt" /><kbd class="keycap">←</kbd><kbd class="keycap">→</kbd></span></dt>
          <dd>{t('frames.keyMove')}</dd>
          <dt><kbd class="keycap">D</kbd></dt>
          <dd>{t('anim.duplicate')}</dd>
          <dt><kbd class="keycap">E</kbd></dt>
          <dd>{t('animEdit.open')}</dd>
          <dt><span class="keycap-group"><KeyText text="Ctrl" /><kbd class="keycap">Z</kbd></span></dt>
          <dd>{t('clean.undo')}</dd>
          <dt><span class="keycap-group"><KeyText text="Ctrl" /><kbd class="keycap">Y</kbd></span></dt>
          <dd><KeyText text={t('frames.keyRedo')} /></dd>
        </dl>
      </details>
    </div>

    <div class="frames-footer">
      <div class="frames-actions">
        <button type="button" class="btn btn-quiet" title={t('frames.back')} disabled={app.loading} onclick={() => app.goTo('anim-grid')}>
          <Icon name="back" size={18} />
          <span class="visually-hidden">{t('frames.back')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-big next-btn" disabled={app.loading || anim.timeline.length === 0} onclick={() => app.goTo('anim-align')}>
          <Icon name="arrows" size={20} />
          {t('frames.nextAlign')}
        </button>
      </div>
      {#if anim.timeline.length === 0}
        <p class="hint footer-hint">{t('frames.nextAlignEmpty')}</p>
      {/if}
    </div>
  </aside>
</section>

<style>
  @layer components {
    .frames-screen {
      --frames-panel-w: clamp(320px, 24vw, 380px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--panel-size, var(--frames-panel-w));
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .frames-stage {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .stage-box {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .frames-timeline {
      min-width: 0;
      border-top: 2px solid var(--line);
      background: var(--surface-sunken);
    }

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
    }

    .container-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      max-width: 100%;
    }

    .container-hint {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-2);
      min-width: 0;
      padding: var(--space-1) var(--space-3);
      font-size: 0.8125rem;
      line-height: 1.35;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);

      & :global(.icon) {
        flex: none;
        color: var(--primary);
      }
    }

    .container-first {
      min-height: 28px;
      padding: 0 var(--space-2);
      font-size: 0.8125rem;
      pointer-events: auto;
    }

    .container-history {
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      pointer-events: auto;
    }

    .frame-counter {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: var(--space-2) var(--space-3);
      padding: var(--space-1) var(--space-3);
      font-size: 0.875rem;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .counter-main {
      font: 700 0.9375rem/1.2 var(--font-display);
      font-variant-numeric: tabular-nums;
    }

    .counter-time {
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .counter-playing {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--teal);
      font-weight: 700;
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

    .frames-panel {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .frames-panel-scroll {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: var(--space-3);
      min-height: 0;
      padding-bottom: var(--space-3);
      overflow: hidden auto;
    }

    .frames-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
      padding: var(--space-3) var(--space-5) 0;
    }

    .frames-title {
      font-size: 0.9375rem;
    }

    .video-chip {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 2px var(--space-2);
      padding: var(--space-1) var(--space-2);
      font-size: 0.8125rem;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);

      & :global(.icon) {
        color: var(--teal);
      }
    }

    .video-name {
      min-width: 0;
      overflow: hidden;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .video-meta {
      grid-column: 2;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .fps-guess {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      font-size: 0.8125rem;
      line-height: 1.35;

      & :global(.icon) {
        color: var(--yellow);
      }
    }

    .frames-block {
      display: grid;
      gap: var(--space-2);
      padding: 0 var(--space-5);
    }

    .monitor {
      display: block;
      max-width: 100%;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
    }

    .transport {
      display: flex;
      justify-content: space-between;
      gap: 2px;
      padding: 3px;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .scrub {
      --thumb-w: 14px;
      position: relative;
      height: 32px;
    }

    .scrub-range {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      background: transparent;
      appearance: none;
      cursor: pointer;

      &::-webkit-slider-runnable-track {
        height: 8px;
        background: var(--surface-3);
        border: 1px solid var(--line-strong);
        border-radius: var(--radius-s);
      }

      &::-moz-range-track {
        height: 8px;
        background: var(--surface-3);
        border: 1px solid var(--line-strong);
        border-radius: var(--radius-s);
      }

      &::-webkit-slider-thumb {
        width: var(--thumb-w);
        height: 24px;
        margin-top: -9px;
        background: var(--primary);
        border: 2px solid var(--primary-depth);
        border-radius: 3px;
        appearance: none;
      }

      &::-moz-range-thumb {
        width: var(--thumb-w);
        height: 24px;
        background: var(--primary);
        border: 2px solid var(--primary-depth);
        border-radius: 3px;
        box-sizing: border-box;
      }

      &:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
        border-radius: var(--radius-s);
      }
    }

    /* The marks of the picked frames, on the thumb path, so a mark sits right under its frame. */
    .scrub-marks {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .scrub-mark {
      position: absolute;
      top: 2px;
      left: calc(var(--thumb-w) / 2 + (100% - var(--thumb-w)) * var(--at));
      width: 3px;
      height: 8px;
      background: var(--teal);
      border-radius: 1px;
      translate: -50% 0;

      &.is-ref {
        background: var(--yellow);
      }

      &.is-first {
        background: var(--stage-ghost-first);
      }

      &.is-loop {
        background: var(--primary);
        animation: mark-pop var(--dur-pop) var(--ease-spring);
      }

      &.is-new {
        animation: mark-pop var(--dur-pop) var(--ease-spring);
      }
    }

    .field-label {
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .step-control {
      display: flex;
      align-items: center;
      gap: 2px;
      width: max-content;
      padding: 3px;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);

      & .icon-btn.small {
        width: 30px;
        height: 30px;
        font: 700 1.125rem/1 var(--font-mono);
      }
    }

    .step-input {
      width: 5ch;
      min-height: 30px;
      padding: 0 var(--space-1);
      color: var(--text);
      font: 600 0.9375rem/1 var(--font-mono);
      font-variant-numeric: tabular-nums;
      text-align: center;
      background: var(--surface-sunken);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-s);

      &:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 1px;
      }
    }

    .counter-cleaning {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .cleaning-dot {
      width: 8px;
      height: 8px;
      background: var(--teal);
      border-radius: 50%;
      animation: cleaning-pulse 0.9s ease-in-out infinite alternate;
    }

    @keyframes cleaning-pulse {
      from {
        opacity: 0.25;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .cleaning-dot {
        animation: none;
      }
    }

    .is-near {
      color: var(--text);
      font-weight: 600;
    }

    .toggle-btn {
      width: 100%;
      min-width: 0;
    }

    .uses {
      text-align: center;
    }

    .range-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }

    .range-btn {
      min-width: 0;
      padding: var(--space-1) var(--space-3);
      font-size: 0.9375rem;
      line-height: 1.15;
      text-align: center;
      text-wrap: balance;
      white-space: normal;
    }

    .range-every {
      display: flex;
      flex: none;
      align-items: center;
      gap: var(--space-1);
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .every-input {
      width: 4.5ch;
      min-height: 36px;
      padding: 0 var(--space-1);
      color: var(--text);
      font: 600 0.9375rem/1 var(--font-mono);
      text-align: center;
      background: var(--surface-sunken);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-s);
      box-sizing: content-box;

      &:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 1px;
      }
    }

    .ref-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }

    .ref-btn {
      font-size: 0.9375rem;

      &[aria-pressed='true'] :global(.icon) {
        color: var(--yellow);
      }
    }

    .ref-current {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .calibrate-btn {
      justify-self: start;
      font-size: 0.9375rem;
    }

    .keys-summary {
      font: 600 0.9375rem/1.4 var(--font-display);
      color: var(--text-muted);
      cursor: pointer;
      border-radius: var(--radius-s);

      &:hover {
        color: var(--text);
      }
    }

    .key-list {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 6px var(--space-3);
      margin: var(--space-2) 0 0;
      font-size: 0.8125rem;

      & dt {
        justify-self: start;
      }

      & dd {
        margin: 0;
        color: var(--text-muted);
      }
    }

    .frames-footer {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-5) var(--space-4);
      background: var(--surface-sunken);
      border-top: 2px solid var(--line);
    }

    .frames-actions {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
    }

    .next-btn {
      width: 100%;
      min-width: 0;
      padding-inline: var(--space-3);
      font-size: 1.125rem;
    }

    .footer-hint {
      text-align: center;
    }

    @media (max-height: 760px) {
      .frames-head,
      .frames-block {
        padding-inline: var(--space-4);
      }

      .frames-footer {
        padding: var(--space-2) var(--space-4) var(--space-3);
      }

      .frames-footer :global(.btn-big) {
        min-height: 44px;
        font-size: 1.0625rem;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .scrub-mark.is-new,
      .scrub-mark.is-loop {
        animation: none;
      }
    }

    @keyframes mark-pop {
      0% {
        scale: 1 0.2;
      }
      60% {
        scale: 2.2 1.8;
      }
    }
  }
</style>
