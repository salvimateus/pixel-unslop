<script lang="ts">
  import { untrack } from 'svelte';
  import { t, type TextKey } from '../app/i18n.ts';
  import { activeLocale } from '../app/locale.svelte.ts';
  import * as sfx from '../app/sfx.ts';
  import { prefersReducedMotion } from '../app/state.svelte.ts';
  import { TUNING } from '../app/tuning.ts';
  import { loopSeam, type SeamReport, type SeamVerdict } from '../core/loop.ts';
  import { PARAMS } from '../core/params.ts';
  import type { Sprite } from '../core/types.ts';
  import type { PreviewBackground } from './clean-scene.ts';
  import Icon from './Icon.svelte';
  import { spriteThumb } from './sprite-thumb.ts';
  import { bakeMask, bakeSprite, STAGE_COLORS } from './stage-renderer.ts';

  interface Props {
    frames: readonly Sprite[];
    /** A change measures the seam again. */
    version: number;
    /** Frames still arrive: the verdict waits for them. */
    waiting: boolean;
    background: PreviewBackground;
    firstLabel: string;
    lastLabel: string;
    oncompare?: () => void;
    onremovelast?: () => void;
    onfind?: () => void;
  }

  let { frames, version, waiting, background, firstLabel, lastLabel, oncompare, onremovelast, onfind }: Props = $props();

  const VERDICT_TEXT: Record<SeamVerdict, TextKey> = {
    repeat: 'loop.verdict.repeat',
    smooth: 'loop.verdict.smooth',
    bump: 'loop.verdict.bump',
    jump: 'loop.verdict.jump',
  };

  const VERDICT_HINT: Record<SeamVerdict, TextKey> = {
    repeat: 'loop.hint.repeat',
    smooth: 'loop.hint.smooth',
    bump: 'loop.hint.bump',
    jump: 'loop.hint.jump',
  };

  let report = $state.raw<SeamReport | null>(null);
  let diffCanvas: HTMLCanvasElement | undefined = $state();
  let popping = $state(false);
  /** The last verdict that was shown, so only a change to smooth celebrates, never the first report. */
  let lastVerdict: SeamVerdict | null = null;

  const minFrames = PARAMS.loop.minFrames;
  const enough = $derived(frames.length >= minFrames);
  const verdict = $derived(!waiting && enough ? (report?.verdict ?? null) : null);
  const ratioText = $derived(report ? new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1 }).format(report.ratio) : '');

  $effect(() => {
    void version;
    const list = frames;
    if (list.length < minFrames) {
      report = null;
      return;
    }
    const timer = setTimeout(() => {
      try {
        report = loopSeam(list);
      } catch {
        // Frames of different sizes while the container changes: the next change measures again.
        report = null;
      }
    }, TUNING.anim.seamCheckMs);
    return () => clearTimeout(timer);
  });

  /** The difference: the first frame, faint, with the tiles that change at the seam on top. */
  $effect(() => {
    const canvas = diffCanvas;
    const first = frames[0];
    const seam = report;
    void version;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!first) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = first.cols;
    canvas.height = first.rows;
    ctx.globalAlpha = TUNING.anim.seamDiffBaseAlpha;
    ctx.drawImage(bakeSprite(first), 0, 0);
    ctx.globalAlpha = 1;
    if (seam && seam.cols === first.cols && seam.rows === first.rows) {
      ctx.drawImage(bakeMask(seam.cols, seam.rows, seam.changed, STAGE_COLORS.danger), 0, 0);
    }
  });

  $effect(() => {
    const next = verdict;
    untrack(() => {
      if (next === null) return;
      const before = lastVerdict;
      lastVerdict = next;
      if (next !== 'smooth' || before === null || before === 'smooth') return;
      sfx.play('lock');
      if (!prefersReducedMotion()) popping = true;
    });
  });
</script>

<div class="seam">
  <h3 class="seam-title">{t('loop.title')}</h3>
  {#if frames.length > 0}
    <button
      type="button"
      class="seam-compare"
      title={t('loop.compareHint')}
      disabled={!oncompare || frames.length < 2}
      onclick={() => oncompare?.()}
    >
      <span class="seam-figures">
        <span class="seam-figure">
          <span class="seam-view bg-{background}">
            <canvas class="seam-canvas" use:spriteThumb={frames.at(-1) ?? null} aria-hidden="true"></canvas>
          </span>
          <span class="seam-caption">{t('loop.last')} <span class="seam-label">{lastLabel}</span></span>
        </span>
        <span class="seam-figure">
          <span class="seam-view bg-{background}">
            <canvas class="seam-canvas" use:spriteThumb={frames[0] ?? null} aria-hidden="true"></canvas>
          </span>
          <span class="seam-caption">{t('loop.first')} <span class="seam-label">{firstLabel}</span></span>
        </span>
        <span class="seam-figure">
          <span class="seam-view bg-{background}">
            <canvas class="seam-canvas" bind:this={diffCanvas} aria-hidden="true"></canvas>
          </span>
          <span class="seam-caption">{t('loop.difference')}<span class="seam-label" aria-hidden="true">&nbsp;</span></span>
        </span>
      </span>
      {#if oncompare}
        <span class="seam-compare-label"><Icon name="compare" size={16} />{t('loop.compare')}</span>
      {/if}
    </button>
  {/if}

  {#if waiting}
    <p class="hint seam-state" role="status">{t('loop.waiting')}</p>
  {:else if !enough}
    <p class="hint seam-state" role="status">{t('loop.tooFew', { min: minFrames })}</p>
  {:else}
    <p class="seam-verdict is-{verdict ?? 'none'}" class:is-pop={popping} role="status" onanimationend={() => (popping = false)}>
      {#if verdict}
        <Icon name={verdict === 'smooth' ? 'check' : 'alert'} size={16} />
        <span>{t(VERDICT_TEXT[verdict])}</span>
      {/if}
    </p>
    {#if verdict}
      <p class="hint">{t(VERDICT_HINT[verdict], { ratio: ratioText })}</p>
    {/if}
  {/if}

  {#if (verdict === 'repeat' && onremovelast) || onfind}
    <div class="seam-actions">
      {#if verdict === 'repeat' && onremovelast}
        <button type="button" class="btn btn-quiet seam-btn" onclick={onremovelast}>
          <Icon name="trash" size={18} />
          {t('loop.removeLast')}
        </button>
      {/if}
      {#if onfind}
        <button
          type="button"
          class="btn seam-btn"
          class:btn-primary={verdict === 'bump' || verdict === 'jump'}
          title={t('loop.findHint')}
          disabled={waiting || !enough}
          onclick={onfind}
        >
          <Icon name="sparkle" size={18} />
          {t('loop.find')}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  @layer components {
    .seam {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
    }

    .seam-title {
      color: var(--text-muted);
      font-size: 0.875rem;
      font-weight: 700;
    }

    .seam-compare {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
      padding: var(--space-2);
      color: var(--text);
      text-align: left;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      transition: border-color var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        border-color: var(--line-strong);
      }

      &:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }

      &:disabled {
        cursor: default;
      }
    }

    .seam-figures {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-2);
    }

    .seam-figure {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-1);
      min-width: 0;
    }

    .seam-view {
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      place-items: center;
      aspect-ratio: 1;
      padding: 2px;
      border: 2px solid var(--line);
      border-radius: var(--radius-s);

      &.bg-checker {
        background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 12px 12px;
      }

      &.bg-dark {
        background: var(--preview-dark);
      }

      &.bg-light {
        background: var(--preview-light);
      }
    }

    .seam-canvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }

    .seam-caption {
      display: grid;
      color: var(--text);
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }

    .seam-label {
      color: var(--text-muted);
      font-size: 0.6875rem;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
    }

    .seam-compare-label {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .seam-verdict {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 1.5rem;
      font-size: 0.9375rem;
      font-weight: 700;
      transform-origin: left center;

      &.is-smooth {
        color: var(--primary);
      }

      &.is-bump,
      &.is-repeat {
        color: var(--yellow);
      }

      &.is-jump {
        color: var(--danger-text);
      }

      &.is-pop {
        animation: seam-pop var(--dur-modal) var(--ease-spring);
      }
    }

    .seam-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .seam-btn {
      min-width: 0;
      min-height: 36px;
      padding: var(--space-1) var(--space-3);
      font-size: 0.9375rem;
      line-height: 1.15;
      text-align: center;
      text-wrap: balance;
      white-space: normal;
    }

    @keyframes seam-pop {
      50% {
        transform: scale(1.08);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .seam-verdict.is-pop {
        animation: none;
      }
    }
  }
</style>
