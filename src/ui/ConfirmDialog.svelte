<script lang="ts">
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import Dialog from './Dialog.svelte';

  const request = $derived(app.confirmRequest);
</script>

<Dialog open={request !== null} labelledby="confirm-title" onclose={() => request?.resolve(false)}>
  {#if request}
    <div class="dialog-body">
      <h2 id="confirm-title" class="confirm-title">{request.title}</h2>
      <p class="confirm-body">{request.body}</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-quiet" onclick={() => request.resolve(false)}>{t('confirm.cancel')}</button>
        <button type="button" class="btn btn-danger" onclick={() => request.resolve(true)}>{request.confirmLabel}</button>
      </div>
    </div>
  {/if}
</Dialog>

<style>
  @layer components {
    .confirm-title {
      font-size: 1.375rem;
    }

    .confirm-body {
      color: var(--text-muted);
    }
  }
</style>
