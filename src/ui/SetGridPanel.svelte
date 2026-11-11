<script lang="ts">
  import type { SetGridMode } from '../app/image-set.svelte.ts';
  import { app } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';

  const MODES: ReadonlyArray<{ id: SetGridMode; title: TextKey; hint: TextKey }> = [
    { id: 'shared', title: 'set.gridShared', hint: 'set.gridSharedHint' },
    { id: 'own', title: 'set.gridOwn', hint: 'set.gridOwnHint' },
  ];

  const grid = $derived(app.set.grid);
</script>

<section class="grid-box" aria-labelledby="set-grid-title">
  <h2 class="section-title" id="set-grid-title">{t('set.gridTitle')}</h2>
  <div class="choices" role="group" aria-labelledby="set-grid-title">
    {#each MODES as mode (mode.id)}
      <button type="button" class="choice" aria-pressed={grid.mode === mode.id} disabled={app.loading || app.cleaning} onclick={() => app.setGridMode(mode.id)}>
        <span class="choice-dot" aria-hidden="true"></span>
        <span class="choice-title">{t(mode.title)}</span>
        <span class="choice-hint">{t(mode.hint)}</span>
      </button>
    {/each}
  </div>
  {#if grid.mode === 'shared' && !grid.period}<p class="hint no-shared">{t('set.noShared')}</p>{/if}
</section>

<style>
  @layer components {
    .grid-box {
      display: grid;
      gap: 6px;
    }

    .choices {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
    }

    .choice {
      display: grid;
      grid-template: auto 1fr / auto minmax(0, 1fr);
      column-gap: 6px;
      row-gap: 2px;
      align-items: start;
      padding: 5px 6px;
      text-align: left;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      transition:
        border-color var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        border-color: var(--line-strong);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &[aria-pressed='true'] {
        background: color-mix(in oklch, var(--primary), var(--surface-sunken) 86%);
        border-color: var(--primary);
      }

      &:disabled {
        cursor: progress;
      }
    }

    .choice-dot {
      margin-top: 2px;
      width: 14px;
      height: 14px;
      border: 2px solid var(--line-strong);
      border-radius: 50%;

      .choice[aria-pressed='true'] & {
        border-color: var(--primary);
        background: radial-gradient(circle, var(--primary) 0 3px, transparent 3.5px);
      }
    }

    .choice-title {
      font-weight: 700;
      font-size: 0.875rem;
      line-height: 1.25;
    }

    .choice-hint {
      grid-column: 1 / -1;
      color: var(--text-muted);
      font-size: 0.75rem;
      line-height: 1.25;
    }

    .no-shared {
      font-size: 0.75rem;
    }

    @media (max-height: 760px) {
      .choice-hint {
        font-size: 0.6875rem;
      }
    }
  }
</style>
