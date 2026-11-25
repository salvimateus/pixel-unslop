<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { t } from '../app/i18n.ts';
  import { chip as chipMotion } from './chip-motion.ts';
  import Icon, { type IconName } from './Icon.svelte';
  import ToleranceSlider from './ToleranceSlider.svelte';

  interface Props {
    /** Unique on the page: the ids of the title and of the slider start with it. */
    id: string;
    title: string;
    icon: IconName;
    pickLabel: string;
    /** The title of the pick button, without the key. */
    pickTitle: string;
    /** The key that toggles the picker of the stage. */
    pickKey: string;
    picking: boolean;
    ontogglepick: () => void;
    hint: string;
    /** The hint is a warning. */
    warn?: boolean;
    listLabel: string;
    entries: readonly T[];
    keyOf: (entry: T) => number | string;
    /** The accessible name of the chip button, which deletes the entry. */
    labelOf: (entry: T) => string;
    /** The content of one chip. Its classes `chip-swatch`, `chip-hex`, `chip-badge`, `chip-arrow` and `is-clear` take the panel styles. */
    chip: Snippet<[T]>;
    onremove: (entry: T) => void;
    onclear: () => void;
    tolerance: number;
    ontolerance: (value: number, commit: boolean) => void;
    /** What a higher tolerance does, for the slider. */
    toleranceHint?: string;
    /** Under the slider: the tolerance applies to the next picks. */
    nextHint: string;
    /** Under the hint, above the chips: the chooser of a target. */
    children?: Snippet;
  }

  let { id, title, icon, pickLabel, pickTitle, pickKey, picking, ontogglepick, hint, warn = false, listLabel, entries, keyOf, labelOf, chip, onremove, onclear, tolerance, ontolerance, toleranceHint, nextHint, children }: Props = $props();
</script>

<section class="color-list" aria-labelledby="{id}-title">
  <div class="list-head">
    <h2 class="section-title" id="{id}-title">{title}</h2>
    <button type="button" class="pick-btn" aria-pressed={picking} aria-keyshortcuts={pickKey} title="{pickTitle} ({pickKey})" onclick={ontogglepick}>
      <Icon name={icon} size={18} />
      {pickLabel}
    </button>
  </div>
  <p class="hint" class:hint-warn={warn} role={warn ? 'status' : undefined}>{hint}</p>
  {@render children?.()}
  <ul class="chips" aria-label={listLabel}>
    {#each entries as entry (keyOf(entry))}
      {@const label = labelOf(entry)}
      <li in:chipMotion out:chipMotion={{ leaving: true }}>
        <button type="button" class="chip" aria-label={label} title={label} onclick={() => onremove(entry)}>
          {@render chip(entry)}
          <span class="chip-x" aria-hidden="true">×</span>
        </button>
      </li>
    {/each}
  </ul>
  <div class="list-foot">
    <ToleranceSlider id="{id}-tolerance" value={tolerance} hint={toleranceHint} onchange={ontolerance} />
    <button type="button" class="btn btn-quiet clear-btn" disabled={entries.length === 0} onclick={onclear}>{t('removeColor.clear')}</button>
  </div>
  <p class="hint">{nextHint}</p>
</section>

<style>
  @layer components {
    .color-list {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }

    .list-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .pick-btn {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 36px;
      padding: 0 var(--space-3);
      color: var(--text);
      font: 600 0.875rem/1 var(--font-display);
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

    .hint-warn {
      padding-left: var(--space-2);
      color: var(--text);
      border-left: 3px solid var(--yellow);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;

      &:not(:has(li)) {
        display: none;
      }
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      min-height: 30px;
      padding: 0 var(--space-2) 0 var(--space-1);
      color: var(--text);
      background: var(--surface-sunken);
      border: 1px solid var(--line);
      border-radius: 999px;
      font: 600 0.8125rem/1 var(--font-mono);
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover {
        background: var(--surface-2);
      }

      &:active {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      & :global(.chip-swatch) {
        width: 18px;
        height: 18px;
        background: var(--swatch);
        border: 1px solid var(--line-strong);
        border-radius: 50%;
      }

      & :global(.is-clear) {
        background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 8px 8px;
      }

      & :global(.chip-arrow) {
        color: var(--text-muted);
        font-family: var(--font-body);
      }

      & :global(.chip-badge) {
        padding: 2px 5px;
        color: var(--text-muted);
        font: 600 0.6875rem/1 var(--font-body);
        font-variant-numeric: tabular-nums;
        background: var(--surface-1);
        border-radius: 999px;
      }

      & :global(.chip-badge.is-inside) {
        color: var(--bg);
        background: var(--yellow);
      }
    }

    .chip-x {
      color: var(--text-muted);
      font: 700 1rem/1 var(--font-body);
    }

    /* With no room for a usable slider, the clear button goes to its own line. */
    .list-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2) var(--space-3);

      & > :global(.tolerance) {
        flex: 1 1 13rem;
      }
    }

    .clear-btn {
      min-height: 32px;
      padding: 0 var(--space-3);
    }
  }
</style>
