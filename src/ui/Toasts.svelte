<script lang="ts">
  import { app, type ToastKind } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import Icon, { type IconName } from './Icon.svelte';

  const ICONS: Record<ToastKind, IconName> = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };
</script>

<div class="toasts" role="status" aria-live="polite" aria-atomic="false">
  {#each app.toasts as toast (toast.id)}
    <div class="toast toast-{toast.kind}">
      <span class="toast-icon"><Icon name={ICONS[toast.kind]} size={18} /></span>
      <p class="toast-text">{toast.text}</p>
      <button type="button" class="toast-close" aria-label={t('toast.close')} onclick={() => app.dismissToast(toast.id)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  {/each}
</div>

<style>
  @layer components {
    .toasts {
      position: fixed;
      left: 50%;
      bottom: 76px;
      translate: -50% 0;
      z-index: 50;
      display: grid;
      gap: var(--space-2);
      width: min(420px, calc(100vw - 32px));
      pointer-events: none;
    }

    .toast {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
      color: var(--text);
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      border-left-width: 6px;
      border-radius: var(--radius-m);
      box-shadow: 0 4px 0 var(--depth);
      pointer-events: auto;
      animation: toast-in var(--dur-pop) var(--ease-spring);
    }

    .toast-success {
      border-left-color: var(--primary);
    }

    .toast-info {
      border-left-color: var(--teal);
    }

    .toast-warn {
      border-left-color: var(--yellow);
    }

    .toast-error {
      border-left-color: var(--danger);
    }

    .toast-icon {
      color: var(--text-muted);
    }

    .toast-text {
      font-size: 0.9375rem;
    }

    .toast-close {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      color: var(--text-muted);
      border-radius: var(--radius-s);

      &:hover {
        color: var(--text);
        background: var(--surface-3);
      }
    }

    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateY(12px) scale(0.96);
      }
    }
  }
</style>
