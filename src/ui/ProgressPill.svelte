<script lang="ts">
  import { app, type ProgressStage } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import Icon from './Icon.svelte';

  const LABELS: Record<ProgressStage, TextKey> = {
    decode: 'progress.decode',
    fit: 'progress.fit',
    sample: 'progress.sample',
    merge: 'progress.merge',
    encode: 'progress.encode',
    frames: 'progress.frames',
  };

  const label = $derived(app.progress ? t(LABELS[app.progress.stage], { done: app.progress.done ?? 0, total: app.progress.total ?? 0 }) : t('progress.working'));
  const ratio = $derived(app.progress ? Math.min(1, Math.max(0, app.progress.ratio)) : null);

  /** Esc stops a job that can stop; a dialog keeps its own Esc. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !app.progressCancel || !app.showProgress || app.confirmRequest) return;
    event.preventDefault();
    app.cancelProgress();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if app.showProgress}
  <div class="progress">
    <span class="progress-head">
      <span class="progress-label">{label}</span>
      {#if app.progressCancel}
        <button type="button" class="progress-cancel" title="{t('progress.cancel')} (Esc)" onclick={() => app.cancelProgress()}>
          <Icon name="close" size={14} />
          {t('progress.cancel')}
        </button>
      {/if}
    </span>
    <span class="progress-track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}>
      <span class="progress-bar" class:is-indeterminate={ratio === null} style:transform="scaleX({ratio ?? 0.35})"></span>
    </span>
  </div>
{/if}

<style>
  @layer components {
    .progress {
      position: fixed;
      left: 50%;
      top: calc(var(--header-h) + var(--space-3));
      z-index: 40;
      display: grid;
      gap: var(--space-1);
      min-width: 220px;
      padding: var(--space-2) var(--space-4);
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-m);
      box-shadow: 0 4px 0 var(--depth);
      translate: -50% 0;
      animation: progress-in var(--dur-pop) var(--ease-out);
      pointer-events: none;
    }

    .progress-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .progress-label {
      font: 600 0.875rem/1.2 var(--font-display);
      font-variant-numeric: tabular-nums;
    }

    .progress-cancel {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-height: 26px;
      padding: 0 var(--space-2);
      color: var(--text);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
      font: 600 0.75rem/1 var(--font-display);
      pointer-events: auto;
      transition: background-color var(--dur-hover) var(--ease-sym);

      &:hover {
        background: var(--surface-sunken);
      }
    }

    .progress-track {
      display: block;
      height: 6px;
      overflow: hidden;
      background: var(--surface-sunken);
      border-radius: 3px;
    }

    .progress-bar {
      display: block;
      height: 100%;
      background: var(--primary);
      transform-origin: left center;
      transition: transform var(--dur-pop) var(--ease-out);

      &.is-indeterminate {
        animation: progress-slide 1s var(--ease-sym) infinite alternate;
      }
    }

    @keyframes progress-in {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
    }

    @keyframes progress-slide {
      from {
        translate: 0 0;
      }
      to {
        translate: 185% 0;
      }
    }
  }
</style>
