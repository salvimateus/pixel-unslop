<script lang="ts">
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { TUNING } from '../app/tuning.ts';
  import Icon from './Icon.svelte';

  let box: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The pointer or the focus is on the indicator: it stays open. */
  let held = false;

  const atMin = $derived(app.zoomPercent <= TUNING.ui.zoom.min);
  const atMax = $derived(app.zoomPercent >= TUNING.ui.zoom.max);

  // A top-layer popover: it shows above an open dialog too, and a new change updates it in place.
  $effect(() => {
    if (app.zoomShownAt <= 0 || !box) return;
    if (!box.matches(':popover-open')) box.showPopover();
    schedule();
  });

  $effect(() => () => clearTimeout(timer));

  function schedule(): void {
    clearTimeout(timer);
    if (held) return;
    timer = setTimeout(() => {
      if (!held && box.matches(':popover-open')) box.hidePopover();
    }, TUNING.ui.zoomIndicatorMs);
  }

  function hold(on: boolean): void {
    held = on;
    schedule();
  }
</script>

<div
  bind:this={box}
  class="zoom-indicator"
  popover="manual"
  role="group"
  aria-label={t('zoom.label')}
  onpointerenter={() => hold(true)}
  onpointerleave={() => hold(false)}
  onfocusin={(event) => {
    if ((event.target as HTMLElement).matches(':focus-visible')) hold(true);
  }}
  onfocusout={() => hold(false)}
>
  <span class="zoom-value" aria-live="polite">{app.zoomPercent}%</span>
  <div class="zoom-actions">
    <button type="button" class="icon-btn zoom-step" aria-label={t('zoom.out')} title={t('zoom.out')} disabled={atMin} onclick={() => app.changeZoom('out')}>
      <span class="zoom-sign" aria-hidden="true">−</span>
    </button>
    <button type="button" class="icon-btn zoom-step" aria-label={t('zoom.in')} title={t('zoom.in')} disabled={atMax} onclick={() => app.changeZoom('in')}>
      <Icon name="plus" size={18} />
    </button>
    <button type="button" class="btn btn-quiet zoom-reset" aria-label={t('zoom.resetLabel', { value: app.zoomDefault })} title={t('zoom.resetLabel', { value: app.zoomDefault })} disabled={app.zoomPercent === app.zoomDefault} onclick={() => app.changeZoom('reset')}>
      {t('zoom.reset')}
    </button>
  </div>
</div>

<style>
  @layer components {
    .zoom-indicator {
      position: fixed;
      inset: auto;
      top: calc(var(--header-h) + var(--space-2));
      right: var(--space-4);
      margin: 0;
      display: grid;
      justify-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      color: var(--text);
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-l);
      box-shadow: 0 6px 0 var(--depth);
      opacity: 1;
      transform: none;
      transition:
        opacity var(--dur-pop) var(--ease-out),
        transform var(--dur-pop) var(--ease-out),
        display var(--dur-pop) allow-discrete,
        overlay var(--dur-pop) allow-discrete;

      &:not(:popover-open) {
        opacity: 0;
        transform: scale(0.94);
      }

      @starting-style {
        &:popover-open {
          opacity: 0;
          transform: scale(0.94);
        }
      }
    }

    .zoom-value {
      font: 700 2rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .zoom-actions {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .zoom-step {
      width: 36px;
      height: 36px;
      background: var(--surface-3);
      border: 2px solid var(--line-strong);
    }

    .zoom-sign {
      font: 700 1.375rem/1 var(--font-body);
    }

    .zoom-reset {
      min-height: 36px;
      padding: 0 var(--space-3);
      font-size: 0.875rem;
    }

    @media (prefers-reduced-motion: reduce) {
      .zoom-indicator {
        transition: none;
      }
    }
  }
</style>
