<script lang="ts">
  import * as sfx from '../app/sfx.ts';

  interface Props {
    id: string;
    label: string;
    checked: boolean;
    /** A longer explanation, read by screen readers and shown as a tooltip. */
    hint?: string;
    disabled?: boolean;
    onchange: (checked: boolean) => void;
  }

  let { id, label, checked, hint, disabled = false, onchange }: Props = $props();
</script>

<label class="switch" for={id} title={hint}>
  <input
    {id}
    name={id}
    class="switch-input"
    type="checkbox"
    role="switch"
    {checked}
    {disabled}
    aria-describedby={hint ? `${id}-hint` : undefined}
    onchange={(event) => {
      sfx.play('tick');
      onchange((event.currentTarget as HTMLInputElement).checked);
    }}
  />
  <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
  <span class="switch-label">{label}</span>
</label>
{#if hint}<span class="visually-hidden" id="{id}-hint">{hint}</span>{/if}

<style>
  @layer components {
    .switch {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
      cursor: pointer;
      /* The hidden input is positioned here: with no positioned ancestor nearby, its focus scrolled a clipped layout box. */
      position: relative;
    }

    .switch-input {
      position: absolute;
      top: 0;
      left: 0;
      opacity: 0;
      width: 1px;
      height: 1px;
    }

    .switch-track {
      position: relative;
      width: 44px;
      height: 24px;
      background: var(--surface-3);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-s);
      transition: background-color var(--dur-hover) var(--ease-sym);

      .switch-input:checked + & {
        background: var(--primary-depth);
        border-color: var(--primary-edge);
      }

      .switch-input:focus-visible + & {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }

      .switch-input:disabled + & {
        opacity: 0.45;
      }
    }

    .switch-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      background: var(--text-muted);
      border-radius: 2px;
      transition: transform var(--dur-pop) var(--ease-spring);

      .switch-input:checked + .switch-track & {
        background: var(--primary);
        transform: translateX(20px);
      }
    }

    .switch-label {
      font-weight: 600;
      font-size: 0.875rem;
      line-height: 1.25;
    }

    @media (max-height: 760px) {
      .switch-label {
        font-size: 0.8125rem;
      }

      .switch-track {
        width: 38px;
        height: 22px;
      }

      .switch-knob {
        width: 14px;
        height: 14px;

        .switch-input:checked + .switch-track & {
          transform: translateX(16px);
        }
      }
    }
  }
</style>
