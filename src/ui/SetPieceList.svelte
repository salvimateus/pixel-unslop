<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isWholeStep, ratioLabel } from '../app/image-set.svelte.ts';
  import { app } from '../app/state.svelte.ts';
  import { formatDecimal, t } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import Icon from './Icon.svelte';
  import { sourceThumb, spriteThumb } from './sprite-thumb.ts';

  interface Props {
    /** `grid`: the Grade step, with the original image and the grid of each piece. `result`: the cleaned pieces. */
    view: 'grid' | 'result';
  }

  let { view }: Props = $props();

  let fileInput: HTMLInputElement;
  let referenceInput: HTMLInputElement;

  /** Row height and gap of the list, in CSS px: the list shows whole rows only, so no row is cut. */
  const ROW_PX = 48;
  const GAP_PX = 4;

  let box: HTMLDivElement;
  let list: HTMLUListElement | undefined = $state();
  let rows = $state(1);

  const items = $derived.by(() => {
    void app.set.version;
    void app.set.liveVersion;
    return app.set.objects.map((object) => {
      // The open piece of the Grade step shows its grid as it is now, before it goes back to the set.
      const fit = object.id === app.editingId && app.fit ? app.fit : object.fit;
      return {
      id: object.id,
      name: object.name,
      bytes: object.bytes,
      output: object.output,
      height: object.height,
      badge: object.prepared && object.output ? ratioLabel(object.step, object.prepared.rows, object.height) : null,
      exact: isWholeStep(object.step),
      weak: !object.reference && fit.quality === 1,
      native: fit.notes.includes('native-resolution'),
      quality: fit.quality,
      backgroundKept: object.backgroundKept,
      reference: object.reference,
      // The mean of both axes, as the size control of the Grade step shows it.
      pixelSize: (fit.axes.x.period + fit.axes.y.period) / 2,
      };
    });
  });
  const selectedId = $derived(view === 'grid' ? app.editingId : app.set.selectedId);
  const ownGrid = $derived(app.set.grid.mode === 'own');
  const full = $derived(items.length >= TUNING.set.maxObjects);
  const listHeight = $derived(Math.max(1, rows) * ROW_PX + Math.max(0, rows - 1) * GAP_PX);

  /** A piece selected on the stage scrolls into the list view. Only the list scrolls: scrollIntoView would move clipped layout boxes too. */
  $effect(() => {
    const id = view === 'grid' ? app.editingId : app.set.selectedId;
    void tick().then(() => {
      const row = list?.querySelector<HTMLElement>(`[data-piece="${id}"]`);
      if (!list || !row) return;
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
    });
  });

  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const height = entries[0].contentRect.height;
      rows = Math.max(1, Math.floor((height + GAP_PX) / (ROW_PX + GAP_PX)));
    });
    observer.observe(box);
    return () => observer.disconnect();
  });

  function select(id: number): void {
    if (selectedId === id) return;
    sfx.play('tick');
    if (view === 'grid') void app.openSetGrid(id);
    else app.set.select(id);
  }

  async function onPick(): Promise<void> {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = '';
    await app.openFiles(files);
  }

  async function onPickReference(): Promise<void> {
    const files = referenceInput.files ? Array.from(referenceInput.files) : [];
    referenceInput.value = '';
    await app.addReferences(files);
  }
</script>

<section class="pieces" class:is-grid={view === 'grid'} aria-labelledby="set-pieces-title">
  <div class="pieces-head">
    <h2 class="section-title" id="set-pieces-title">{t('set.pieces')} <span class="pieces-count">{items.length}</span></h2>
    <span class="add-group">
      <button type="button" class="add-btn" title={t('set.add')} onclick={() => fileInput.click()} disabled={app.loading || full}>
        <Icon name="plus" size={14} />
        {t('set.addImage')}
      </button>
      <button type="button" class="add-btn is-ref" title={t('set.addReferenceLabel')} onclick={() => referenceInput.click()} disabled={app.loading || full}>
        <Icon name="lock" size={14} />
        {t('set.addReference')}
      </button>
    </span>
  </div>
  <div class="pieces-box" bind:this={box}>
    <ul class="piece-list" bind:this={list} style:max-height="{listHeight}px">
      {#each items as item (item.id)}
        <li class="piece" class:is-selected={selectedId === item.id} class:is-ref={item.reference} data-piece={item.id}>
          <button type="button" class="piece-main" aria-pressed={selectedId === item.id} onclick={() => select(item.id)} disabled={view === 'grid' && app.loading}>
            <span class="piece-thumb-box">
              {#if view === 'grid'}
                <img class="piece-thumb is-source" use:sourceThumb={item.bytes} alt="" width="32" height="32" />
              {:else}
                <canvas class="piece-thumb" use:spriteThumb={item.output} width="1" height="1" aria-hidden="true"></canvas>
              {/if}
            </span>
            <span class="piece-name">{item.name}</span>
            <span class="piece-size">
              {#if view === 'grid'}
                {#if item.reference}
                  <span class="piece-ref"><Icon name="lock" size={12} />{t('set.reference')}</span>
                {:else}
                  <!-- "Uma grade para todas" has one size, shown by the size control: the rows show no size of their own. -->
                  {#if ownGrid}<span class="piece-grid" title={t('set.pieceGrid', { size: formatDecimal(item.pixelSize) })}><Icon name="grid" size={12} />{formatDecimal(item.pixelSize)}</span>{/if}
                  <span class="piece-stars" role="img" aria-label={t('grid.quality', { stars: item.quality })}>
                    {#each [1, 2, 3] as star (star)}<Icon name="star" size={10} filled={star <= item.quality} />{/each}
                  </span>
                {/if}
                {#if item.native}<span class="piece-native" title={t('setGrid.nativePiece')}>{t('setGrid.nativeBadge')}</span>{/if}
              {:else if item.reference}
                <span class="piece-ref"><Icon name="lock" size={12} />{t('set.reference')}</span>
                {t('set.pieceHeight', { h: item.height })}
              {:else if item.output}
                {t('set.pieceHeight', { h: item.height })}
                {#if item.badge}<span class="piece-badge" class:is-free={!item.exact}>{item.badge}</span>{/if}
                {#if item.backgroundKept}<span class="piece-bg" title={t('set.bgKeptNote')}><Icon name="image" size={12} />{t('set.bgKept')}</span>{/if}
                {#if ownGrid}
                  <span class="piece-pixel" title={t('set.pieceGrid', { size: formatDecimal(item.pixelSize) })}><Icon name="grid" size={12} />{formatDecimal(item.pixelSize)}</span>
                {/if}
              {:else}
                <span class="piece-empty">{t('set.pieceEmpty')}</span>
              {/if}
            </span>
          </button>
          {#if item.weak && view === 'grid'}
            <span class="piece-warn is-badge" title={t('setGrid.weakNote')}>
              <Icon name="alert" size={16} />
              <span class="piece-warn-label">{t('set.weak')}</span>
            </span>
          {:else if item.weak}
            <button type="button" class="piece-warn" title={t('set.weakAction', { name: item.name })} aria-label={t('set.weakAction', { name: item.name })} onclick={() => app.openSetGrid(item.id)} disabled={app.loading}>
              <Icon name="alert" size={16} />
              <span class="piece-warn-label">{t('set.weak')}</span>
            </button>
          {/if}
        </li>
      {/each}
      {#if items.length < 2}
        <li class="add-more">
          <button type="button" class="add-more-btn" onclick={() => fileInput.click()} disabled={app.loading}>
            <Icon name="plus" size={18} />
            <span>{t('set.addMore')}</span>
          </button>
        </li>
      {/if}
    </ul>
  </div>
  <input
    bind:this={fileInput}
    id="set-add-file-{view}"
    name="set-add-file"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    multiple
    aria-label={t('set.addLabel')}
    tabindex="-1"
    onchange={onPick}
  />
  <input
    bind:this={referenceInput}
    id="set-add-reference-{view}"
    name="set-add-reference"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    multiple
    aria-label={t('set.referenceInputLabel')}
    tabindex="-1"
    onchange={onPickReference}
  />
</section>

<style>
  @layer components {
    .pieces {
      container-type: inline-size;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: var(--space-2);
      min-height: 0;
    }

    .pieces-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);

      & .section-title {
        white-space: nowrap;
      }
    }

    .pieces-count {
      margin-left: var(--space-1);
      padding: 0 6px;
      color: var(--text-muted);
      background: var(--surface-3);
      border-radius: var(--radius-s);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }

    .add-group {
      display: flex;
      flex: none;
      gap: 4px;
    }

    .add-btn {
      display: flex;
      align-items: center;
      gap: 3px;
      min-height: 26px;
      padding: 0 6px;
      color: var(--text-muted);
      font: 600 0.8125rem/1 var(--font-display);
      white-space: nowrap;
      border: 2px dashed var(--line-strong);
      border-radius: var(--radius-s);
      transition:
        color var(--dur-hover) var(--ease-sym),
        border-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        color: var(--primary);
        border-color: var(--primary-edge);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
    }

    .pieces-box {
      min-height: 0;
      overflow: hidden;
    }

    .piece-list {
      display: grid;
      grid-auto-rows: 48px;
      gap: 4px;
      overflow: hidden auto;
      overscroll-behavior: contain;
      scroll-snap-type: y mandatory;
    }

    .piece {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-1);
      height: 48px;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      scroll-snap-align: start;
      transition: border-color var(--dur-hover) var(--ease-sym);

      &.is-selected {
        border-color: var(--primary);
      }
    }

    .add-more {
      height: 48px;
      scroll-snap-align: start;
    }

    .add-more-btn {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      height: 100%;
      padding: 0 var(--space-3);
      color: var(--teal);
      text-align: left;
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.25;
      border: 2px dashed var(--teal);
      border-radius: var(--radius-m);
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        background: color-mix(in oklch, var(--teal), transparent 88%);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }
    }

    .piece-main {
      display: grid;
      grid-template: auto auto / 36px minmax(0, 1fr);
      column-gap: var(--space-2);
      align-items: center;
      min-width: 0;
      height: 100%;
      padding: 0 var(--space-2);
      text-align: left;
      border-radius: var(--radius-s);
      transition: transform var(--dur-hover) var(--ease-sym);

      &:active {
        transform: translateY(1px);
      }
    }

    .piece-thumb-box {
      grid-row: span 2;
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 8px 8px;
      border-radius: var(--radius-s);
      overflow: hidden;
    }

    .piece-thumb {
      width: 32px;
      height: 32px;
      object-fit: contain;
      image-rendering: pixelated;
    }

    .piece-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      line-height: 1.25;
    }

    .piece-size {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 0.8125rem;
      line-height: 1.25;
      font-variant-numeric: tabular-nums;
    }

    .piece-badge {
      padding: 0 6px;
      color: var(--on-primary);
      background: var(--primary-depth);
      border-radius: var(--radius-s);
      font-weight: 700;
      font-size: 0.75rem;
    }

    .is-selected .piece-badge {
      background: var(--primary);
    }

    .piece-badge.is-free {
      background: var(--yellow);
    }

    .piece-bg {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      min-width: 0;
      padding: 0 4px;
      overflow: hidden;
      color: var(--on-danger);
      background: var(--danger);
      border-radius: var(--radius-s);
      font-weight: 700;
      font-size: 0.6875rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .piece.is-ref {
      border-style: dashed;
    }

    .piece-ref {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 0 4px;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      font-weight: 700;
      font-size: 0.6875rem;
    }

    .is-grid .pieces-head {
      flex-wrap: wrap;
    }

    .piece-thumb.is-source {
      object-fit: contain;
      image-rendering: auto;
    }

    .piece-grid,
    .piece-stars {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }

    .piece-stars {
      color: var(--yellow);
    }

    .piece-native {
      padding: 0 4px;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      font-weight: 700;
      font-size: 0.6875rem;
    }

    .piece-warn.is-badge {
      cursor: default;
    }

    .piece-pixel {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      color: var(--text-faint);
      font-size: 0.75rem;
    }

    .piece-empty {
      color: var(--danger-text);
    }

    .piece-warn {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      margin-right: var(--space-1);
      padding: var(--space-1) var(--space-2);
      color: var(--on-primary);
      background: var(--yellow);
      border-radius: var(--radius-s);
      font: 600 0.75rem/1 var(--font-display);
      transition: transform var(--dur-hover) var(--ease-sym);

      &:active:not(:disabled) {
        transform: translateY(1px);
      }

      &:disabled {
        opacity: 0.5;
        cursor: progress;
      }
    }

    @container (width < 300px) {
      .piece-warn-label {
        display: none;
      }
    }
  }
</style>
