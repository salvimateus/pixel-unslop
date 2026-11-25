<script lang="ts">
  import { TRANSPARENT, toHex } from '../core/color.ts';
  import type { ListVariant, ReplacedColor, ReplacedColorList } from '../app/color-list.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import ColorListPanel from './ColorListPanel.svelte';
  import ColorTargetChooser from './ColorTargetChooser.svelte';
  import { toleranceSteps } from './ToleranceSlider.svelte';

  interface Props {
    list: ReplacedColorList;
    variant: ListVariant;
    /** The picker of the stage is on: a click picks the color under the pointer as a source. */
    picking: boolean;
    ontogglepick: () => void;
    /** The swatches of the target chooser: the colors of the journey. */
    colors: ReadonlyArray<{ color: number; count: number }>;
    /** The new color of every pending source. The owner adds the entries. */
    onchoose: (to: number) => void;
    /** After each change of the list, for a view that does not follow its owner. The tolerance builds nothing. */
    onchange?: () => void;
  }

  let { list, variant, picking, ontogglepick, colors, onchoose, onchange }: Props = $props();

  const HINTS: Record<ListVariant, { hint: TextKey; pick: TextKey }> = {
    frames: { hint: 'replaceColor.hint', pick: 'replaceColor.pickHint' },
    image: { hint: 'replaceColor.imageHint', pick: 'replaceColor.imagePickHint' },
    set: { hint: 'replaceColor.setHint', pick: 'replaceColor.setPickHint' },
  };

  const texts = $derived(HINTS[variant]);
  const currentSteps = $derived(toleranceSteps(list.tolerance));
  const sources = $derived(list.pending.map((entry) => entry.color));

  function targetName(color: number): string {
    return color === TRANSPARENT ? t('palette.transparent') : toHex(color);
  }

  function labelOf({ from, to, tolerance }: ReplacedColor): string {
    return `${t('replaceColor.chip', { value: toleranceSteps(tolerance) })}. ${t('replaceColor.remove', { from: toHex(from), to: targetName(to) })}`;
  }

  function remove(entry: ReplacedColor): void {
    list.remove(entry.from);
    sfx.play('undo');
    onchange?.();
  }

  function clear(): void {
    list.clear();
    sfx.play('undo');
    onchange?.();
  }

  function cancel(): void {
    if (list.cancel()) sfx.play('tick');
  }
</script>

<ColorListPanel
  id="replace-colors"
  title={t('replaceColor.title')}
  icon="swap"
  pickLabel={t('replaceColor.pick')}
  pickTitle={t(texts.pick)}
  pickKey="C"
  {picking}
  {ontogglepick}
  hint={sources.length > 0 && !list.choosing ? t('replaceColor.groupHint') : picking ? t('replaceColor.pickingHint') : t(texts.hint)}
  listLabel={t('replaceColor.listLabel')}
  entries={list.entries}
  keyOf={(entry) => entry.from}
  {labelOf}
  onremove={remove}
  onclear={clear}
  tolerance={list.tolerance}
  ontolerance={(value, commit) => list.setTolerance(value, commit)}
  toleranceHint={t('replaceColor.toleranceHint')}
  nextHint={t('replaceColor.next')}
>
  {#if sources.length > 0}
    <ColorTargetChooser {colors} {sources} choosing={list.choosing} customId="replace-target" {onchoose} oncancel={cancel} ondrop={(color) => list.dropPending(color)} />
  {/if}
  {#snippet chip({ from, to, tolerance }: ReplacedColor)}
    {@const steps = toleranceSteps(tolerance)}
    <span class="chip-swatch" style:--swatch={toHex(from)} aria-hidden="true"></span>
    <span class="chip-arrow" aria-hidden="true">→</span>
    <span class="chip-swatch" class:is-clear={to === TRANSPARENT} style:--swatch={to === TRANSPARENT ? undefined : toHex(to)} aria-hidden="true"></span>
    {#if steps !== currentSteps}<span class="chip-badge" aria-hidden="true">{steps}</span>{/if}
  {/snippet}
</ColorListPanel>
