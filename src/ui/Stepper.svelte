<script lang="ts">
  import { app, SCREENS, type Screen } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';

  const LABELS: Record<Screen, TextKey> = { drop: 'step.drop', grid: 'step.grid', clean: 'step.clean' };
  const current = $derived(SCREENS.indexOf(app.screen));

  /** Back is always open; forward only to a step that already has its data, so nothing is recomputed by surprise. */
  function reachable(screen: Screen): boolean {
    if (screen === 'drop') return true;
    if (screen === 'grid') return app.source !== null;
    return app.result !== null && app.result.fitVersion === app.fitVersion;
  }
</script>

<nav class="stepper" aria-label={t('step.label')}>
  <ol class="stepper-list">
    {#each SCREENS as screen, index (screen)}
      <li class="stepper-item" class:is-done={index !== current && reachable(screen)} class:is-current={index === current}>
        {#if index > 0}<span class="stepper-link" aria-hidden="true"></span>{/if}
        <button
          type="button"
          class="stepper-step"
          disabled={index === current || !reachable(screen)}
          aria-current={index === current ? 'step' : undefined}
          onclick={() => app.goTo(screen)}
        >
          <span class="stepper-number">{index + 1}</span>
          <span class="stepper-label">{t(LABELS[screen])}</span>
          {#if index === current}<span class="visually-hidden">({t('step.current')})</span>{/if}
        </button>
      </li>
    {/each}
  </ol>
</nav>

<style>
  @layer components {
    .stepper-list {
      display: flex;
      align-items: center;
    }

    .stepper-item {
      display: flex;
      align-items: center;
    }

    .stepper-link {
      width: 28px;
      height: 3px;
      margin: 0 var(--space-1);
      background: var(--line);
      border-radius: 2px;

      .is-done &,
      .is-current & {
        background: var(--primary-depth);
      }
    }

    .stepper-step {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-3) var(--space-1) var(--space-1);
      border-radius: 999px;
      color: var(--text-faint);
      font: 600 0.9375rem/1 var(--font-display);
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:disabled {
        cursor: default;
      }

      .is-done &:hover {
        background: var(--surface-2);
      }

      .is-done &:active {
        transform: translateY(1px);
      }

      .is-done & {
        color: var(--text-muted);
      }

      .is-current & {
        color: var(--text);
      }
    }

    .stepper-number {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      font: 700 0.875rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
      color: var(--text-muted);
      background: var(--surface-2);
      border: 2px solid var(--line);

      .is-done & {
        color: var(--on-primary);
        background: var(--primary-depth);
        border-color: var(--primary-depth);
      }

      .is-current & {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
      }
    }
  }
</style>
