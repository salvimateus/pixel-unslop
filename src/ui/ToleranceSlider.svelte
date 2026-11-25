<script lang="ts" module>
  import { TUNING } from '../app/tuning.ts';

  const STEP = TUNING.clean.removeToleranceStep;

  /** The slider counts whole steps, so a tolerance reads as a small whole number. */
  export function toleranceSteps(value: number): number {
    return Math.round(value / STEP);
  }
</script>

<script lang="ts">
  import { t } from '../app/i18n.ts';

  interface Props {
    id: string;
    /** The OKLab tolerance of "Remove color". */
    value: number;
    /** `commit` is false during a drag and true on its release. */
    onchange: (value: number, commit: boolean) => void;
    /** In a toolbar: the label hides when the container is narrow. */
    compact?: boolean;
    /** What a higher value does; the text of "Remove color" by default. */
    hint?: string;
  }

  let { id, value, onchange, compact = false, hint }: Props = $props();

  const hintText = $derived(hint ?? t('removeColor.toleranceHint'));

  const max = toleranceSteps(TUNING.clean.removeToleranceMax);
  const steps = $derived(toleranceSteps(value));

  function read(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value) * STEP;
  }
</script>

<div class="tolerance" class:is-compact={compact} title={hintText}>
  <label class="tolerance-label" for={id}>{t('removeColor.tolerance')}</label>
  <input
    {id}
    name={id}
    class="tolerance-slider"
    type="range"
    min="0"
    {max}
    step="1"
    value={steps}
    aria-describedby="{id}-hint"
    oninput={(event) => onchange(read(event), false)}
    onchange={(event) => onchange(read(event), true)}
  />
  <span class="tolerance-value" aria-hidden="true">{steps}</span>
  <span class="visually-hidden" id="{id}-hint">{hintText}</span>
</div>

<style>
  @layer components {
    .tolerance {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
    }

    .tolerance-label {
      color: var(--text-muted);
      font-size: 0.875rem;
      white-space: nowrap;
    }

    .tolerance-slider {
      flex: 1 1 96px;
      width: 96px;
      min-width: 48px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .tolerance-value {
      flex: none;
      min-width: 2.5ch;
      font: 700 0.9375rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    @container (width < 560px) {
      .is-compact .tolerance-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    }
  }
</style>
