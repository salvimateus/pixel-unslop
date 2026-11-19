<script lang="ts">
  import { toHex } from '../core/color.ts';
  import type { RemoveScope } from '../core/sprite.ts';
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import Icon from './Icon.svelte';
  import ToleranceSlider, { toleranceSteps } from './ToleranceSlider.svelte';

  interface Props {
    /** The picker of the stage is on: a click on the frame adds its color. */
    picking: boolean;
    ontogglepick: () => void;
    /** The pointer is on a spot that does not touch the border: a click there erases the color inside the drawing too. */
    inside?: boolean;
    /** After each change of the list, for a view that does not follow `app.anim.version`. The tolerance builds nothing. */
    onchange?: () => void;
  }

  let { picking, ontogglepick, inside = false, onchange }: Props = $props();

  const colors = $derived(app.anim.removedColors);
  const currentSteps = $derived(toleranceSteps(app.anim.colorTolerance));

  function chipLabel(color: number, tolerance: number, scope: RemoveScope): string {
    const where = scope === 'all' ? ` ${t('removeColor.insideLabel')}.` : '';
    return `${t('removeTolerance.chip', { value: toleranceSteps(tolerance) })}.${where} ${t('removeColor.restore', { color: toHex(color) })}`;
  }

  function restore(color: number): void {
    app.anim.restoreRemovedColor(color);
    sfx.play('undo');
    onchange?.();
  }

  function clear(): void {
    app.anim.clearRemovedColors();
    sfx.play('undo');
    onchange?.();
  }

  function setTolerance(value: number, commit: boolean): void {
    app.anim.setColorTolerance(value, commit);
  }
</script>

<section class="remove-colors" aria-labelledby="remove-colors-title">
  <div class="remove-head">
    <h2 class="section-title" id="remove-colors-title">{t('removeColor.title')}</h2>
    <button type="button" class="pick-btn" aria-pressed={picking} aria-keyshortcuts="R" title="{t('removeColor.pickHint')} (R)" onclick={ontogglepick}>
      <Icon name="colorErase" size={18} />
      {t('removeColor.pick')}
    </button>
  </div>
  {#if picking && inside}
    <p class="hint hint-warn" role="status">{t('removeColor.insideHint')}</p>
  {:else}
    <p class="hint">{picking ? t('removeColor.pickingHint') : t('removeColor.hint')}</p>
  {/if}
  {#if colors.length > 0}
    <ul class="chips" aria-label={t('removeColor.listLabel')}>
      {#each colors as { color, tolerance, scope } (color)}
        {@const steps = toleranceSteps(tolerance)}
        {@const label = chipLabel(color, tolerance, scope)}
        <li>
          <button type="button" class="chip" aria-label={label} title={label} onclick={() => restore(color)}>
            <span class="chip-swatch" style:background-color={toHex(color)} aria-hidden="true"></span>
            <span class="chip-hex">{toHex(color)}</span>
            {#if steps !== currentSteps}<span class="chip-tolerance" aria-hidden="true">{steps}</span>{/if}
            {#if scope === 'all'}<span class="chip-inside" aria-hidden="true">{t('removeColor.inside')}</span>{/if}
            <span class="chip-x" aria-hidden="true">×</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="remove-foot">
    <ToleranceSlider id="anim-remove-tolerance" value={app.anim.colorTolerance} onchange={setTolerance} />
    <button type="button" class="btn btn-quiet clear-btn" disabled={colors.length === 0} onclick={clear}>{t('removeColor.clear')}</button>
  </div>
  <p class="hint">{t('removeTolerance.next')}</p>
</section>

<style>
  @layer components {
    .remove-colors {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }

    .remove-head {
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

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
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
    }

    .chip-swatch {
      width: 18px;
      height: 18px;
      border: 1px solid var(--line-strong);
      border-radius: 50%;
    }

    .chip-tolerance {
      padding: 2px 5px;
      color: var(--text-muted);
      font: 600 0.6875rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
      background: var(--surface-1);
      border-radius: 999px;
    }

    .chip-inside {
      padding: 2px 5px;
      color: var(--bg);
      font: 600 0.6875rem/1 var(--font-body);
      background: var(--yellow);
      border-radius: 999px;
    }

    .hint-warn {
      padding-left: var(--space-2);
      color: var(--text);
      border-left: 3px solid var(--yellow);
    }

    .chip-x {
      color: var(--text-muted);
      font: 700 1rem/1 var(--font-body);
    }

    /* With no room for a usable slider, the clear button goes to its own line. */
    .remove-foot {
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
