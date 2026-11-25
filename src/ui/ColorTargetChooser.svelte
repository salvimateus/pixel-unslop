<script lang="ts">
  import { TRANSPARENT, toHex } from '../core/color.ts';
  import { t } from '../app/i18n.ts';
  import { revealInPanel } from './reveal.ts';
  import SwatchGrid from './SwatchGrid.svelte';

  interface Props {
    /** The swatches of the choice. */
    colors: ReadonlyArray<{ color: number; count: number }>;
    /** The colors that get the new color, in the order of the picks. */
    sources: readonly number[];
    /** The grid shows: a click on a swatch, on "Transparent" or on the custom color chooses the new color. */
    choosing: boolean;
    customId: string;
    onchoose: (to: number) => void;
    oncancel: () => void;
    /** Drops one source from the group; without it the sources cannot be dropped one by one. */
    ondrop?: (color: number) => void;
  }

  let { colors, sources, choosing, customId, onchoose, oncancel, ondrop }: Props = $props();

  let root: HTMLDivElement | undefined = $state();

  /** The scroll areas of the side panels that host the chooser. */
  const PANEL_AREAS = '.clean-panel-scroll, .set-panel-scroll, .anim-panel-scroll';

  // The chooser opens after a pick on the stage, maybe below the visible part of the panel. A scroll moves no focus,
  // so the keys of the stage keep working.
  $effect(() => {
    if (choosing && root) revealInPanel(root, PANEL_AREAS);
  });

  const text = $derived.by(() => {
    if (!choosing) return sources.length === 1 ? t('replaceColor.groupOne') : t('replaceColor.group', { count: sources.length });
    return sources.length === 1 ? t('palette.swapPick', { hex: toHex(sources[0]) }) : t('replaceColor.pickMany', { count: sources.length });
  });

  function choose(to: number): void {
    // A source that is the only one cannot get its own color.
    if (sources.length === 1 && to === sources[0]) return;
    onchoose(to);
  }
</script>

<div class="target-chooser" bind:this={root}>
  <div class="target-banner" role="status">
    <ul class="sources" aria-label={t('replaceColor.groupLabel')}>
      {#each sources as color (color)}
        <li class="source">
          <span class="source-swatch" class:is-clear={color === TRANSPARENT} style:--swatch={toHex(color)} title={toHex(color)}></span>
          {#if ondrop && sources.length > 1}
            <button type="button" class="source-drop" aria-label={t('replaceColor.drop', { hex: toHex(color) })} title={t('replaceColor.drop', { hex: toHex(color) })} onclick={() => ondrop(color)}>×</button>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="target-text">{text}</p>
    <button type="button" class="btn btn-quiet target-cancel" title="{t('palette.cancel')} (Esc)" onclick={oncancel}>{t('palette.cancel')}</button>
  </div>
  {#if choosing}
    <SwatchGrid {colors} {sources} {customId} choosing onchoose={choose} />
  {/if}
</div>

<style>
  @layer components {
    .target-chooser {
      display: grid;
      gap: var(--space-2);
    }

    .target-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      font-size: 0.875rem;
      background: color-mix(in oklch, var(--teal), transparent 85%);
      border: 2px solid var(--teal);
      border-radius: var(--radius-m);
      animation: chooser-in var(--dur-pop) var(--ease-out);
    }

    .sources {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .source {
      position: relative;
      display: flex;
    }

    .source-swatch {
      width: 22px;
      height: 22px;
      background: var(--swatch);
      border: 2px solid var(--hairline-strong);
      border-radius: var(--radius-s);
      box-shadow: 0 3px 0 var(--depth);
    }

    .is-clear {
      background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 8px 8px;
    }

    .source-drop {
      position: absolute;
      top: -7px;
      right: -7px;
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
      color: var(--text);
      font: 700 0.75rem/1 var(--font-body);
      background: var(--surface-2);
      border: 1px solid var(--line-strong);
      border-radius: 50%;

      &:hover {
        background: var(--surface-3);
      }
    }

    .target-text {
      flex: 1 1 8rem;
      margin: 0;
    }

    .target-cancel {
      min-height: 30px;
      padding: 0 var(--space-2);
      font-size: 0.8125rem;
    }

    @keyframes chooser-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
  }
</style>
