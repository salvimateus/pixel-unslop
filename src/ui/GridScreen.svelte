<script lang="ts">
  import { untrack } from 'svelte';
  import type { ElasticMode, GridFit, Selection } from '../core/types.ts';
  import { app } from '../app/state.svelte.ts';
  import { formatDecimal, t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import { clamp } from './camera.ts';
  import { GridScene, type FitEffect } from './grid-scene.ts';
  import CleanupPresets from './CleanupPresets.svelte';
  import Icon from './Icon.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import Stage from './Stage.svelte';
  import type { StagePointer } from './stage-renderer.ts';

  const ELASTIC_MODES: ReadonlyArray<{ mode: ElasticMode; label: TextKey }> = [
    { mode: 'auto', label: 'grid.elasticAuto' },
    { mode: 'on', label: 'grid.elasticOn' },
    { mode: 'off', label: 'grid.elasticOff' },
  ];
  const QUALITY_LABELS: Record<1 | 2 | 3, TextKey> = { 1: 'grid.quality1', 2: 'grid.quality2', 3: 'grid.quality3' };

  let stage: Stage | undefined = $state();
  let cellPx = $state(0);
  let dragStart: { x: number; y: number } | null = null;
  let lastQuality = 0;

  const source = $derived(app.source);
  const scene = $derived(source ? new GridScene(source.bitmap, source.width, source.height) : null);
  const fit = $derived(app.fit);
  const sizeX = $derived(app.fixedPeriod?.x ?? fit?.axes.x.period ?? 1);
  const sizeY = $derived(app.fixedPeriod?.y ?? fit?.axes.y.period ?? 1);
  const sizeMin = TUNING.grid.pixelSizeMin;
  const sizeMax = $derived(source ? Math.max(sizeMin + 1, Math.min(TUNING.grid.pixelSizeMax, Math.min(source.width, source.height) / 2)) : TUNING.grid.pixelSizeMax);
  const weak = $derived(fit?.notes.includes('weak-grid') ?? false);
  const native = $derived(fit?.notes.includes('native-resolution') ?? false);

  $effect(() => {
    const current = scene;
    if (!current) return;
    current.onLock = () => sfx.play('lock');
    const first = untrack(() => app.fit);
    if (!first) return;
    lastQuality = first.quality;
    current.setFit(first, first.quality === 3 ? 'scan-lock' : 'scan');
    updateCell();
  });

  function updateCell(): void {
    cellPx = scene?.cellScreenSize() ?? 0;
  }

  /** The grid flashes and locks only when the fit becomes perfect. */
  function showFit(next: GridFit | null): void {
    if (!next || !scene) return;
    const effect: FitEffect = next.quality === 3 && lastQuality !== 3 ? 'lock' : 'none';
    lastQuality = next.quality;
    scene.setFit(next, effect);
    updateCell();
  }

  function clampToImage(p: StagePointer): { x: number; y: number } {
    return { x: clamp(p.ix, 0, source?.width ?? 0), y: clamp(p.iy, 0, source?.height ?? 0) };
  }

  function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }): Selection {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function onDown(p: StagePointer): boolean {
    if (!scene || !source) return false;
    if (p.ix < 0 || p.iy < 0 || p.ix > source.width || p.iy > source.height) return false;
    dragStart = clampToImage(p);
    scene.setDrag(boxFrom(dragStart, dragStart), { x: p.sx, y: p.sy });
    return true;
  }

  function onMove(p: StagePointer): void {
    if (!dragStart || !scene) return;
    scene.setDrag(boxFrom(dragStart, clampToImage(p)), { x: p.sx, y: p.sy });
  }

  async function onUp(p: StagePointer): Promise<void> {
    if (!dragStart || !scene) return;
    const box = boxFrom(dragStart, clampToImage(p));
    dragStart = null;
    if (box.w < TUNING.grid.minBoxSourcePx || box.h < TUNING.grid.minBoxSourcePx) {
      scene.setDrag(null, null);
      return;
    }
    scene.setDrag(box, null);
    sfx.play('tick');
    const next = await app.fitBox(box);
    if (!next) {
      scene.setDrag(null, null);
      return;
    }
    showFit(next);
    scene.settleBox(box);
    if (next.notes.includes('harmonic-down')) app.toast(t('grid.adjustedDown'), 'info');
    else if (next.notes.includes('harmonic-up')) app.toast(t('grid.adjustedUp'), 'info');
  }

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  async function setSize(x: number, y: number): Promise<void> {
    const nx = round2(clamp(x, sizeMin, sizeMax));
    const ny = round2(clamp(y, sizeMin, sizeMax));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    sfx.play('tick');
    showFit(await app.setPixelSize(nx, ny));
  }

  function onSliderInput(event: Event): void {
    const value = Math.exp(Number((event.currentTarget as HTMLInputElement).value));
    void setSize(value, value);
  }

  function onSliderKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? TUNING.grid.sliderStepShift : TUNING.grid.sliderStep;
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const value = sizeX + direction * step;
    void setSize(value, value);
  }

  function onNumberChange(axis: 'both' | 'x' | 'y', event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      input.value = (axis === 'y' ? sizeY : sizeX).toFixed(2);
      return;
    }
    if (axis === 'both') void setSize(value, value);
    else if (axis === 'x') void setSize(value, sizeY);
    else void setSize(sizeX, value);
  }

  async function detect(): Promise<void> {
    sfx.play('tick');
    showFit(await app.detectAuto());
  }

  async function setElastic(mode: ElasticMode): Promise<void> {
    if (mode === app.elastic) return;
    sfx.play('tick');
    showFit(await app.setElastic(mode));
  }

  function onNudgeKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? TUNING.grid.nudgeStepShift : TUNING.grid.nudgeStep;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const limit = TUNING.grid.nudgeMax;
    const x = round2(clamp(app.nudge.x + move[0], -limit, limit));
    const y = round2(clamp(app.nudge.y + move[1], -limit, limit));
    sfx.play('tick');
    void app.setNudge(x, y).then(showFit);
  }

  function resetNudge(): void {
    if (app.nudge.x === 0 && app.nudge.y === 0) return;
    void app.setNudge(0, 0).then(showFit);
  }

  function zoomToGrid(): void {
    if (!stage || cellPx <= 0) return;
    stage.zoomBy(TUNING.zoom.gridFirstCellPx / cellPx);
  }
</script>

<section class="grid-screen">
  <div class="grid-stage">
    {#if scene}
      <Stage
        bind:this={stage}
        {scene}
        label={t('grid.stageLabel')}
        cursor="crosshair"
        onprimarydown={onDown}
        onprimarymove={onMove}
        onprimaryup={onUp}
        onviewchange={updateCell}
      >
        {#if weak || native}
          <p class="stage-banner" class:is-warn={weak}>
            <Icon name="info" size={18} />
            {weak ? t('grid.weak') : t('grid.native')}
          </p>
        {/if}
        {#if fit && cellPx > 0 && cellPx < TUNING.grid.minCellPx}
          <button type="button" class="zoom-hint" onclick={zoomToGrid}>
            <Icon name="zoomIn" size={18} />
            {t('grid.zoomHint')}
          </button>
        {/if}
        <div class="stage-zoom">
          <button type="button" class="icon-btn" aria-label={t('clean.zoomOut')} title={t('clean.zoomOut')} onclick={() => stage?.zoomBy(1 / TUNING.zoom.buttonStep)}>
            <Icon name="zoomOut" />
          </button>
          <button type="button" class="icon-btn" aria-label={t('clean.zoomIn')} title={t('clean.zoomIn')} onclick={() => stage?.zoomBy(TUNING.zoom.buttonStep)}>
            <Icon name="zoomIn" />
          </button>
          <button type="button" class="icon-btn" aria-label={t('clean.fit')} title={t('clean.fit')} onclick={() => stage?.fitView()}>
            <Icon name="fit" />
          </button>
        </div>
      </Stage>
    {/if}
    <ProgressPill />
  </div>

  <aside class="grid-panel">
    <div class="grid-panel-scroll">
      <header class="grid-head">
        <h1 class="grid-title">{t('grid.title')}</h1>
        <p class="hint">{t('grid.help')}</p>
      </header>

      {#if fit}
        <div class="readout">
          <p class="readout-count">{t('grid.count', { cols: fit.cols, rows: fit.rows })}</p>
          <div class="meter" role="img" aria-label={t('grid.quality', { stars: fit.quality })}>
            {#each [1, 2, 3] as star (star)}
              <span class="meter-star" class:is-on={star <= fit.quality}>
                <Icon name="star" size={20} filled={star <= fit.quality} />
              </span>
            {/each}
            <span class="meter-label">{t(QUALITY_LABELS[fit.quality])}</span>
          </div>
        </div>
      {/if}

      <div class="field size-field">
        <div class="size-row">
          <label class="section-title" for="pixel-size-slider">{t('grid.pixelSize')}</label>
          <span class="size-readout">
            <input
              id="pixel-size-number"
              name="pixel-size"
              class="number-input size-number"
              type="number"
              inputmode="decimal"
              min={sizeMin}
              max={sizeMax}
              step="0.01"
              value={sizeX.toFixed(2)}
              aria-label={t('grid.pixelSize')}
              onchange={(event) => onNumberChange('both', event)}
            />
            <span class="size-unit">{t('grid.pixelSizeUnit')}</span>
          </span>
        </div>
        <input
          id="pixel-size-slider"
          name="pixel-size-slider"
          class="size-slider"
          type="range"
          min={Math.log(sizeMin)}
          max={Math.log(sizeMax)}
          step="0.0005"
          value={Math.log(sizeX)}
          aria-valuetext="{formatDecimal(sizeX)} {t('grid.pixelSizeUnit')}"
          aria-describedby="pixel-size-hint"
          oninput={onSliderInput}
          onkeydown={onSliderKey}
        />
        <p class="hint size-hint" id="pixel-size-hint">{t('grid.pixelSizeHint')}</p>
      </div>

      <button type="button" class="btn btn-quiet auto-btn" onclick={detect} disabled={!source}>
        <Icon name="wand" size={18} />
        {t('grid.auto')}
      </button>

      <details class="advanced">
        <summary class="advanced-summary">{t('grid.advanced')}</summary>
        <div class="advanced-body">
          <div class="field">
            <span class="section-title" id="elastic-label">{t('grid.elastic')}</span>
            <div class="segmented" role="group" aria-labelledby="elastic-label">
              {#each ELASTIC_MODES as option (option.mode)}
                <button type="button" aria-pressed={app.elastic === option.mode} onclick={() => setElastic(option.mode)}>{t(option.label)}</button>
              {/each}
            </div>
            <p class="hint">{t('grid.elasticHint')}</p>
          </div>

          <div class="field">
            <span class="section-title" id="nudge-label">{t('grid.nudge')}</span>
            <div class="nudge-row">
              <button type="button" class="nudge-pad" aria-labelledby="nudge-label" aria-describedby="nudge-hint" onkeydown={onNudgeKey}>
                <Icon name="arrows" size={18} />
                <span class="nudge-value">{t('grid.nudgeValue', { x: formatDecimal(app.nudge.x), y: formatDecimal(app.nudge.y) })}</span>
              </button>
              <button type="button" class="btn btn-quiet nudge-reset" onclick={resetNudge}>{t('grid.nudgeReset')}</button>
            </div>
            <p class="hint" id="nudge-hint">{t('grid.nudgeHint')}</p>
          </div>

          <div class="field">
            <div class="axes">
              <label class="field">
                <span class="hint">{t('grid.sizeX')}</span>
                <input id="pixel-size-x" name="pixel-size-x" class="number-input" type="number" inputmode="decimal" min={sizeMin} max={sizeMax} step="0.01" value={sizeX.toFixed(2)} onchange={(event) => onNumberChange('x', event)} />
              </label>
              <label class="field">
                <span class="hint">{t('grid.sizeY')}</span>
                <input id="pixel-size-y" name="pixel-size-y" class="number-input" type="number" inputmode="decimal" min={sizeMin} max={sizeMax} step="0.01" value={sizeY.toFixed(2)} onchange={(event) => onNumberChange('y', event)} />
              </label>
            </div>
            <p class="hint">{t('grid.sizeAxesHint')}</p>
          </div>
        </div>
      </details>
    </div>

    <div class="grid-footer">
      <CleanupPresets hint={t('cleanup.hintBefore')} />
      <div class="grid-actions">
      <button type="button" class="btn btn-quiet" onclick={() => app.goTo('drop')}>
        <Icon name="back" size={18} />
        {t('grid.back')}
      </button>
      <button type="button" class="btn btn-primary btn-big" onclick={() => app.clean()} disabled={!fit || app.cleaning}>
        <Icon name="sparkle" size={20} />
        {t('grid.clean')}
      </button>
      </div>
    </div>
  </aside>
</section>

<style>
  @layer components {
    .grid-screen {
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--panel-w);
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    .grid-stage {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .stage-banner {
      position: absolute;
      top: var(--space-3);
      left: 50%;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: max-content;
      max-width: calc(100% - 32px);
      padding: var(--space-2) var(--space-4);
      color: var(--text);
      background: var(--surface-2);
      border: 2px solid var(--teal);
      border-radius: var(--radius-m);
      box-shadow: 0 4px 0 var(--depth);
      translate: -50% 0;
      animation: banner-in var(--dur-pop) var(--ease-out);

      &.is-warn {
        border-color: var(--yellow);
      }
    }

    .zoom-hint {
      position: absolute;
      left: 50%;
      bottom: var(--space-4);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      font: 600 0.9375rem/1 var(--font-display);
      color: var(--on-primary);
      background: var(--primary);
      border-radius: 999px;
      box-shadow: 0 4px 0 var(--primary-depth);
      translate: -50% 0;
      transition: transform var(--dur-hover) var(--ease-sym);

      &:active {
        transform: translateY(2px);
      }
    }

    .stage-zoom {
      position: absolute;
      left: var(--space-3);
      bottom: var(--space-3);
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .grid-panel {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .grid-panel-scroll {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      overflow-x: hidden;
      align-content: start;
      gap: var(--space-5);
      padding: var(--space-5);
      overflow-y: auto;
    }

    .grid-head {
      display: grid;
      gap: var(--space-2);
    }

    .grid-title {
      font-size: 1.5rem;
      text-wrap: balance;
    }

    .readout {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .readout-count {
      font: 700 1.375rem/1.1 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .meter {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .meter-star {
      color: var(--line-strong);

      &.is-on {
        color: var(--yellow);
        animation: star-pop var(--dur-modal) var(--ease-spring);
      }
    }

    .meter-label {
      margin-left: var(--space-2);
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .size-row {
      display: flex;
      white-space: nowrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .size-readout {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .size-number {
      width: 84px;
      text-align: right;
    }

    .size-unit {
      color: var(--text-muted);
    }

    .size-slider {
      width: 100%;
      height: 28px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .auto-btn {
      justify-self: start;
    }

    .advanced {
      border-top: 2px solid var(--line);
      padding-top: var(--space-3);
    }

    .advanced-summary {
      font: 600 1rem/1.4 var(--font-display);
      color: var(--text-muted);
      cursor: pointer;
      border-radius: var(--radius-s);

      &:hover {
        color: var(--text);
      }
    }

    .advanced-body {
      display: grid;
      gap: var(--space-4);
      padding-top: var(--space-4);
    }

    .nudge-row {
      display: flex;
      gap: var(--space-2);
    }

    .nudge-pad {
      flex: 1;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 40px;
      padding: 0 var(--space-3);
      color: var(--text);
      background: var(--surface-sunken);
      border: 2px dashed var(--line-strong);
      border-radius: var(--radius-m);

      &:focus-visible {
        border-style: solid;
        border-color: var(--focus);
      }
    }

    .nudge-value {
      font-variant-numeric: tabular-nums;
    }

    .nudge-reset {
      min-height: 40px;
      font-size: 0.875rem;
    }

    .axes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-3);
    }

    .grid-footer {
      display: grid;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-5) var(--space-5);
      background: var(--surface-sunken);
      border-top: 2px solid var(--line);
    }

    .grid-actions {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
    }

    @media (max-height: 760px) {
      .grid-footer {
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4) var(--space-4);
      }

      .grid-panel-scroll {
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }

      .grid-title {
        font-size: 1.25rem;
      }

      .readout {
        gap: var(--space-1);
        padding: var(--space-2) var(--space-3);
      }

      .size-number {
        width: 72px;
      }

      /* The keyboard tip stays for screen readers through aria-describedby. */
      .size-hint {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    }

    @keyframes star-pop {
      0% {
        transform: scale(0.4) rotate(-30deg);
      }
    }

    @keyframes banner-in {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
    }
  }
</style>
