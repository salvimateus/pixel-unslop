<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import { activeLocale } from '../app/locale.svelte.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import { AnimScene, type AnimSource } from './anim-scene.ts';
  import AnimTimeline from './AnimTimeline.svelte';
  import type { PreviewBackground } from './clean-scene.ts';
  import { holdRepeat } from './hold-repeat.ts';
  import Icon from './Icon.svelte';
  import KeyText from './KeyText.svelte';
  import LoopPreview from './LoopPreview.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import Stage from './Stage.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';

  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  const anim = app.anim;

  function sourceOf(): AnimSource {
    const first = anim.owns[0];
    return { count: anim.count, cols: first?.cols ?? 0, rows: first?.rows ?? 0, frameOf: (index) => anim.displayFrame(index) };
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

  const scene = new AnimScene(lastSource, videoFps());
  scene.onframe = (index) => anim.seek(index);
  /** The ghost is the nearest picked frame before the shown one. */
  scene.ghostOf = (index) => {
    let best: number | null = null;
    for (const frame of anim.timeline) if (frame.index < index && (best === null || frame.index > best)) best = frame.index;
    return best;
  };

  const lastIndex = $derived(Math.max(0, anim.count - 1));
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
    scene.onion = anim.onion;
    void anim.timeline;
    stage?.invalidate();
  });

  $effect(() => {
    rangeEvery = anim.stepSize;
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
    if (size === anim.stepSize) return;
    anim.setStepSize(size);
    sfx.play('tick');
  }

  function toggleFrame(): void {
    setPlaying(false);
    const index = anim.cursor;
    if (anim.uses(index) > 0) {
      if (anim.removeIndex(index)) sfx.play('erase');
      return;
    }
    if (!anim.add(index)) return;
    scene.pop();
    sfx.play('paint');
    if (!prefersReducedMotion()) popped = new Set([index]);
  }

  function addRange(): void {
    setPlaying(false);
    const every = Math.max(1, Math.round(rangeEvery) || 1);
    const added = anim.addRange(anim.cursor, every);
    if (added.length === 0) {
      app.toast(t('frames.rangeNone'), 'info');
      return;
    }
    sfx.play('sweep');
    if (!prefersReducedMotion()) popped = new Set(added.map((frame) => frame.index));
    app.toast(added.length === 1 ? t('frames.rangeAddedOne') : t('frames.rangeAdded', { count: added.length }), 'success');
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

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  /** Capture phase: the arrows and Space drive the frames before the stage pans with them. */
  function onKeyDown(event: KeyboardEvent): void {
    if (app.animExportOpen || app.confirmRequest || app.aboutOpen) return;
    if (event.ctrlKey || event.metaKey || isEditable(event.target)) return;
    const onButton = event.target instanceof HTMLButtonElement;
    const key = event.key;
    const selected = anim.selectedId;
    if (event.altKey) {
      if ((key === 'ArrowLeft' || key === 'ArrowRight') && selected !== null) {
        event.preventDefault();
        event.stopPropagation();
        moveEntry(selected, key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === ',' || key === '.' || key === '<' || key === '>') {
      event.preventDefault();
      event.stopPropagation();
      stepBy(key === 'ArrowLeft' || key === ',' || key === '<' ? -1 : 1, event.shiftKey);
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
    } else if (/^[1-4]$/.test(key)) {
      event.preventDefault();
      setStepSize(Number(key));
    } else if (key.toLowerCase() === 'o') {
      event.preventDefault();
      if (event.repeat) return;
      anim.setOnion(!anim.onion);
      sfx.play('tick');
    } else if ((key === 'Delete' || key === 'Backspace') && selected !== null) {
      event.preventDefault();
      removeEntry(selected);
    } else if (key.toLowerCase() === 'd' && selected !== null) {
      event.preventDefault();
      if (!event.repeat) duplicateEntry(selected);
    }
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<section class="frames-screen">
  <div class="frames-stage">
    <div class="stage-box">
      <Stage bind:this={stage} {scene} {insets} label={t('anim.stageLabel')} onprimarydown={() => 'pan'}>
        <div class="stage-top" bind:offsetHeight={overlayTop}>
          <p class="frame-counter" aria-live="off">
            <span class="counter-main">{t('frames.counter', { n: anim.cursor + 1, total: anim.count })}</span>
            <span class="counter-time">{t('frames.time', { time: seconds })}</span>
            {#if playing}
              <span class="counter-playing"><Icon name="play" size={14} />{t('frames.playing')}</span>
            {/if}
          </p>
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
        thumbOf={(frame) => anim.displayFrame(frame.index)}
        version={anim.framesVersion}
        selectedId={anim.selectedId}
        referenceIndex={anim.referenceIndex}
        background={app.previewBg}
        onselect={selectEntry}
        onremove={removeEntry}
        onduplicate={duplicateEntry}
        onmove={moveEntry}
      />
    </div>
  </div>

  <aside class="frames-panel">
    <div class="frames-panel-scroll">
      <header class="frames-head">
        <h1 class="frames-title">{t('frames.title')}</h1>
        {#if anim.info}
          <p class="video-chip" title={anim.info.name}>
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
              <span class="scrub-mark" class:is-new={popped.has(index)} class:is-ref={index === anim.referenceIndex} style:--at={lastIndex > 0 ? index / lastIndex : 0}></span>
            {/each}
          </span>
        </div>

        <div class="field">
          <span class="field-label" id="frames-step-label">{t('frames.stepSize')}</span>
          <div class="segmented" role="group" aria-labelledby="frames-step-label">
            {#each TUNING.anim.stepSizes as size (size)}
              <button type="button" aria-pressed={anim.stepSize === size} aria-keyshortcuts={String(size)} onclick={() => setStepSize(size)}>{size}</button>
            {/each}
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
          <button type="button" class="btn range-btn" onclick={addRange}>
            <Icon name="sparkle" size={18} />
            {t('frames.addRange')}
          </button>
          <label class="range-every" for="frames-every">
            <span>{t('frames.every')}</span>
            <input id="frames-every" name="frames-every" class="every-input" type="number" min="1" max={Math.max(1, anim.count)} step="1" bind:value={rangeEvery} />
          </label>
        </div>
        <p class="hint">{t('frames.addRangeHint', { every: Math.max(1, Math.round(rangeEvery) || 1) })}</p>

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
        <LoopPreview frames={anim.built.frames} version={anim.version} fps={anim.fps} background={app.previewBg} label={t('anim.loopLabel')} />
        <p class="hint">{anim.timeline.length === 0 ? t('anim.timelineEmpty') : anim.timeline.length === 1 ? t('frames.countOne') : t('frames.count', { count: anim.timeline.length })}</p>
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
          <dt><span class="keycap-group"><kbd class="keycap">1</kbd>–<kbd class="keycap">4</kbd></span></dt>
          <dd>{t('frames.stepSize')}</dd>
          <dt><kbd class="keycap">O</kbd></dt>
          <dd>{t('anim.onion')}</dd>
          <dt><KeyText text="Delete" /></dt>
          <dd>{t('frames.keyRemove')}</dd>
          <dt><span class="keycap-group"><KeyText text="Alt" /><kbd class="keycap">←</kbd><kbd class="keycap">→</kbd></span></dt>
          <dd>{t('frames.keyMove')}</dd>
          <dt><kbd class="keycap">D</kbd></dt>
          <dd>{t('anim.duplicate')}</dd>
        </dl>
      </details>
    </div>

    <div class="frames-footer">
      <div class="frames-actions">
        <button type="button" class="btn btn-quiet" title={t('frames.back')} disabled={app.loading} onclick={() => app.goTo('anim-grid')}>
          <Icon name="back" size={18} />
          <span class="visually-hidden">{t('frames.back')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-big next-btn" disabled={app.loading || anim.timeline.length === 0} onclick={() => app.goTo('anim')}>
          <Icon name="film" size={20} />
          {t('frames.next')}
        </button>
      </div>
      {#if anim.timeline.length === 0}
        <p class="hint footer-hint">{t('frames.nextEmpty')}</p>
      {/if}
    </div>
  </aside>
</section>

<style>
  @layer components {
    .frames-screen {
      --frames-panel-w: clamp(320px, 24vw, 380px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--frames-panel-w);
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
      justify-content: center;
      pointer-events: none;
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
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .frames-panel-scroll {
      display: grid;
      align-content: start;
      gap: var(--space-3);
      min-height: 0;
      padding-bottom: var(--space-3);
      overflow: hidden auto;
    }

    .frames-head {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-5) 0;
    }

    .frames-title {
      font-size: 0.9375rem;
    }

    .video-chip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px var(--space-2);
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

      &.is-new {
        animation: mark-pop var(--dur-pop) var(--ease-spring);
      }
    }

    .field-label {
      color: var(--text-muted);
      font-size: 0.8125rem;
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
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
      .scrub-mark.is-new {
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
