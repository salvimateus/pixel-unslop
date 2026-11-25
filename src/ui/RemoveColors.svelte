<script lang="ts">
  import { toHex } from '../core/color.ts';
  import type { ListVariant, RemovedColor, RemovedColorList } from '../app/color-list.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import ColorListPanel from './ColorListPanel.svelte';
  import { toleranceSteps } from './ToleranceSlider.svelte';

  interface Props {
    list: RemovedColorList;
    variant: ListVariant;
    /** The picker of the stage is on: a click adds the color under the pointer. */
    picking: boolean;
    ontogglepick: () => void;
    /** The pointer is on a spot that does not touch the border: a click there erases the color inside the drawing too. */
    inside?: boolean;
    /** After each change of the list, for a view that does not follow its owner. The tolerance builds nothing. */
    onchange?: () => void;
  }

  let { list, variant, picking, ontogglepick, inside = false, onchange }: Props = $props();

  const TEXTS: Record<ListVariant, { hint: TextKey; inside: TextKey; pick: TextKey }> = {
    frames: { hint: 'removeColor.hint', inside: 'removeColor.insideHint', pick: 'removeColor.pickHint' },
    image: { hint: 'removeColor.imageListHint', inside: 'removeColor.imageInsideHint', pick: 'removeColor.imagePickHint' },
    set: { hint: 'removeColor.setHint', inside: 'removeColor.setInsideHint', pick: 'removeColor.setPickHint' },
  };

  const texts = $derived(TEXTS[variant]);
  const currentSteps = $derived(toleranceSteps(list.tolerance));
  const hint = $derived(picking && inside ? t(texts.inside) : picking ? t('removeColor.pickingHint') : t(texts.hint));

  function labelOf({ color, tolerance, scope }: RemovedColor): string {
    const where = scope === 'all' ? ` ${t('removeColor.insideLabel')}.` : '';
    return `${t('removeTolerance.chip', { value: toleranceSteps(tolerance) })}.${where} ${t('removeColor.restore', { color: toHex(color) })}`;
  }

  function restore(entry: RemovedColor): void {
    list.restore(entry.color);
    sfx.play('undo');
    onchange?.();
  }

  function clear(): void {
    list.clear();
    sfx.play('undo');
    onchange?.();
  }
</script>

<ColorListPanel
  id="remove-colors"
  title={t('removeColor.title')}
  icon="colorErase"
  pickLabel={t('removeColor.pick')}
  pickTitle={t(texts.pick)}
  pickKey="R"
  {picking}
  {ontogglepick}
  {hint}
  warn={picking && inside}
  listLabel={t('removeColor.listLabel')}
  entries={list.entries}
  keyOf={(entry) => entry.color}
  {labelOf}
  onremove={restore}
  onclear={clear}
  tolerance={list.tolerance}
  ontolerance={(value, commit) => list.setTolerance(value, commit)}
  nextHint={t('removeTolerance.next')}
>
  {#snippet chip({ color, tolerance, scope }: RemovedColor)}
    {@const steps = toleranceSteps(tolerance)}
    <span class="chip-swatch" style:--swatch={toHex(color)} aria-hidden="true"></span>
    <span class="chip-hex">{toHex(color)}</span>
    {#if steps !== currentSteps}<span class="chip-badge" aria-hidden="true">{steps}</span>{/if}
    {#if scope === 'all'}<span class="chip-badge is-inside" aria-hidden="true">{t('removeColor.inside')}</span>{/if}
  {/snippet}
</ColorListPanel>
