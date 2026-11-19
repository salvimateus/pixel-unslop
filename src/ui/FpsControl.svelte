<script lang="ts">
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import { holdRepeat } from './hold-repeat.ts';
  import Icon from './Icon.svelte';

  interface Props {
    /** The narrow layout of the side panels and the dialogs: a visible label, the chips on their own row and a hint. */
    compact?: boolean;
  }

  let { compact = false }: Props = $props();

  const id = $props.id();
  const videoFps = $derived(app.anim.videoFps());

  function stepFps(direction: 1 | -1, big: boolean): void {
    app.anim.setFps(app.anim.fps + direction * (big ? 5 : 1), false);
  }

  function chooseFps(fps: number): void {
    if (fps === app.anim.fps) return;
    app.anim.setFps(fps);
    sfx.play('tick');
  }
</script>

{#snippet stepButton(direction: 1 | -1)}
  {@const label = direction < 0 ? t('anim.fpsDown') : t('anim.fpsUp')}
  <button
    type="button"
    class="icon-btn fps-step"
    aria-label={label}
    title={compact ? label : `${label} (${direction < 0 ? '[' : ']'})`}
    disabled={direction < 0 ? app.anim.fps <= TUNING.anim.minFps : app.anim.fps >= TUNING.anim.maxFps}
    use:holdRepeat={{ step: (shift) => stepFps(direction, shift), release: () => app.anim.commitFps() }}
  >
    <span aria-hidden="true">{direction < 0 ? '−' : '+'}</span>
  </button>
{/snippet}

{#snippet stepper()}
  {@render stepButton(-1)}
  <span class="fps-value">{t('anim.fps', { fps: app.anim.fps })}</span>
  {@render stepButton(1)}
{/snippet}

{#snippet chips()}
  <div class="segmented fps-chips">
    {#each TUNING.anim.fpsChips as chip (chip)}
      <button type="button" aria-pressed={app.anim.fps === chip} onclick={() => chooseFps(chip)}>{chip}</button>
    {/each}
  </div>
{/snippet}

{#snippet videoSpeed()}
  <button
    type="button"
    class="video-speed"
    aria-pressed={app.anim.fps === videoFps}
    aria-label={compact ? t('anim.videoSpeed') : undefined}
    title={compact ? `${t('anim.videoSpeed')}. ${t('anim.videoSpeedHint', { fps: videoFps })}` : t('anim.videoSpeedHint', { fps: videoFps })}
    onclick={() => chooseFps(videoFps)}
  >
    <Icon name="film" size={16} />
    {#if !compact}{t('anim.videoSpeed')}{/if}
  </button>
{/snippet}

{#if compact}
  <div class="fps is-compact" role="group" aria-labelledby="{id}-label" aria-describedby="{id}-hint">
    <div class="fps-head">
      <span class="fps-label" id="{id}-label">{t('anim.fpsLabel')}</span>
      <div class="fps-row">
        {@render stepper()}
        {@render videoSpeed()}
      </div>
    </div>
    {@render chips()}
    <p class="hint" id="{id}-hint">{t('anim.fpsShared')}</p>
  </div>
{:else}
  <div class="fps fps-row" role="group" aria-label={t('anim.fpsLabel')}>
    {@render stepper()}
    {@render chips()}
    {@render videoSpeed()}
  </div>
{/if}

<style>
  @layer components {
    .fps-row {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .fps-step {
      width: 30px;
      height: 30px;
      font: 700 1.125rem/1 var(--font-mono);
    }

    .fps-value {
      min-width: 6.5ch;
      padding: 0 var(--space-1);
      color: var(--text);
      font: 600 0.875rem/1 var(--font-mono);
      font-variant-numeric: tabular-nums;
      text-align: center;
      white-space: nowrap;
    }

    .fps-chips {
      margin-left: var(--space-1);
      padding: 2px;

      & button {
        min-height: 26px;
        padding: 0 6px;
        font-size: 0.8125rem;
      }
    }

    .video-speed {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-height: 30px;
      margin-left: var(--space-1);
      padding: 0 var(--space-2);
      color: var(--text-muted);
      font: 600 0.8125rem/1 var(--font-display);
      background: var(--surface-2);
      border-radius: var(--radius-s);
      white-space: nowrap;
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        color var(--dur-hover) var(--ease-sym);

      &:hover:not([aria-pressed='true']) {
        color: var(--text);
        background: var(--surface-3);
      }

      &[aria-pressed='true'] {
        color: var(--on-primary);
        background: var(--teal);
      }
    }

    .is-compact {
      display: grid;
      gap: var(--space-2);
      min-width: 0;

      & .fps-chips {
        margin-left: 0;
      }

      & .video-speed {
        justify-content: center;
        width: 30px;
        padding: 0;
      }
    }

    /* With no room, the stepper goes under the label instead of squeezing it. */
    .fps-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-1) var(--space-2);
    }

    .fps-label {
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-weight: 600;
    }
  }
</style>
