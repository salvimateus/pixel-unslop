<script lang="ts">
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import Icon from './Icon.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import { spriteThumb } from './sprite-thumb.ts';

  let fileInput: HTMLInputElement;

  const reference = $derived(app.colorReference);

  async function onPick(): Promise<void> {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    // Cleared at once, so the same file can be picked again.
    fileInput.value = '';
    await app.loadColorReference(files);
  }
</script>

<section class="field reference" aria-labelledby="reference-title">
  <h2 class="section-title" id="reference-title">{t('reference.title')}</h2>
  {#if reference}
    <div class="reference-row">
      <span class="reference-thumb-box">
        <canvas class="reference-thumb" use:spriteThumb={reference.sprite} width="1" height="1" aria-hidden="true"></canvas>
      </span>
      <div class="reference-switch">
        <ToggleSwitch
          id="reference-on"
          label={t('reference.use', { name: reference.name })}
          hint={t('reference.useHint')}
          checked={reference.on}
          disabled={app.loading}
          onchange={(on) => app.setColorReferenceOn(on)}
        />
      </div>
      <button type="button" class="icon-btn" aria-label={t('reference.remove')} title={t('reference.remove')} disabled={app.loading} onclick={() => app.clearColorReference()}>
        <Icon name="trash" size={18} />
      </button>
    </div>
  {/if}
  <button type="button" class="btn btn-quiet reference-pick" onclick={() => fileInput.click()} disabled={app.loading}>
    <Icon name="image" size={18} />
    {reference ? t('reference.change') : t('reference.choose')}
  </button>
  <p class="hint">{t('reference.hint')}</p>
  <input
    bind:this={fileInput}
    id="reference-file"
    name="reference-file"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    aria-label={t('reference.inputLabel')}
    tabindex="-1"
    onchange={onPick}
  />
</section>

<style>
  @layer components {
    .reference-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-2);
    }

    .reference-thumb-box {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 8px 8px;
      border-radius: var(--radius-s);
      overflow: hidden;
    }

    .reference-thumb {
      width: 32px;
      height: 32px;
      object-fit: contain;
      image-rendering: pixelated;
    }

    /* A long file name wraps inside the label instead of widening the panel. */
    .reference-switch {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .reference-pick {
      justify-self: stretch;
    }
  }
</style>
