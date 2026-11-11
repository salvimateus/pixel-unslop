<script lang="ts">
  import type { SetSize } from '../app/image-set.svelte.ts';
  import { app } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import Icon from './Icon.svelte';

  interface Props {
    /** Moves the height one pixel, or to the next whole size, as the arrow keys of the stage do. */
    onstep: (direction: 1 | -1, whole: boolean) => void;
  }

  let { onstep }: Props = $props();

  /** Whole reductions: source tiles per result tile. */
  const REDUCE: ReadonlyArray<{ step: number; label: TextKey | null }> = [
    { step: 1, label: 'set.quickOriginal' },
    { step: 2, label: null },
    { step: 3, label: null },
    { step: 4, label: null },
  ];
  /** Whole enlargements: each tile becomes a block of k by k pixels. */
  const ENLARGE: readonly number[] = [2, 3, 4];

  const piece = $derived.by(() => {
    void app.set.version;
    void app.set.liveVersion;
    const object = app.set.selected;
    if (!object) return null;
    return {
      id: object.id,
      name: object.name,
      size: object.size,
      height: object.height,
      limit: app.set.limitOf(object),
      rows: object.prepared?.rows ?? 0,
      empty: object.output === null,
      backgroundKept: object.backgroundKept,
      reference: object.reference,
    };
  });

  function isActive(size: SetSize, step: number): boolean {
    return size.kind === 'whole' && Math.abs(size.step - step) < 1e-9;
  }

  function quick(step: number): void {
    if (!piece || isActive(piece.size, step)) return;
    app.set.setSize(piece.id, { kind: 'whole', step });
    sfx.play('tick');
  }

  function onHeightChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value.replace(',', '.'));
    if (!piece) return;
    if (!Number.isFinite(value) || value < 1) {
      input.value = String(piece.height);
      return;
    }
    if (value > piece.limit) app.toast(t('set.heightMaxToast', { max: piece.limit }), 'info');
    app.set.setHeight(piece.id, value);
    input.value = String(app.set.selected?.height ?? piece.height);
    sfx.play('tick');
  }

  function onHeightKey(event: KeyboardEvent): void {
    const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    onstep(direction, event.shiftKey);
  }
</script>

{#if piece?.reference}
  <section class="controls is-ref" aria-labelledby="set-piece-title">
    <div class="controls-head">
      <h2 class="piece-title" id="set-piece-title"><span class="visually-hidden">{t('set.selected')}: </span>{piece.name}</h2>
      <span class="ref-tag"><Icon name="lock" size={14} />{t('set.reference')}</span>
    </div>
    <p class="ref-note">{t('set.referenceNote')}</p>
    <div class="piece-actions">
      <button type="button" class="mini-btn" onclick={() => app.setReference(piece.id, false)} disabled={app.loading}>
        <Icon name="image" size={16} />
        {t('set.useAsPiece')}
      </button>
      <button type="button" class="mini-btn remove" title="{t('set.remove')} (Delete)" onclick={() => app.removeObject(piece.id)} disabled={app.loading} aria-keyshortcuts="Delete">
        <Icon name="trash" size={16} />
        {t('set.remove')}
      </button>
    </div>
  </section>
{:else if piece}
  <section class="controls" aria-labelledby="set-piece-title">
    <div class="controls-head">
      <h2 class="piece-title" id="set-piece-title"><span class="visually-hidden">{t('set.selected')}: </span>{piece.name}</h2>
      {#if !piece.empty}
        <span class="height-readout">
          <label class="hint" for="set-height">{t('set.height')}</label>
          <input
            id="set-height"
            name="set-height"
            class="number-input height-number"
            type="number"
            inputmode="numeric"
            min="1"
            max={piece.limit}
            step="1"
            value={piece.height}
            title="{t('set.heightHint')} {t('set.heightMax', { max: piece.limit })}"
            aria-describedby="set-height-hint"
            onchange={onHeightChange}
            onkeydown={onHeightKey}
          />
          <span class="hint">{t('set.heightUnit')}</span>
        </span>
      {/if}
    </div>

    {#if piece.empty}
      <p class="empty-note"><Icon name="alert" size={16} />{t('set.empty')}</p>
    {:else}
      <div class="quick-rows">
        <span class="hint quick-label" id="set-reduce-label">{t('set.reduce')}</span>
        <div class="segmented quick" role="group" aria-labelledby="set-reduce-label">
          {#each REDUCE as option (option.step)}
            <button type="button" aria-pressed={isActive(piece.size, option.step)} onclick={() => quick(option.step)}>{option.label ? t(option.label) : `1/${option.step}`}</button>
          {/each}
        </div>
        <span class="hint quick-label" id="set-enlarge-label">{t('set.enlarge')}</span>
        <div class="segmented quick is-enlarge" role="group" aria-labelledby="set-enlarge-label" aria-describedby="set-enlarge-hint">
          {#each ENLARGE as factor (factor)}
            {@const fits = piece.rows * factor <= piece.limit}
            <button
              type="button"
              aria-pressed={isActive(piece.size, 1 / factor)}
              disabled={!fits}
              title={fits ? t('set.enlargeTo', { factor, h: piece.rows * factor }) : t('set.enlargeTooBig', { factor, max: piece.limit })}
              onclick={() => quick(1 / factor)}>{factor}x</button
            >
          {/each}
        </div>
      </div>
      <p class="hint enlarge-hint" id="set-enlarge-hint">{t('set.enlargeHint')}</p>
      <p class="visually-hidden" id="set-height-hint">{t('set.heightHint')} {t('set.heightMax', { max: piece.limit })}</p>
    {/if}

    {#if piece.backgroundKept}
      <p class="bg-note" role="status"><Icon name="image" size={16} /><span>{t('set.bgKeptNote')}</span></p>
    {/if}

    <div class="piece-actions is-three">
      <button type="button" class="mini-btn" onclick={() => app.editObject(piece.id)} disabled={app.loading}>
        <Icon name="pencil" size={16} />
        {t('set.edit')}
      </button>
      <button type="button" class="mini-btn" title={t('set.useAsReference')} onclick={() => app.setReference(piece.id, true)} disabled={app.loading}>
        <Icon name="lock" size={16} />
        <span class="visually-hidden">{t('set.useAsReference')}:</span>
        {t('set.reference')}
      </button>
      <button type="button" class="mini-btn remove" title="{t('set.remove')} (Delete)" onclick={() => app.removeObject(piece.id)} disabled={app.loading} aria-keyshortcuts="Delete">
        <Icon name="trash" size={16} />
        {t('set.remove')}
      </button>
    </div>
  </section>
{:else}
  <p class="hint select-hint">{t('set.selectHint')}</p>
{/if}

<style>
  @layer components {
    .controls {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--surface-sunken);
      border: 2px solid var(--primary-depth);
      border-radius: var(--radius-m);
    }

    .controls-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-2);
    }

    .piece-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2);

      &.is-three {
        grid-template-columns: repeat(3, auto);
        justify-content: space-between;
        gap: 4px;

        & .mini-btn {
          padding: 0 5px;
          font-size: 0.75rem;
        }
      }
    }

    .controls.is-ref {
      border-color: var(--teal);
      border-style: dashed;
    }

    .ref-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      font-weight: 700;
      font-size: 0.75rem;
    }

    .ref-note {
      color: var(--text-muted);
      font-size: 0.8125rem;
      line-height: 1.3;
    }

    .piece-title {
      min-width: 0;
      overflow: hidden;
      font-size: 0.9375rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mini-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-height: 30px;
      padding: 0 var(--space-2);
      color: var(--text-muted);
      font: 600 0.8125rem/1 var(--font-display);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
      transition:
        color var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface-3);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
    }

    .remove:hover:not(:disabled) {
      color: var(--danger-text);
    }

    .quick-rows {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 6px var(--space-2);
    }

    .quick-label {
      font-size: 0.75rem;
    }

    .enlarge-hint {
      font-size: 0.75rem;
      line-height: 1.3;
    }

    .quick {
      display: grid;
      grid-template-columns: 1.7fr repeat(3, minmax(0, 1fr));

      &.is-enlarge {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      & button:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }

      & button {
        min-height: 30px;
        padding: 0 2px;
        font-family: var(--font-body);
        font-variant-numeric: tabular-nums;
        font-size: 0.8125rem;
      }
    }

    .height-readout {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .height-number {
      width: 64px;
      min-height: 32px;
      font-family: var(--font-body);
      text-align: right;
    }

    .bg-note {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--space-2);
      padding: var(--space-1) var(--space-2);
      color: var(--text);
      background: color-mix(in oklch, var(--danger), var(--surface-sunken) 82%);
      border-left: 3px solid var(--danger);
      border-radius: var(--radius-s);
      font-size: 0.75rem;
      line-height: 1.3;

      & :global(.icon) {
        margin-top: 1px;
        color: var(--danger-text);
      }
    }

    .empty-note {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--danger-text);
      font-size: 0.875rem;
    }

    @media (max-height: 760px) {
      .controls {
        gap: 6px;
        padding: 6px var(--space-2);
      }

      .bg-note {
        line-height: 1.2;
      }
    }

    .select-hint {
      padding: var(--space-2) 0;
    }
  }
</style>
