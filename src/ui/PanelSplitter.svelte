<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../app/i18n.ts';
  import { TUNING } from '../app/tuning.ts';
  import { keepPanelWidth, panelWidth, resetPanelWidth, setPanelWidth } from './panel-width.svelte.ts';

  /*
   * The resize handle of a side panel. Put it as a child of the panel (`position: relative`). The panel's parent is
   * the screen grid: the handle sets `--panel-size` on it, and the last track reads
   * `var(--panel-size, <default width>)`. The column before the panel is the stage, which keeps
   * TUNING.ui.panel.stageMinPx.
   */

  interface Drag {
    pointerId: number;
    startX: number;
    startW: number;
    /** Screen pixels per CSS pixel of the panel: a CSS zoom on the page scales the pointer moves. */
    scale: number;
  }

  let handle: HTMLDivElement;
  let panel: HTMLElement | null = null;
  let workspace = $state.raw<HTMLElement | null>(null);
  let shown = $state(0);
  let max = $state<number>(TUNING.ui.panel.minPx);
  let drag: Drag | null = null;
  let dragging = $state(false);

  const min = TUNING.ui.panel.minPx;
  const applied = $derived.by(() => {
    const wanted = panelWidth();
    return wanted === null ? null : clamp(wanted);
  });
  const value = $derived(Math.round(applied ?? shown));

  function clamp(px: number): number {
    return Math.round(Math.min(max, Math.max(min, px)));
  }

  /** The largest width: a share of the screen, and never so wide that the stage gets narrower than its minimum. */
  function measure(): void {
    if (!panel || !workspace) return;
    const { maxShare, stageMinPx } = TUNING.ui.panel;
    const stage = panel.previousElementSibling;
    const room = panel.offsetWidth + (stage instanceof HTMLElement ? stage.offsetWidth : 0) - stageMinPx;
    max = Math.max(min, Math.floor(Math.min(workspace.clientWidth * maxShare, room)));
    shown = panel.offsetWidth;
  }

  $effect(() => {
    const target = workspace;
    if (!target) return;
    if (applied === null) target.style.removeProperty('--panel-size');
    else target.style.setProperty('--panel-size', `${applied}px`);
  });

  onMount(() => {
    panel = handle.parentElement;
    workspace = panel?.parentElement ?? null;
    if (!panel || !workspace) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(panel);
    const target = workspace;
    return () => {
      observer.disconnect();
      target.style.removeProperty('--panel-size');
    };
  });

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !panel) return;
    // No text selection and no native drag, which the file drop of the window would take for a file.
    event.preventDefault();
    handle.focus({ preventScroll: true });
    measure();
    handle.setPointerCapture(event.pointerId);
    const startW = panel.offsetWidth;
    drag = { pointerId: event.pointerId, startX: event.clientX, startW, scale: panel.getBoundingClientRect().width / startW || 1 };
    dragging = true;
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = clamp(drag.startW - (event.clientX - drag.startX) / drag.scale);
    if (next !== panelWidth()) setPanelWidth(next, false);
  }

  function endDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    dragging = false;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    keepPanelWidth();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const { stepPx, bigStepPx } = TUNING.ui.panel;
    const step = event.shiftKey ? bigStepPx : stepPx;
    let next: number;
    // The panel is on the right: Left makes it wider.
    if (event.key === 'ArrowLeft') next = value + step;
    else if (event.key === 'ArrowRight') next = value - step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else return;
    event.preventDefault();
    setPanelWidth(clamp(next), true);
  }
</script>

<!-- A focusable separator is the ARIA window splitter: it takes the pointer and the arrow keys. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={handle}
  class="panel-splitter"
  class:is-dragging={dragging}
  role="separator"
  aria-orientation="vertical"
  aria-label={t('panel.resize')}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuetext={t('panel.width', { px: value })}
  title={t('panel.resizeHint')}
  tabindex="0"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  ondblclick={resetPanelWidth}
  onkeydown={onKeyDown}
></div>

<style>
  @layer components {
    .panel-splitter {
      --splitter-hit: 12px;
      position: absolute;
      inset-block: 0;
      /* Centered on the 2px left border of the panel. */
      left: calc(1px - var(--splitter-hit) / 2);
      z-index: 3;
      width: var(--splitter-hit);
      cursor: col-resize;
      touch-action: none;

      &::before {
        content: '';
        position: absolute;
        inset-block: 0;
        left: 50%;
        width: 4px;
        background: var(--primary);
        border-radius: 2px;
        opacity: 0;
        translate: -50% 0;
        transition: opacity var(--dur-hover) var(--ease-sym);
      }

      &:hover::before {
        opacity: 0.6;
      }

      &.is-dragging::before {
        opacity: 1;
      }

      &:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: -2px;
        border-radius: var(--radius-s);

        &::before {
          background: var(--focus);
          opacity: 1;
        }
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .panel-splitter::before {
        transition: none;
      }
    }
  }
</style>
