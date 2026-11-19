<script lang="ts">
  import { untrack } from 'svelte';
  import type { Sprite } from '../core/types.ts';
  import type { AnimFrame } from '../app/animation.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { prefersReducedMotion } from '../app/state.svelte.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { PreviewBackground } from './clean-scene.ts';
  import Icon from './Icon.svelte';

  interface Props {
    frames: readonly AnimFrame[];
    thumbOf: (frame: AnimFrame, position: number) => Sprite | null;
    /** A change draws the thumbnails again. */
    version: number;
    selectedId: number | null;
    /** The position that plays now. */
    current?: number | null;
    /** The entries of this video frame get a star. */
    referenceIndex?: number | null;
    background: PreviewBackground;
    onselect: (id: number) => void;
    onremove: (id: number) => void;
    onduplicate: (id: number) => void;
    onmove: (id: number, delta: -1 | 1) => void;
    /** Opens the frame editor on an entry: the pencil button, a double click and the key E. */
    onedit: (id: number) => void;
    /** The entry has pixel edits: its thumbnail gets a pencil badge. */
    edited: (frame: AnimFrame) => boolean;
  }

  let { frames, thumbOf, version, selectedId, current = null, referenceIndex = null, background, onselect, onremove, onduplicate, onmove, onedit, edited }: Props = $props();

  let strip: HTMLOListElement | undefined = $state();
  /** The entries that arrived after the strip opened: they pop in once. */
  let fresh = $state.raw<ReadonlySet<number>>(new Set());
  let known: Set<number> | null = null;

  const selectedAt = $derived(frames.findIndex((frame) => frame.id === selectedId));

  $effect(() => {
    const ids = frames.map((frame) => frame.id);
    untrack(() => {
      if (known && !prefersReducedMotion()) {
        const added = ids.filter((id) => !known?.has(id));
        if (added.length > 0) fresh = new Set(added);
      }
      known = new Set(ids);
    });
  });

  /** Keeps the selected entry in view with a plain scroll of the strip: `scrollIntoView` would also move the clipped layout boxes. */
  $effect(() => {
    const at = selectedAt;
    const list = strip;
    if (!list || at < 0) return;
    const item = list.children[at] as HTMLElement | undefined;
    if (!item) return;
    const left = item.offsetLeft - list.offsetLeft;
    const right = left + item.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left - 8;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 8;
  });

  /** Draws a sprite at one canvas pixel per tile; CSS scales it with pixelated rendering. */
  function thumb(canvas: HTMLCanvasElement, input: { sprite: Sprite | null; version: number }) {
    let drawn: Sprite | null = null;
    const draw = (next: { sprite: Sprite | null; version: number }): void => {
      if (next.sprite === drawn) return;
      drawn = next.sprite;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      if (!next.sprite) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      canvas.width = next.sprite.cols;
      canvas.height = next.sprite.rows;
      const image = ctx.createImageData(next.sprite.cols, next.sprite.rows);
      new Uint32Array(image.data.buffer).set(next.sprite.pixels);
      ctx.putImageData(image, 0, 0);
    };
    draw(input);
    return { update: draw };
  }

  function wheel(event: WheelEvent): void {
    if (!strip || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  }
</script>

<section class="timeline" aria-labelledby="timeline-title" style:--thumb-px="{TUNING.anim.timelineThumbPx}px">
  <header class="timeline-head">
    <h2 class="section-title" id="timeline-title">{t('anim.timeline')} <span class="timeline-count">{frames.length}</span></h2>
    {#if selectedAt >= 0 && selectedId !== null}
      {@const id = selectedId}
      <div class="timeline-actions" role="group" aria-label={t('anim.frameNumber', { n: selectedAt + 1 })}>
        <button type="button" class="icon-btn" aria-label={t('anim.moveLeft')} title="{t('anim.moveLeft')} (Alt+←)" disabled={selectedAt === 0} onclick={() => onmove(id, -1)}>
          <Icon name="arrowLeft" size={18} />
        </button>
        <button type="button" class="icon-btn" aria-label={t('anim.moveRight')} title="{t('anim.moveRight')} (Alt+→)" disabled={selectedAt === frames.length - 1} onclick={() => onmove(id, 1)}>
          <Icon name="arrowRight" size={18} />
        </button>
        <button type="button" class="icon-btn" aria-label={t('animEdit.open')} title="{t('animEdit.open')} (E)" aria-keyshortcuts="E" onclick={() => onedit(id)}>
          <Icon name="pencil" size={18} />
        </button>
        <button type="button" class="icon-btn" aria-label={t('anim.duplicate')} title="{t('anim.duplicate')} (D)" onclick={() => onduplicate(id)}>
          <Icon name="copy" size={18} />
        </button>
        <button type="button" class="icon-btn is-danger" aria-label={t('anim.remove')} title="{t('anim.remove')} (Delete)" onclick={() => onremove(id)}>
          <Icon name="trash" size={18} />
        </button>
      </div>
    {/if}
  </header>

  {#if frames.length === 0}
    <p class="timeline-empty">{t('anim.timelineEmpty')}</p>
  {:else}
    <ol class="timeline-strip" bind:this={strip} onwheel={wheel}>
      {#each frames as frame, position (frame.id)}
        <li class="timeline-item" class:is-fresh={fresh.has(frame.id)}>
          <button
            type="button"
            class="timeline-frame bg-{background}"
            class:is-selected={frame.id === selectedId}
            class:is-current={position === current}
            aria-pressed={frame.id === selectedId}
            aria-label="{position + 1}: {t('anim.frameNumber', { n: frame.index + 1 })}{edited(frame) ? ` · ${t('animEdit.edited')}` : ''}"
            title={t('animEdit.dblclick')}
            onclick={() => onselect(frame.id)}
            ondblclick={() => onedit(frame.id)}
          >
            <canvas class="timeline-canvas" use:thumb={{ sprite: thumbOf(frame, position), version }}></canvas>
            <span class="timeline-position">{position + 1}</span>
            {#if referenceIndex !== null && frame.index === referenceIndex}
              <span class="timeline-star" title={t('anim.reference')}><Icon name="star" size={12} filled /></span>
            {/if}
            {#if edited(frame)}
              <span class="timeline-edited" title={t('animEdit.edited')}><Icon name="pencil" size={12} /></span>
            {/if}
          </button>
          <span class="timeline-index">#{frame.index + 1}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  @layer components {
    .timeline {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: var(--space-1);
      min-width: 0;
      padding: var(--space-2) var(--space-3) var(--space-2);
      background: var(--surface-1);
      border-top: 2px solid var(--line);
    }

    .timeline-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      min-height: 32px;
    }

    .timeline-count {
      margin-left: var(--space-1);
      padding: 0 var(--space-2);
      color: var(--text-muted);
      background: var(--surface-sunken);
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }

    .timeline-actions {
      display: flex;
      gap: 2px;

      & .icon-btn {
        width: 32px;
        height: 32px;
      }

      & .is-danger:hover:not(:disabled) {
        color: var(--danger-text);
      }
    }

    .timeline-empty {
      display: grid;
      place-items: center;
      min-height: calc(var(--thumb-px) + 22px);
      color: var(--text-muted);
      font-size: 0.875rem;
      border: 2px dashed var(--line);
      border-radius: var(--radius-m);
    }

    .timeline-strip {
      display: flex;
      gap: var(--space-2);
      min-width: 0;
      padding: 4px 2px 2px;
      overflow: auto hidden;
      overscroll-behavior-x: contain;
      scrollbar-width: thin;
    }

    .timeline-item {
      display: grid;
      justify-items: center;
      gap: 2px;
      flex: none;

      &.is-fresh {
        animation: frame-pop var(--dur-pop) var(--ease-spring);
      }
    }

    .timeline-frame {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      width: var(--thumb-px);
      height: var(--thumb-px);
      padding: 3px;
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
      transition:
        border-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &.bg-checker {
        background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 12px 12px;
      }

      &.bg-dark {
        background: var(--preview-dark);
      }

      &.bg-light {
        background: var(--preview-light);
      }

      &:hover {
        border-color: var(--line-strong);
        transform: translateY(-1px);
      }

      &.is-current {
        border-color: var(--teal);
      }

      &.is-selected {
        border-color: var(--primary);
        box-shadow: 0 0 0 2px var(--primary-fill);
      }
    }

    .timeline-canvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }

    .timeline-position {
      position: absolute;
      top: -2px;
      left: -2px;
      min-width: 18px;
      padding: 0 3px;
      color: var(--text);
      background: var(--surface-2);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
      font: 700 0.6875rem/14px var(--font-body);
      font-variant-numeric: tabular-nums;

      .is-selected & {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
      }
    }

    .timeline-star {
      position: absolute;
      top: 1px;
      right: 1px;
      color: var(--yellow);
      filter: drop-shadow(0 1px 0 var(--depth));
    }

    .timeline-edited {
      position: absolute;
      right: 1px;
      bottom: 1px;
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      box-shadow: 0 1px 0 var(--depth);
    }

    .timeline-index {
      color: var(--text-faint);
      font: 600 0.6875rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    @keyframes frame-pop {
      from {
        opacity: 0;
        transform: scale(0.6) translateY(6px);
      }
    }
  }
</style>
