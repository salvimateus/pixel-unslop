<script lang="ts">
  import { app, PRESET_NAMES, type PresetName } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';

  interface Props {
    /** The helper line under the buttons; each screen explains the effect in its own words. */
    hint: string;
  }

  let { hint }: Props = $props();

  const LABELS: Record<PresetName, TextKey> = { off: 'cleanup.off', light: 'cleanup.light', normal: 'cleanup.normal', strong: 'cleanup.strong' };

  /** Before the cleanup it only stores the choice; after it, the colors merge again and the manual edits stay. */
  function choose(name: PresetName): void {
    if (name === app.preset) return;
    sfx.play('tick');
    void app.applyPreset(name);
  }
</script>

<section class="field cleanup" aria-labelledby="cleanup-title">
  <h2 class="section-title" id="cleanup-title">{t('cleanup.title')}</h2>
  <div class="segmented presets" role="group" aria-labelledby="cleanup-title">
    {#each PRESET_NAMES as name (name)}
      <button type="button" aria-pressed={app.preset === name} onclick={() => choose(name)}>{t(LABELS[name])}</button>
    {/each}
  </div>
  <p class="hint">{hint}</p>
</section>

<style>
  @layer components {
    /* Four equal columns, so short labels never run together. */
    .presets {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));

      & button {
        padding: 0 2px;
        font-size: 0.8125rem;
      }
    }
  }
</style>

