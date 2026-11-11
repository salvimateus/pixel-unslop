<script lang="ts">
  import { TRANSPARENT, fromHex, toHex } from '../core/color.ts';
  import { t } from '../app/i18n.ts';
  import { TUNING } from '../app/tuning.ts';
  import Icon from './Icon.svelte';

  interface Props {
    colors: ReadonlyArray<{ color: number; count: number }>;
    ink: number;
    onselect: (color: number) => void;
    onswap: (from: number, to: number) => void;
    ondelete: (color: number) => void;
  }

  let { colors, ink, onselect, onswap, ondelete }: Props = $props();

  let menu: HTMLDivElement;
  let menuFor = $state<number | null>(null);
  let swapFrom = $state<number | null>(null);
  let customValue = $state('#ffffff');

  const shown = $derived(colors.slice(0, TUNING.ui.maxSwatches));
  const hidden = $derived(colors.length - shown.length);
  const countLabel = $derived(colors.length === 1 ? t('palette.countOne') : t('palette.count', { count: colors.length }));

  export function cancelSwap(): boolean {
    if (swapFrom === null) return false;
    swapFrom = null;
    return true;
  }

  function choose(color: number): void {
    if (swapFrom !== null) {
      const from = swapFrom;
      swapFrom = null;
      if (color !== from) onswap(from, color);
      return;
    }
    onselect(color);
  }

  function openMenu(color: number, anchor: HTMLElement): void {
    if (swapFrom !== null) return;
    menuFor = color;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.showPopover();
    menu.querySelector('button')?.focus({ preventScroll: true });
  }

  function onSwatchMenu(event: MouseEvent, color: number): void {
    event.preventDefault();
    openMenu(color, event.currentTarget as HTMLElement);
  }

  function closeMenu(): void {
    if (menu.matches(':popover-open')) menu.hidePopover();
  }

  function startSwap(): void {
    if (menuFor === null) return;
    swapFrom = menuFor;
    closeMenu();
  }

  function deleteColor(): void {
    if (menuFor === null) return;
    const color = menuFor;
    closeMenu();
    ondelete(color);
  }

  function onCustomInput(): void {
    const color = fromHex(customValue);
    if (color !== null && swapFrom === null) onselect(color);
  }

  function onCustomChange(): void {
    const color = fromHex(customValue);
    if (color !== null) choose(color);
  }
</script>

<section class="palette" aria-labelledby="palette-title">
  <header class="palette-head">
    <h2 class="section-title" id="palette-title">{t('palette.title')}</h2>
    <span class="palette-count">{countLabel}</span>
  </header>

  <div class="ink-row">
    <span class="ink-swatch" class:is-clear={ink === TRANSPARENT} style:--swatch={ink === TRANSPARENT ? 'transparent' : toHex(ink)}></span>
    <span class="ink-text">
      <span class="hint">{t('palette.ink')}</span>
      <span class="ink-hex">{ink === TRANSPARENT ? t('palette.transparent') : toHex(ink)}</span>
    </span>
    {#if ink !== TRANSPARENT}
      <button
        type="button"
        class="icon-btn ink-more"
        aria-label={t('palette.options', { hex: toHex(ink) })}
        title={t('palette.options', { hex: toHex(ink) })}
        aria-haspopup="menu"
        onclick={(event) => openMenu(ink, event.currentTarget)}
      >
        <Icon name="more" />
      </button>
    {/if}
  </div>

  {#if swapFrom !== null}
    <div class="swap-banner" role="status">
      <span class="ink-swatch small" style:--swatch={toHex(swapFrom)}></span>
      <p>{t('palette.swapPick', { hex: toHex(swapFrom) })}</p>
      <button type="button" class="btn btn-quiet swap-cancel" onclick={() => (swapFrom = null)}>{t('palette.cancel')}</button>
    </div>
  {/if}

  <div class="swatches" class:is-swapping={swapFrom !== null}>
    <button
      type="button"
      class="swatch is-clear"
      aria-pressed={ink === TRANSPARENT}
      aria-label={t('palette.transparent')}
      title={t('palette.transparent')}
      onclick={() => choose(TRANSPARENT)}
      disabled={swapFrom !== null}
    ></button>
    {#each shown as entry (entry.color)}
      <button
        type="button"
        class="swatch"
        class:is-source={entry.color === swapFrom}
        style:--swatch={toHex(entry.color)}
        aria-pressed={ink === entry.color}
        aria-label={t('palette.swatch', { hex: toHex(entry.color), count: entry.count })}
        title={t('palette.swatch', { hex: toHex(entry.color), count: entry.count })}
        onclick={() => choose(entry.color)}
        oncontextmenu={(event) => onSwatchMenu(event, entry.color)}
      ></button>
    {/each}
    <label class="swatch swatch-custom" title={t('palette.custom')}>
      <Icon name="plus" size={16} />
      <input id="custom-color" name="custom-color" class="visually-hidden" type="color" bind:value={customValue} aria-label={t('palette.custom')} oninput={onCustomInput} onchange={onCustomChange} />
    </label>
  </div>
  {#if hidden > 0}
    <p class="hint">{t('palette.more', { count: hidden })}</p>
  {/if}

  <div class="swatch-menu" popover="auto" role="menu" bind:this={menu} ontoggle={(event) => {
    if ((event as ToggleEvent).newState === 'closed') menuFor = null;
  }}>
    <button type="button" class="menu-item" role="menuitem" onclick={startSwap}>
      <Icon name="swap" size={18} />
      {t('palette.swap')}
    </button>
    <button type="button" class="menu-item is-danger" role="menuitem" onclick={deleteColor}>
      <Icon name="trash" size={18} />
      {t('palette.delete')}
    </button>
  </div>
</section>

<style>
  @layer components {
    .palette {
      display: grid;
      gap: var(--space-3);
    }

    .palette-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
    }

    .palette-count {
      color: var(--text-muted);
      font-size: 0.875rem;
      font-variant-numeric: tabular-nums;
    }

    .ink-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2);
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .ink-swatch {
      width: 36px;
      height: 36px;
      flex: none;
      background: var(--swatch);
      border: 2px solid var(--hairline-strong);
      border-radius: var(--radius-s);
      box-shadow: 0 3px 0 var(--depth);

      &.small {
        width: 22px;
        height: 22px;
      }
    }

    .is-clear {
      background-color: transparent;
      background-image: conic-gradient(var(--checker-a) 25%, var(--checker-b) 0 50%, var(--checker-a) 0 75%, var(--checker-b) 0);
      background-size: 12px 12px;
    }

    .ink-text {
      display: grid;
      flex: 1;
      line-height: 1.2;
    }

    .ink-hex {
      font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
      font-size: 0.9375rem;
    }

    .swap-banner {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      font-size: 0.875rem;
      background: color-mix(in oklch, var(--teal), transparent 85%);
      border: 2px solid var(--teal);
      border-radius: var(--radius-m);
      animation: swap-in var(--dur-pop) var(--ease-out);

      & p {
        flex: 1;
      }
    }

    .swap-cancel {
      min-height: 30px;
      padding: 0 var(--space-2);
      font-size: 0.8125rem;
    }

    .swatches {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(30px, 1fr));
      gap: 6px;
      max-height: 196px;
      padding: 2px 2px 4px;
      overflow-y: auto;
    }

    .swatch {
      position: relative;
      aspect-ratio: 1;
      background: var(--swatch);
      border: 2px solid var(--hairline);
      border-radius: var(--radius-s);
      box-shadow: 0 3px 0 var(--depth);
      transition: transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        transform: translateY(-2px);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &[aria-pressed='true'] {
        border-color: var(--text);
        outline: 2px solid var(--primary);
        outline-offset: 1px;
      }

      &:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      &.is-source {
        outline: 2px dashed var(--teal);
        outline-offset: 1px;
      }

      .is-swapping &:not(:disabled):not(.is-source) {
        animation: swatch-wiggle 900ms var(--ease-sym) infinite;
      }
    }

    .swatch-custom {
      display: grid;
      place-items: center;
      color: var(--text-muted);
      background: var(--surface-2);
      border-style: dashed;
      cursor: pointer;

      &:hover {
        color: var(--text);
        transform: translateY(-2px);
      }

      &:focus-within {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }
    }

    .swatch-menu {
      position: fixed;
      inset: auto;
      margin: 0;
      padding: var(--space-1);
      min-width: 240px;
      color: var(--text);
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-m);
      box-shadow: 0 4px 0 var(--depth);

      &:popover-open {
        display: grid;
        animation: swap-in var(--dur-pop) var(--ease-out);
      }
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 38px;
      padding: 0 var(--space-3);
      text-align: left;
      border-radius: var(--radius-s);

      &:hover,
      &:focus-visible {
        background: var(--surface-3);
      }

      &.is-danger {
        color: var(--danger-text);
      }
    }

    @media (max-height: 760px) {
      .palette {
        gap: var(--space-2);
      }

      .ink-row {
        padding: 4px var(--space-2);
      }

      .ink-swatch {
        width: 28px;
        height: 28px;
      }

      .swatches {
        max-height: 116px;
      }
    }

    @keyframes swap-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }

    @keyframes swatch-wiggle {
      0%,
      100% {
        transform: rotate(0);
      }
      25% {
        transform: rotate(-4deg);
      }
      75% {
        transform: rotate(4deg);
      }
    }
  }
</style>
