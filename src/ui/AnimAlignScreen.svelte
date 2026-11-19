<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { AnimFrame } from '../app/animation.svelte.ts';
  import { track } from '../app/analytics.ts';
  import { app } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { readStored, writeStored } from '../app/storage.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { FrameOffset } from '../core/frames.ts';
  import { opaqueBox } from '../core/sprite.ts';
  import { AlignScene, type AlignLayers, type GhostKind } from './align-scene.ts';
  import AnimTimeline from './AnimTimeline.svelte';
  import type { PreviewBackground } from './clean-scene.ts';
  import Icon from './Icon.svelte';
  import KeyText from './KeyText.svelte';
  import LoopPreview from './LoopPreview.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import Stage from './Stage.svelte';
  import type { StagePointer } from './stage-renderer.ts';

  type GhostMode = GhostKind;

  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  const GHOSTS: ReadonlyArray<{ id: GhostMode; label: TextKey }> = [
    { id: 'previous', label: 'align.ghostPrevious' },
    { id: 'first', label: 'align.ghostFirst' },
  ];

  const anim = app.anim;

  untrack(() => {
    if (!anim.selected && anim.timeline.length > 0) anim.select(anim.timeline[0].id);
  });

  let stage: Stage | undefined = $state();
  /** The overlay bands of the stage, measured, so the fit keeps the frame clear of them (12 px = their offset from the edge). */
  let overlayTop = $state(0);
  let overlayBottom = $state(0);
  const insets = $derived({ top: overlayTop > 0 ? overlayTop + 12 : 0, right: 0, bottom: overlayBottom > 0 ? overlayBottom + 12 : 0, left: 0 });
  let guides = $state(readStored('animGuides') !== 'off');
  let ghostMode = $state<GhostMode>('previous');

  /** The drag of the content: the pointer start in tiles and the offset at that time. */
  let drag: { id: number; x: number; y: number; offset: FrameOffset } | null = null;
  let dragging = $state(false);
  /** The content size changed during a drag: the stage syncs at the drag end. */
  let syncPending = false;
  /** The entries that this visit changed, for one usage event on leave. */
  const edited = new Set<number>();
  let lastTick = 0;
  let wasAligned = false;

  const count = $derived(anim.timeline.length);
  const position = $derived(Math.max(0, anim.timeline.findIndex((frame) => frame.id === anim.selectedId)));
  const entry = $derived<AnimFrame | null>(anim.timeline[position] ?? null);
  const offset = $derived(entry?.offset ?? { x: 0, y: 0 });

  function ghostPosition(at: number, mode: GhostMode): number | null {
    const total = anim.timeline.length;
    if (total < 2) return null;
    const ghost = mode === 'first' ? 0 : (at - 1 + total) % total;
    return ghost === at ? null : ghost;
  }

  function layersAt(at: number, mode: GhostMode): AlignLayers {
    const pad = TUNING.anim.alignPadTiles;
    const current = anim.paddedFrame(at, pad);
    const ghostAt = ghostPosition(at, mode);
    const ghost = ghostAt === null ? null : anim.paddedFrame(ghostAt, pad);
    const inner = current?.inner ?? { col: 0, row: 0, cols: anim.built.cell.cols, rows: anim.built.cell.rows };
    return { current: current?.sprite ?? null, ghost: ghost?.sprite ?? null, ghostKind: mode, inner };
  }

  const scene = untrack(() => new AlignScene(layersAt(position, ghostMode)));

  function refreshScene(at: number, mode: GhostMode): void {
    if (!scene.setLayers(layersAt(at, mode))) return;
    if (drag) syncPending = true;
    else stage?.syncContent();
  }

  $effect(() => {
    void anim.version;
    const at = position;
    const mode = ghostMode;
    untrack(() => refreshScene(at, mode));
  });

  $effect(() => {
    scene.background = app.previewBg;
    scene.guides = guides;
    scene.invalidate();
  });

  /** A new entry on the stage: its alignment state is the start, with no flash. */
  $effect(() => {
    void position;
    untrack(() => {
      wasAligned = isAligned();
    });
  });

  onDestroy(() => {
    endDrag();
    if (edited.size > 0) track('option_change', { kind: 'anim_align', count: edited.size });
  });

  /** The opaque drawing of the frame is centered on the cell, within half a tile. */
  function isAligned(): boolean {
    const sprite = anim.built.frames[position];
    if (!sprite) return false;
    const box = opaqueBox(sprite);
    if (!box) return false;
    return Math.abs(box.col + box.cols / 2 - anim.built.cell.cols / 2) <= 0.5;
  }

  function afterMove(): void {
    const aligned = isAligned();
    if (aligned && !wasAligned) scene.flashAxis();
    wasAligned = aligned;
  }

  function tickSound(): void {
    const now = performance.now();
    if (now - lastTick < TUNING.anim.nudgeTickMs) return;
    lastTick = now;
    sfx.play('tick');
  }

  /** One undo step that sets the offset of the current entry. */
  function applyOffset(next: FrameOffset): boolean {
    const frame = entry;
    if (!frame || drag) return false;
    anim.beginEdit();
    anim.setOffset(frame.id, next);
    if (!anim.endEdit()) return false;
    edited.add(frame.id);
    afterMove();
    return true;
  }

  function nudge(dx: number, dy: number): void {
    const frame = entry;
    if (frame && applyOffset({ x: frame.offset.x + dx, y: frame.offset.y + dy })) tickSound();
  }

  function copyPrevious(): void {
    const before = anim.timeline[position - 1];
    if (before && applyOffset(before.offset)) sfx.play('paint');
  }

  function resetOffset(): void {
    if (applyOffset({ x: 0, y: 0 })) sfx.play('erase');
  }

  function undo(): void {
    if (drag || !anim.undo()) return;
    sfx.play('undo');
    wasAligned = isAligned();
  }

  function redo(): void {
    if (drag || !anim.redo()) return;
    sfx.play('undo');
    wasAligned = isAligned();
  }

  function onPrimaryDown(p: StagePointer): boolean {
    const frame = entry;
    if (!frame || drag) return false;
    anim.beginEdit();
    drag = { id: frame.id, x: p.ix, y: p.iy, offset: frame.offset };
    dragging = true;
    return true;
  }

  function onPrimaryMove(p: StagePointer): void {
    if (!drag) return;
    const next = { x: drag.offset.x + Math.round(p.ix - drag.x), y: drag.offset.y + Math.round(p.iy - drag.y) };
    const now = anim.find(drag.id)?.offset;
    if (!now || (now.x === next.x && now.y === next.y)) return;
    anim.setOffset(drag.id, next);
    tickSound();
    afterMove();
  }

  function endDrag(): void {
    if (!drag) return;
    const id = drag.id;
    drag = null;
    dragging = false;
    if (anim.endEdit()) edited.add(id);
    if (syncPending) {
      syncPending = false;
      stage?.syncContent();
    }
  }

  function toggleGuides(): void {
    guides = !guides;
    writeStored('animGuides', guides ? 'on' : 'off');
    sfx.play('tick');
  }

  function chooseGhost(mode: GhostMode): void {
    if (mode === ghostMode) return;
    ghostMode = mode;
    sfx.play('tick');
  }

  function goTo(at: number): void {
    const list = anim.timeline;
    if (list.length === 0) return;
    const next = Math.min(list.length - 1, Math.max(0, at));
    if (next === position) return;
    endDrag();
    anim.select(list[next].id);
    sfx.play('tick');
  }

  function onSelect(id: number): void {
    if (id === anim.selectedId) return;
    endDrag();
    anim.select(id);
    sfx.play('tick');
  }

  function onRemove(id: number): void {
    endDrag();
    anim.remove(id);
    sfx.play('erase');
    // The screen needs a timeline: an empty one goes back to the frame pick.
    if (anim.timeline.length === 0) void app.goTo('anim-frames');
  }

  function onDuplicate(id: number): void {
    endDrag();
    if (anim.duplicate(id)) sfx.play('tick');
  }

  function onMove(id: number, delta: -1 | 1): void {
    endDrag();
    if (anim.move(id, delta)) sfx.play('tick');
  }

  function formatTiles(value: number): string {
    return value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0';
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function stopKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  const NUDGES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  /** Capture phase: the arrows nudge the frame before the stage pans with them. */
  function onKeyDown(event: KeyboardEvent): void {
    if (app.animExportOpen || app.confirmRequest || app.aboutOpen) return;
    if (isEditable(event.target)) return;
    const key = event.key;
    if (event.ctrlKey || event.metaKey) {
      if (event.altKey) return;
      const lower = key.toLowerCase();
      if (lower === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (lower === 'y') {
        event.preventDefault();
        redo();
      }
      return;
    }
    const selected = anim.selectedId;
    if (event.altKey) {
      // Alt+arrow is also the history navigation of a browser: it never leaves the screen.
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        stopKey(event);
        if (selected !== null) onMove(selected, key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }
    const nudgeBy = NUDGES[key];
    if (nudgeBy) {
      stopKey(event);
      const step = event.shiftKey ? TUNING.anim.nudgeShift : 1;
      nudge(nudgeBy[0] * step, nudgeBy[1] * step);
    } else if (key === ','|| key === '<' || key === 'PageUp') {
      event.preventDefault();
      goTo(position - 1);
    } else if (key === '.' || key === '>' || key === 'PageDown') {
      event.preventDefault();
      goTo(position + 1);
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      goTo(key === 'Home' ? 0 : count - 1);
    } else if (key.toLowerCase() === 'g') {
      event.preventDefault();
      if (!event.repeat) toggleGuides();
    } else if ((key === 'Delete' || key === 'Backspace') && selected !== null) {
      event.preventDefault();
      if (!event.repeat) onRemove(selected);
    } else if (key.toLowerCase() === 'd' && selected !== null) {
      event.preventDefault();
      if (!event.repeat) onDuplicate(selected);
    }
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} onblur={endDrag} />

<section class="align-screen">
  <div class="align-main">
    <div class="align-stage">
      <Stage
        bind:this={stage}
        {scene}
        {insets}
        label={t('align.stageLabel')}
        cursor={dragging ? 'grabbing' : 'grab'}
        onprimarydown={onPrimaryDown}
        onprimarymove={onPrimaryMove}
        onprimaryup={endDrag}
      >
        <div class="stage-top" bind:offsetHeight={overlayTop}>
          <div class="stage-start">
            <div class="stage-group">
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
            <div class="stage-group">
              <button type="button" class="icon-btn" aria-label={t('clean.undo')} title="{t('clean.undo')} (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!anim.canUndo} onclick={undo}>
                <Icon name="undo" />
              </button>
              <button type="button" class="icon-btn" aria-label={t('clean.redo')} title="{t('clean.redo')} (Ctrl+Y)" aria-keyshortcuts="Control+Y" disabled={!anim.canRedo} onclick={redo}>
                <Icon name="redo" />
              </button>
            </div>
          </div>
          <div class="stage-end">
            <button type="button" class="tool-btn" aria-pressed={guides} aria-keyshortcuts="G" title="{t('align.guidesHint')} (G)" onclick={toggleGuides}>
              <Icon name="grid" size={18} />
              {t('align.guides')}
            </button>
            <div class="stage-bg" role="group" aria-labelledby="align-bg-label">
              <span class="bg-label" id="align-bg-label">{t('clean.background')}</span>
              <div class="segmented bg-choice">
                {#each BACKGROUNDS as bg (bg.id)}
                  <button type="button" aria-pressed={app.previewBg === bg.id} onclick={() => app.setPreviewBackground(bg.id)}>{t(bg.label)}</button>
                {/each}
              </div>
            </div>
          </div>
        </div>

        <div class="transport" role="group" aria-label={t('align.navigation')} bind:offsetHeight={overlayBottom}>
          <button type="button" class="icon-btn" aria-label={t('anim.first')} title="{t('anim.first')} (Home)" aria-keyshortcuts="Home" disabled={position === 0} onclick={() => goTo(0)}>
            <Icon name="first" size={18} />
          </button>
          <button type="button" class="icon-btn" aria-label={t('anim.prev')} title="{t('anim.prev')} (,)" aria-keyshortcuts="," disabled={position === 0} onclick={() => goTo(position - 1)}>
            <Icon name="stepBack" size={18} />
          </button>
          <span class="counter" aria-live="polite">{position + 1} / {count}</span>
          <button type="button" class="icon-btn" aria-label={t('anim.next')} title="{t('anim.next')} (.)" aria-keyshortcuts="." disabled={position >= count - 1} onclick={() => goTo(position + 1)}>
            <Icon name="stepForward" size={18} />
          </button>
          <button type="button" class="icon-btn" aria-label={t('anim.last')} title="{t('anim.last')} (End)" aria-keyshortcuts="End" disabled={position >= count - 1} onclick={() => goTo(count - 1)}>
            <Icon name="last" size={18} />
          </button>
        </div>
      </Stage>
      <ProgressPill />
    </div>

    <div class="align-timeline">
      <AnimTimeline
        frames={anim.timeline}
        thumbOf={(_frame: AnimFrame, at: number) => anim.built.frames[at] ?? null}
        version={anim.version}
        selectedId={anim.selectedId}
        current={position}
        background={app.previewBg}
        onselect={onSelect}
        onremove={onRemove}
        onduplicate={onDuplicate}
        onmove={onMove}
      />
    </div>
  </div>

  <aside class="align-panel">
    <div class="align-panel-scroll">
      <header class="align-head">
        <h1 class="align-title">{t('align.title')}</h1>
        <p class="hint">{t('align.intro')}</p>
        {#if anim.cell !== 'box'}
          <p class="hint">{t('align.noContainer')}</p>
        {/if}
      </header>

      <section class="align-section" aria-labelledby="align-frame-title">
        <h2 class="section-title" id="align-frame-title">{t('align.frame', { n: position + 1, total: count })}</h2>
        <p class="offset" aria-live="polite">
          <span class="visually-hidden">{t('align.offsetLabel')}</span>
          {t('align.offset', { x: formatTiles(offset.x), y: formatTiles(offset.y) })}
        </p>
        <div class="offset-actions">
          <button type="button" class="btn btn-quiet" title={t('align.copyPreviousHint')} disabled={position === 0} onclick={copyPrevious}>
            <Icon name="copy" size={18} />
            {t('align.copyPrevious')}
          </button>
          <button type="button" class="btn btn-quiet" title={t('align.resetHint')} disabled={offset.x === 0 && offset.y === 0} onclick={resetOffset}>
            <Icon name="undo" size={18} />
            {t('align.reset')}
          </button>
        </div>
      </section>

      <section class="align-section" aria-labelledby="align-ghost-title">
        <h2 class="section-title" id="align-ghost-title">{t('align.ghost')}</h2>
        <div class="segmented" role="group" aria-labelledby="align-ghost-title">
          {#each GHOSTS as ghost (ghost.id)}
            <button type="button" aria-pressed={ghostMode === ghost.id} onclick={() => chooseGhost(ghost.id)}>{t(ghost.label)}</button>
          {/each}
        </div>
        <p class="hint">{t('align.ghostHint')}</p>
      </section>

      <section class="align-section" aria-labelledby="align-loop-title">
        <h2 class="section-title" id="align-loop-title">{t('align.loopTitle')}</h2>
        <LoopPreview frames={anim.built.frames} version={anim.version} fps={anim.fps} background={app.previewBg} label={t('anim.loopLabel')} />
      </section>

      <details class="align-section keys">
        <summary class="keys-summary">{t('align.keysTitle')}</summary>
        <dl class="key-list">
          <dt><span class="keycap-group"><kbd class="keycap">←</kbd><kbd class="keycap">↑</kbd><kbd class="keycap">→</kbd><kbd class="keycap">↓</kbd></span></dt>
          <dd>{t('align.keyNudge')}</dd>
          <dt><span class="keycap-group"><KeyText text="Shift" /><kbd class="keycap">←</kbd></span></dt>
          <dd>{t('align.keyNudgeBig', { n: TUNING.anim.nudgeShift })}</dd>
          <dt><span class="keycap-group"><kbd class="keycap">,</kbd><kbd class="keycap">.</kbd></span></dt>
          <dd>{t('align.keyStep')}</dd>
          <dt><span class="keycap-group"><kbd class="keycap">Home</kbd><kbd class="keycap">End</kbd></span></dt>
          <dd>{t('align.keyEnds')}</dd>
          <dt><kbd class="keycap">G</kbd></dt>
          <dd>{t('align.guides')}</dd>
          <dt><span class="keycap-group"><KeyText text="Ctrl" /><kbd class="keycap">Z</kbd></span></dt>
          <dd>{t('clean.undo')}</dd>
          <dt><span class="keycap-group"><KeyText text="Ctrl" /><kbd class="keycap">Y</kbd></span></dt>
          <dd>{t('clean.redo')}</dd>
          <dt><KeyText text="Delete" /></dt>
          <dd>{t('align.keyRemove')}</dd>
          <dt><span class="keycap-group"><KeyText text="Alt" /><kbd class="keycap">←</kbd><kbd class="keycap">→</kbd></span></dt>
          <dd>{t('align.keyMove')}</dd>
          <dt><kbd class="keycap">D</kbd></dt>
          <dd>{t('anim.duplicate')}</dd>
        </dl>
      </details>
    </div>

    <div class="align-footer">
      <div class="align-actions">
        <button type="button" class="btn btn-quiet" title={t('align.back')} disabled={app.loading} onclick={() => app.goTo('anim-frames')}>
          <Icon name="back" size={18} />
          <span class="visually-hidden">{t('align.back')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-big next-btn" disabled={app.loading} onclick={() => app.goTo('anim')}>
          <Icon name="film" size={20} />
          {t('align.next')}
        </button>
      </div>
    </div>
  </aside>
</section>

<style>
  @layer components {
    .align-screen {
      --align-panel-w: clamp(320px, 24vw, 380px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--align-panel-w);
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .align-main {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .align-stage {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .align-timeline {
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

    .stage-start,
    .stage-end {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .stage-end {
      justify-content: flex-end;
    }

    .stage-group {
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

    .transport {
      position: absolute;
      left: 50%;
      bottom: var(--space-3);
      translate: -50% 0;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px var(--space-2);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);

      & .icon-btn {
        width: 36px;
        height: 36px;
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

    .align-panel {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .align-panel-scroll {
      display: grid;
      align-content: start;
      gap: var(--space-4);
      min-height: 0;
      padding: var(--space-3) var(--space-5) var(--space-4);
      overflow: hidden auto;
    }

    .align-head {
      display: grid;
      gap: var(--space-2);
    }

    .align-title {
      font-size: 0.9375rem;
    }

    .align-section {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }

    .offset {
      color: var(--text);
      font: 600 1.125rem/1.2 var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    /* Each button takes the width of its label; a narrow panel puts them on two rows. */
    .offset-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);

      & .btn {
        flex: 1 1 auto;
        min-height: 36px;
        padding-inline: var(--space-2);
        font-size: 0.875rem;
      }
    }

    .keys-summary {
      color: var(--text);
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
    }

    .key-list {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-1) var(--space-3);
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.35;

      & dt {
        color: var(--text);
        font-weight: 700;
        white-space: nowrap;
      }

      & dd {
        margin: 0;
        color: var(--text-muted);
      }
    }

    .align-footer {
      padding: var(--space-3) var(--space-5) var(--space-4);
      background: var(--surface-sunken);
      border-top: 2px solid var(--line);
    }

    .align-actions {
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

    @media (max-height: 760px) {
      .keys {
        display: none;
      }

      .align-panel-scroll {
        gap: var(--space-3);
        padding-inline: var(--space-4);
      }

      .align-footer {
        padding: var(--space-2) var(--space-4) var(--space-3);
      }
    }
  }
</style>
