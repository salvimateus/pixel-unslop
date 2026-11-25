<script lang="ts">
  import { TRANSPARENT, fromHex, toHex } from '../core/color.ts';
  import { t } from '../app/i18n.ts';
  import { TUNING } from '../app/tuning.ts';
  import Icon from './Icon.svelte';

  interface Props {
    colors: ReadonlyArray<{ color: number; count: number }>;
    /** The pressed swatch (the ink), or null. */
    selected?: number | null;
    /** The grid chooses a new color for `sources`: the swatches pulse once when it opens. */
    choosing?: boolean;
    /** Colors that get a new color: their swatches are marked. */
    sources?: readonly number[];
    /** The id of the custom color input, unique on the page. */
    customId: string;
    onchoose: (color: number) => void;
    /** A right click on a swatch. */
    onmenu?: (event: MouseEvent, color: number) => void;
    /** The custom color input moves while it is open, outside the choice of a new color. */
    onpreview?: (color: number) => void;
  }

  let { colors, selected = null, choosing = false, sources = [], customId, onchoose, onmenu, onpreview }: Props = $props();

  let customValue = $state('#ffffff');

  const shown = $derived(colors.slice(0, TUNING.ui.maxSwatches));
  const hidden = $derived(colors.length - shown.length);

  function onCustomInput(): void {
    const color = fromHex(customValue);
    if (color !== null && !choosing) onpreview?.(color);
  }

  function onCustomChange(): void {
    const color = fromHex(customValue);
    if (color !== null) onchoose(color);
  }
</script>

<div class="swatches" class:is-choosing={choosing}>
  <button
    type="button"
    class="swatch is-clear"
    aria-pressed={selected === TRANSPARENT}
    aria-label={t('palette.transparent')}
    title={t('palette.transparent')}
    onclick={() => onchoose(TRANSPARENT)}
  ></button>
  {#each shown as entry (entry.color)}
    <button
      type="button"
      class="swatch"
      class:is-source={sources.includes(entry.color)}
      style:--swatch={toHex(entry.color)}
      aria-pressed={selected === entry.color}
      aria-label={t('palette.swatch', { hex: toHex(entry.color), count: entry.count })}
      title={t('palette.swatch', { hex: toHex(entry.color), count: entry.count })}
      onclick={() => onchoose(entry.color)}
      oncontextmenu={onmenu ? (event) => onmenu(event, entry.color) : undefined}
    ></button>
  {/each}
  <label class="swatch swatch-custom" title={t('palette.custom')}>
    <Icon name="plus" size={16} />
    <input id={customId} name={customId} class="visually-hidden" type="color" bind:value={customValue} aria-label={t('palette.custom')} oninput={onCustomInput} onchange={onCustomChange} />
  </label>
</div>
{#if hidden > 0}
  <p class="hint">{t('palette.more', { count: hidden })}</p>
{/if}

<style>
  @layer components {
    .swatches {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(30px, 1fr));
      gap: 6px;
      max-height: 196px;
      padding: 2px 2px 4px;
      overflow-y: auto;
    }

    .swatch {
      position: relative;
      aspect-ratio: 1;
      background: var(--swatch);
      border: 2px solid var(--hairline);
      border-radius: var(--radius-s);
      box-shadow: 0 3px 0 var(--depth);
      transition: transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        transform: translateY(-2px);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &[aria-pressed='true'] {
        border-color: var(--text);
        outline: 2px solid var(--primary);
        outline-offset: 1px;
      }

      &.is-source {
        outline: 2px dashed var(--teal);
        outline-offset: 1px;
      }

      .is-choosing &:not(.is-source) {
        animation: swatch-pulse 360ms var(--ease-sym) 1;
      }
    }

    .is-clear {
      background-color: transparent;
      background-image: conic-gradient(var(--checker-a) 25%, var(--checker-b) 0 50%, var(--checker-a) 0 75%, var(--checker-b) 0);
      background-size: 12px 12px;
    }

    .swatch-custom {
      display: grid;
      place-items: center;
      color: var(--text-muted);
      background: var(--surface-2);
      border-style: dashed;
      cursor: pointer;

      &:hover {
        color: var(--text);
        transform: translateY(-2px);
      }

      &:focus-within {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }
    }

    @media (max-height: 760px) {
      .swatches {
        max-height: 116px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .is-choosing .swatch:not(.is-source) {
        animation: none;
      }
    }

    /* One short pulse calls the eye to the choice, then the swatches stay still. */
    @keyframes swatch-pulse {
      50% {
        transform: scale(1.12);
      }
    }
  }
</style>
