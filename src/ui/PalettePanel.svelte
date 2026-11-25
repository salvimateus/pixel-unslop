<script lang="ts">
  import { TRANSPARENT, toHex } from '../core/color.ts';
  import { t } from '../app/i18n.ts';
  import ColorTargetChooser from './ColorTargetChooser.svelte';
  import Icon from './Icon.svelte';
  import SwatchGrid from './SwatchGrid.svelte';

  interface Props {
    colors: ReadonlyArray<{ color: number; count: number }>;
    ink: number;
    onselect: (color: number) => void;
    /** "Replace this color everywhere": `to` may be TRANSPARENT. */
    onswap: (from: number, to: number) => void;
    ondelete: (color: number) => void;
  }

  let { colors, ink, onselect, onswap, ondelete }: Props = $props();

  let menu: HTMLDivElement;
  let menuFor = $state<number | null>(null);
  let swapFrom = $state<number | null>(null);

  const countLabel = $derived(colors.length === 1 ? t('palette.countOne') : t('palette.count', { count: colors.length }));

  export function cancelSwap(): boolean {
    if (swapFrom === null) return false;
    swapFrom = null;
    return true;
  }

  function chooseTarget(color: number): void {
    const from = swapFrom;
    swapFrom = null;
    if (from !== null && color !== from) onswap(from, color);
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
    <ColorTargetChooser {colors} sources={[swapFrom]} choosing customId="swap-color" onchoose={chooseTarget} oncancel={() => (swapFrom = null)} />
  {:else}
    <SwatchGrid {colors} selected={ink} customId="custom-color" onchoose={onselect} onmenu={onSwatchMenu} onpreview={onselect} />
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
    }

    @keyframes swap-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
  }
</style>
