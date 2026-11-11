<script lang="ts">
  import { tick } from 'svelte';
  import type { ElasticMode, GridFit } from '../core/types.ts';
  import { PARAMS } from '../core/params.ts';
  import { app } from '../app/state.svelte.ts';
  import { formatDecimal, t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import { clamp } from './camera.ts';
  import { holdRepeat } from './hold-repeat.ts';
  import { revealInPanel } from './reveal.ts';
  import Icon from './Icon.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';

  interface Props {
    /** The width and height of the art pixel on screen now. */
    period: { x: number; y: number };
    /** A new width and height of the art pixel, with the live preview of the Grade screen. */
    onsize: (x: number, y: number) => void;
    /** While a slider is pressed the grid shows at any zoom, as with the size slider. */
    onpress: (on: boolean) => void;
    /** Shows a new shift of the full grid at once, before the worker answers. */
    onnudgepreview: (dx: number, dy: number) => void;
    /** The fit that the worker gave for a change of this drawer. */
    onfit: (fit: GridFit | null) => void;
  }

  let { period, onsize, onpress, onnudgepreview, onfit }: Props = $props();

  const ELASTIC_MODES: ReadonlyArray<{ mode: ElasticMode; label: TextKey }> = [
    { mode: 'auto', label: 'grid.elasticAuto' },
    { mode: 'on', label: 'grid.elasticOn' },
    { mode: 'off', label: 'grid.elasticOff' },
  ];
  const ARROWS: ReadonlyArray<{ key: string; dx: number; dy: number; label: TextKey; area: string }> = [
    { key: 'up', dx: 0, dy: -1, label: 'grid.nudgeUp', area: 'up' },
    { key: 'left', dx: -1, dy: 0, label: 'grid.nudgeLeft', area: 'left' },
    { key: 'right', dx: 1, dy: 0, label: 'grid.nudgeRight', area: 'right' },
    { key: 'down', dx: 0, dy: 1, label: 'grid.nudgeDown', area: 'down' },
  ];
  const KEY_MOVES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  const fit = $derived(app.fit);
  const mean = $derived((period.x + period.y) / 2);
  const notSquare = $derived(Math.abs(round2(period.x) - round2(period.y)) >= 0.01);
  /** The shape slider works on the log of width / height, so "mais alto" and "mais largo" have the same travel. */
  const shapeLimit = Math.log(TUNING.grid.shapeRatioMax);
  const shape = $derived(clamp(Math.log(period.x / period.y), -shapeLimit, shapeLimit));
  const elasticActive = $derived(app.manualGrid === null && (fit?.notes.includes('elastic') ?? false));
  const shifted = $derived(app.nudge.x !== 0 || app.nudge.y !== 0);

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  async function setElastic(mode: ElasticMode): Promise<void> {
    if (mode === app.elastic) return;
    sfx.play('tick');
    onfit(await app.setElastic(mode));
  }

  function nudge(dx: number, dy: number, large: boolean): void {
    const step = large ? TUNING.grid.nudgeStepShift : TUNING.grid.nudgeStep;
    const limit = TUNING.grid.nudgeMax;
    const x = round2(clamp(app.nudge.x + dx * step, -limit, limit));
    const y = round2(clamp(app.nudge.y + dy * step, -limit, limit));
    if (x === app.nudge.x && y === app.nudge.y) return;
    sfx.play('tick');
    onnudgepreview(x - app.nudge.x, y - app.nudge.y);
    void app.setNudge(x, y).then(onfit);
  }

  function onArrowKey(event: KeyboardEvent): void {
    const move = KEY_MOVES[event.key];
    if (!move) return;
    event.preventDefault();
    nudge(move[0], move[1], event.shiftKey);
  }

  function resetNudge(): void {
    if (!shifted) return;
    sfx.play('tick');
    onnudgepreview(-app.nudge.x, -app.nudge.y);
    void app.setNudge(0, 0).then(onfit);
  }

  /** Off: the grid is square again, at the same size. */
  let stretchBlock: HTMLElement | undefined = $state();

  function setStretched(on: boolean): void {
    app.stretched = on;
    if (!on && notSquare) onsize(round2(mean), round2(mean));
    // The shape slider, its labels and the "Quadrado" button show in full.
    if (on) void tick().then(() => revealInPanel(stretchBlock ?? null));
  }

  /** The ratio of width to height, with the mean side kept: the size control stays where it is. */
  function setShape(logRatio: number): void {
    const r = Math.exp(logRatio);
    onsize((2 * mean * r) / (1 + r), (2 * mean) / (1 + r));
  }

  function onShapeInput(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    // Near the center the slider snaps to a square pixel.
    setShape(Math.abs(value) < TUNING.grid.shapeSnap ? 0 : value);
  }

  function makeSquare(): void {
    if (!notSquare) return;
    sfx.play('tick');
    onpress(true);
    onpress(false);
    setShape(0);
  }
</script>

<div class="advanced-body">
  <section class="field" aria-labelledby="nudge-label">
    <h3 class="section-title" id="nudge-label">{t('grid.nudge')}</h3>
    <p class="hint" id="nudge-hint">{t('grid.nudgeHint')}</p>
    <div class="nudge-row">
      <div class="nudge-pad" role="group" aria-labelledby="nudge-label" aria-describedby="nudge-hint">
        {#each ARROWS as arrow (arrow.key)}
          <button
            type="button"
            class="icon-btn nudge-arrow is-{arrow.area}"
            aria-label={t(arrow.label)}
            title={t(arrow.label)}
            disabled={!fit}
            use:holdRepeat={{ step: (large) => nudge(arrow.dx, arrow.dy, large) }}
            onkeydown={onArrowKey}
          >
            <Icon name="back" size={18} />
          </button>
        {/each}
      </div>
      <div class="nudge-state">
        <p class="nudge-value" aria-live="polite">
          <span class="nudge-label">{t('grid.nudgeShift')}</span>
          <span>X {formatDecimal(app.nudge.x)} {t('grid.pixelSizeUnit')}</span>
          <span>Y {formatDecimal(app.nudge.y)} {t('grid.pixelSizeUnit')}</span>
        </p>
        <button type="button" class="btn btn-quiet nudge-reset" onclick={resetNudge} disabled={!shifted}>{t('grid.nudgeReset')}</button>
      </div>
    </div>
    <p class="hint">{t('grid.nudgeKeys')}</p>
  </section>

  <section class="field" aria-labelledby="elastic-label">
    <h3 class="section-title" id="elastic-label">{t('grid.elastic')}</h3>
    <div class="segmented" role="group" aria-labelledby="elastic-label">
      {#each ELASTIC_MODES as option (option.mode)}
        <button type="button" aria-pressed={app.elastic === option.mode} onclick={() => setElastic(option.mode)} disabled={!fit}>{t(option.label)}</button>
      {/each}
    </div>
    <p class="elastic-state" class:is-on={elasticActive} aria-live="polite">
      <Icon name="grid" size={16} />{elasticActive ? t('grid.elasticNowOn') : t('grid.elasticNowOff')}
    </p>
    <p class="hint">{t('grid.elasticHint', { min: PARAMS.elastic.minPeriod })}</p>
  </section>

  <section class="field" bind:this={stretchBlock}>
    <ToggleSwitch id="grid-stretched" label={t('grid.stretched')} checked={app.stretched} onchange={setStretched} />
    <p class="hint">{t('grid.stretchedHint')}</p>
    {#if app.stretched}
      <label class="section-title shape-title" for="pixel-shape">{t('grid.shape')}</label>
      <input
        id="pixel-shape"
        name="pixel-shape"
        class="shape-slider"
        type="range"
        min={-shapeLimit}
        max={shapeLimit}
        step="0.001"
        value={shape}
        disabled={!fit}
        aria-valuetext={t('grid.shapeValue', { w: formatDecimal(period.x), h: formatDecimal(period.y) })}
        oninput={onShapeInput}
        onpointerdown={() => onpress(true)}
        onpointerup={() => onpress(false)}
        onkeydown={() => onpress(true)}
        onkeyup={() => onpress(false)}
        onblur={() => onpress(false)}
      />
      <div class="shape-ends" aria-hidden="true">
        <span>{t('grid.shapeTall')}</span>
        <span>{t('grid.shapeSquare')}</span>
        <span>{t('grid.shapeWide')}</span>
      </div>
      <div class="shape-result">
        <p class="shape-value" aria-live="polite">{t('grid.shapeValue', { w: formatDecimal(period.x), h: formatDecimal(period.y) })}</p>
        <button type="button" class="btn btn-quiet square-btn" onclick={makeSquare} disabled={!notSquare}>{t('grid.shapeSquareButton')}</button>
      </div>
    {:else}
      <p class="hint">{t('grid.stretchedOff')}</p>
    {/if}
  </section>
</div>

<style>
  @layer components {
    .advanced-body {
      display: grid;
      gap: var(--space-5);
      padding-top: var(--space-4);
    }

    .nudge-row {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }

    .nudge-pad {
      display: grid;
      grid-template-areas:
        '. up .'
        'left . right'
        '. down .';
      grid-template-columns: repeat(3, 36px);
      grid-template-rows: repeat(3, 36px);
      flex: none;
    }

    .nudge-arrow {
      width: 36px;
      height: 36px;
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      touch-action: none;

      &.is-up {
        grid-area: up;
        rotate: 90deg;
      }

      &.is-right {
        grid-area: right;
        rotate: 180deg;
      }

      &.is-down {
        grid-area: down;
        rotate: 270deg;
      }

      &.is-left {
        grid-area: left;
      }

      &:active:not(:disabled) {
        background: var(--primary);
        color: var(--on-primary);
        border-color: var(--primary-edge);
      }
    }

    .nudge-state {
      display: grid;
      justify-items: start;
      gap: var(--space-2);
      min-width: 0;
    }

    .nudge-value {
      display: grid;
      font: 700 1rem/1.3 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .nudge-label {
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .nudge-reset {
      min-height: 32px;
      font-size: 0.875rem;
    }

    .elastic-state {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: 0.875rem;

      &.is-on {
        color: var(--teal);
      }

      & :global(.icon) {
        flex: none;
        margin-top: 1px;
      }
    }

    .shape-title {
      margin-top: var(--space-2);
    }

    .shape-slider {
      width: 100%;
      height: 28px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .shape-ends {
      display: flex;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 0.75rem;
    }

    .shape-result {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .shape-value {
      font: 700 0.9375rem/1.3 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .square-btn {
      min-height: 32px;
      font-size: 0.875rem;
    }
  }
</style>
