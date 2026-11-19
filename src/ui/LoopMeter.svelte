<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../app/i18n.ts';
  import { prefersReducedMotion } from '../app/state.svelte.ts';
  import type { MatchLevel } from '../core/loop.ts';
  import Icon from './Icon.svelte';

  interface LoopAction {
    label: string;
    hint: string;
    primary: boolean;
    run: () => void;
  }

  interface Props {
    /** How much the shown frame matches the first one, 0 to 100, or null when there is nothing to measure. */
    percent: number | null;
    level: MatchLevel | null;
    /** Shown in place of the percent when `percent` is null. */
    note: string | null;
    action: LoopAction | null;
  }

  let { percent, level, note, action }: Props = $props();

  let popping = $state(false);
  let lastLevel: MatchLevel | null = null;

  $effect(() => {
    const next = level;
    untrack(() => {
      if (next === 'match' && lastLevel !== 'match' && !prefersReducedMotion()) popping = true;
      lastLevel = next;
    });
  });
</script>

<div
  class="meter"
  class:is-match={level === 'match'}
  class:is-near={level === 'near'}
  class:is-pop={popping}
  onanimationend={() => (popping = false)}
>
  <Icon name="compare" size={16} />
  <span class="meter-text">{percent === null ? (note ?? '') : t('loop.meterSame', { percent })}</span>
  {#if percent !== null}
    <span class="meter-bar" aria-hidden="true">
      <span class="meter-fill" style:--match={Math.min(1, Math.max(0, percent / 100))}></span>
    </span>
  {/if}
  <span class="visually-hidden" aria-live="polite">{level === 'match' ? t('loop.meterMatch') : level === 'near' ? t('loop.meterNear') : ''}</span>
  {#if action}
    <button type="button" class="btn meter-action" class:btn-primary={action.primary} title={action.hint} onclick={action.run}>{action.label}</button>
  {/if}
</div>

<style>
  @layer components {
    .meter {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      max-width: 100%;
      min-height: 44px;
      padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
      font-size: 0.875rem;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      pointer-events: auto;
      transition: border-color var(--dur-hover) var(--ease-sym);

      & > :global(.icon) {
        flex: none;
        color: var(--stage-ghost-first);
      }

      &.is-near {
        border-color: var(--yellow);
      }

      &.is-match {
        border-color: var(--primary);
      }

      &.is-pop {
        animation: meter-pop var(--dur-modal) var(--ease-spring);
      }
    }

    .meter-text {
      min-width: 0;
      overflow: hidden;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meter-bar {
      flex: none;
      width: 72px;
      height: 8px;
      overflow: hidden;
      background: var(--surface-3);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-s);
    }

    .meter-fill {
      display: block;
      height: 100%;
      background: var(--text-muted);
      transform: scaleX(var(--match));
      transform-origin: left;
      transition: transform var(--dur-pop) var(--ease-out);

      .is-near & {
        background: var(--yellow);
      }

      .is-match & {
        background: var(--primary);
      }
    }

    .meter-action {
      flex: none;
      min-height: 32px;
      padding: 0 var(--space-3);
      font-size: 0.875rem;
    }

    @keyframes meter-pop {
      50% {
        transform: scale(1.06);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .meter.is-pop {
        animation: none;
      }

      .meter-fill {
        transition: none;
      }
    }
  }
</style>
