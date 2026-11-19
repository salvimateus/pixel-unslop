<script lang="ts">
  import type { Sprite } from '../core/types.ts';
  import { t } from '../app/i18n.ts';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { PreviewBackground } from './clean-scene.ts';
  import FpsControl from './FpsControl.svelte';
  import Icon from './Icon.svelte';
  import { loopFrames } from './loop-frames.ts';

  interface Props {
    frames: readonly Sprite[];
    /** A change bakes the frames again. */
    version: number;
    background: PreviewBackground;
    label: string;
  }

  let { frames, version, background, label }: Props = $props();

  let playing = $state(!prefersReducedMotion());
</script>

<figure class="loop" style:--loop-px="{TUNING.anim.loopPreviewPx}px">
  <div class="loop-view bg-{background}">
    {#if frames.length === 0}
      <span class="loop-empty">{t('anim.loopEmpty')}</span>
    {:else}
      <canvas class="loop-canvas" use:loopFrames={{ frames, version, fps: app.anim.fps, playing }} aria-hidden="true"></canvas>
    {/if}
  </div>
  <div class="loop-fps">
    <FpsControl compact />
  </div>
  <figcaption class="loop-caption">
    <span class="loop-label">{label}</span>
    <button
      type="button"
      class="icon-btn loop-toggle"
      aria-label={playing ? t('anim.pause') : t('anim.play')}
      title={playing ? t('anim.pause') : t('anim.play')}
      disabled={frames.length < 2}
      onclick={() => (playing = !playing)}
    >
      <Icon name={playing ? 'pause' : 'play'} size={16} />
    </button>
  </figcaption>
</figure>

<style>
  @layer components {
    .loop {
      display: grid;
      grid-template-columns: var(--loop-px) minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
      margin: 0;
    }

    .loop-view {
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      place-items: center;
      width: var(--loop-px);
      height: var(--loop-px);
      padding: var(--space-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);

      &.bg-checker {
        background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 12px 12px;
      }

      &.bg-dark {
        background: var(--preview-dark);
      }

      &.bg-light {
        background: var(--preview-light);
      }
    }

    .loop-canvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }

    .loop-empty {
      padding: var(--space-2);
      color: var(--text-muted);
      font-size: 0.75rem;
      text-align: center;
    }

    .loop-caption {
      grid-area: 1 / 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .loop-fps {
      grid-area: 2 / 1 / 3 / -1;
      min-width: 0;
    }

    .loop-toggle {
      width: 32px;
      height: 32px;
    }
  }
</style>
