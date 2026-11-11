<script lang="ts">
  import { app, type BrushTool } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { holdRepeat } from './hold-repeat.ts';
  import Icon from './Icon.svelte';

  interface Props {
    /** The tool whose size the control shows, or null when the active tool has no size: the space stays. */
    tool: BrushTool | null;
    /** A new size of the active tool, from the buttons, the slider or the keys. */
    onsize: (size: number) => void;
  }

  let { tool, onsize }: Props = $props();

  const size = $derived(tool ? app.brush[tool] : 1);
  const limit = $derived(app.brushLimit);
  /** The preview square grows with the size, up to the height of the control. */
  const preview = $derived(Math.round(4 + (Math.min(size, 16) - 1) * (14 / 15)));
</script>

<div class="brush-box">
  <div class="brush" class:is-off={!tool} inert={!tool} aria-hidden={!tool} role="group" aria-labelledby="brush-label">
    <span class="brush-label" id="brush-label">{t('brush.label')}</span>
    <button type="button" class="icon-btn brush-step" aria-label={t('brush.smaller')} title="{t('brush.smaller')} ([)" disabled={size <= 1} use:holdRepeat={{ step: () => onsize(size - 1) }}>
      <span class="brush-sign" aria-hidden="true">−</span>
    </button>
    <input
      id="brush-size"
      name="brush-size"
      class="brush-slider"
      type="range"
      min="1"
      max={limit}
      step="1"
      value={size}
      aria-label={t('brush.label')}
      aria-valuetext={t('brush.value', { size })}
      oninput={(event) => onsize(Number((event.currentTarget as HTMLInputElement).value))}
    />
    <button type="button" class="icon-btn brush-step" aria-label={t('brush.larger')} title="{t('brush.larger')} (])" disabled={size >= limit} use:holdRepeat={{ step: () => onsize(size + 1) }}>
      <Icon name="plus" size={16} />
    </button>
    <span class="brush-value" aria-hidden="true">
      <span class="brush-preview"><span class="brush-dot" style:width="{preview}px" style:height="{preview}px"></span></span>
      {size}
    </span>
  </div>
</div>

<style>
  @layer components {
    .brush-box {
      container-type: inline-size;
      width: 100%;
      min-width: 0;
    }

    .brush {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-width: 0;
      transition: opacity var(--dur-hover) var(--ease-sym);

      &.is-off {
        visibility: hidden;
        opacity: 0;
      }
    }

    .brush-label {
      color: var(--text-muted);
      font-size: 0.875rem;
      white-space: nowrap;
    }

    .brush-step {
      flex: none;
      width: 30px;
      height: 30px;
      touch-action: none;
    }

    .brush-sign {
      font: 700 1.125rem/1 var(--font-body);
    }

    .brush-slider {
      flex: 1 1 72px;
      width: 72px;
      min-width: 40px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .brush-value {
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: var(--space-1);
      min-width: 3.5ch;
      font: 700 0.9375rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .brush-preview {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      background: var(--surface-sunken);
      border: 1px solid var(--line);
      border-radius: var(--radius-s);
    }

    .brush-dot {
      background: var(--primary);
      border-radius: 1px;
    }

    /* A narrow toolbar keeps the buttons and the value; the label and the slider come back with room. */
    @container (width < 190px) {
      .brush-label,
      .brush-slider {
        display: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .brush {
        transition: none;
      }
    }
  }
</style>
