<script lang="ts">
  import packageJson from '../../package.json?raw';
  import { alpha, pack, toHex } from '../core/color.ts';
  import { CoreError } from '../core/errors.ts';
  import { GIF_MAX_FPS, gifDelays } from '../core/gif.ts';
  import { PARAMS } from '../core/params.ts';
  import { fitColumns, packSheet, sheetJson, type SheetLayout } from '../core/sheet.ts';
  import { listPalette } from '../core/sprite.ts';
  import type { Sprite } from '../core/types.ts';
  import { track } from '../app/analytics.ts';
  import { EngineError } from '../app/engine.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import { isDesktop, revealFile, saveFile, saveFileSet, setDownloadFile, type OutputFile } from '../app/platform.ts';
  import * as sfx from '../app/sfx.ts';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { TUNING } from '../app/tuning.ts';
  import Burst from './Burst.svelte';
  import type { PreviewBackground } from './clean-scene.ts';
  import Dialog from './Dialog.svelte';
  import FileNameField from './FileNameField.svelte';
  import Icon from './Icon.svelte';
  import { loopFrames } from './loop-frames.ts';
  import { spriteThumb } from './sprite-thumb.ts';
  import { sparkColors } from './stage-renderer.ts';
  import ToggleSwitch from './ToggleSwitch.svelte';

  type Format = 'sheet' | 'gif';
  type Done = { status: 'saved'; path: string } | { status: 'downloaded' };

  const { name: APP_NAME, version: APP_VERSION } = JSON.parse(packageJson) as { name: string; version: string };
  const BACKGROUNDS: readonly { value: PreviewBackground; label: TextKey }[] = [
    { value: 'checker', label: 'animExport.bgTransparent' },
    { value: 'dark', label: 'animExport.bgDark' },
    { value: 'light', label: 'animExport.bgLight' },
  ];

  let phase = $state<'choose' | 'saving' | 'done'>('choose');
  let format = $state<Format>('sheet');
  /** Null follows the automatic value. */
  let columnsChoice = $state<number | null>(null);
  let scaleChoice = $state<number | null>(null);
  let gifBg = $state<PreviewBackground>('checker');
  let gifPlaying = $state(!prefersReducedMotion());
  let customBase = $state<string | null>(null);
  let nameInvalid = $state(false);
  let done = $state.raw<Done | null>(null);
  let doneName = $state('');
  let doneFolder = $state(false);
  let confetti = $state(0);

  const frames = $derived(app.anim.built.frames);
  const count = $derived(frames.length);
  const cellW = $derived(app.anim.built.cell.cols);
  const cellH = $derived(app.anim.built.cell.rows);

  const autoColumns = $derived.by(() => {
    try {
      return fitColumns(count, cellW, cellH);
    } catch {
      return count;
    }
  });
  const columns = $derived(clamp(columnsChoice ?? autoColumns, 1, Math.max(1, count)));

  const sheet = $derived.by((): { sprite: Sprite; layout: SheetLayout } | { error: string } | null => {
    if (!app.animExportOpen || count === 0) return null;
    try {
      return packSheet(frames, columns);
    } catch (error) {
      return { error: coreErrorText(error) };
    }
  });
  const sheetError = $derived(sheet && 'error' in sheet ? sheet.error : null);
  const packed = $derived(sheet && 'sprite' in sheet ? sheet : null);
  const rows = $derived(Math.ceil(count / columns));

  const longSide = $derived(Math.max(1, cellW, cellH));
  const maxScale = $derived(Math.max(1, Math.min(TUNING.anim.gifMaxScale, Math.floor(PARAMS.limits.maxExportSide / longSide))));
  const autoScale = $derived(clamp(Math.floor(TUNING.anim.gifTargetPx / longSide), 1, maxScale));
  const scale = $derived(clamp(scaleChoice ?? autoScale, 1, maxScale));
  const gifFps = $derived(Math.min(app.anim.fps, GIF_MAX_FPS));

  const suggestedBase = $derived(`${app.anim.info?.name ?? 'video'}-pixel-${cellW}x${cellH}-${count}f`);
  const baseName = $derived(customBase ?? suggestedBase);
  const extension = $derived(format === 'sheet' ? '.png' : '.gif');
  const blocked = $derived(phase === 'saving' || count === 0 || nameInvalid || (format === 'sheet' && !packed));

  const previewBg = $derived(format === 'sheet' ? app.previewBg : gifBg);

  const confettiColors = $derived.by(() => {
    const first = frames[0];
    const palette = first ? listPalette(first.pixels).filter((entry) => alpha(entry.color) === 0xff).slice(0, 8) : [];
    return [...palette.map((entry) => toHex(entry.color)), ...sparkColors()];
  });

  $effect(() => {
    if (app.animExportOpen) {
      phase = 'choose';
      format = 'sheet';
      columnsChoice = null;
      scaleChoice = null;
      gifBg = app.previewBg;
      gifPlaying = !prefersReducedMotion();
      customBase = null;
      nameInvalid = false;
      done = null;
    }
  });

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function coreErrorText(error: unknown): string {
    if (error instanceof CoreError) return t(`error.${error.code}`, { min: PARAMS.limits.minSide });
    return t('error.internal');
  }

  /** The opaque color of a CSS color token, through a one-pixel canvas so any CSS color format works. */
  function tokenColor(token: string): number {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return pack(0, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return pack(r, g, b);
  }

  function gifBackground(): number | null {
    if (gifBg === 'checker') return null;
    return tokenColor(gifBg === 'dark' ? '--preview-dark' : '--preview-light');
  }

  function close(): void {
    if (phase === 'saving') return;
    app.animExportOpen = false;
  }

  function chooseFormat(next: Format): void {
    if (next === format || phase === 'saving') return;
    format = next;
    sfx.play('tick');
  }

  function setColumns(value: number): void {
    const next = clamp(value, 1, Math.max(1, count));
    if (next !== columns) sfx.play('tick');
    columnsChoice = next;
  }

  function setScale(value: number): void {
    const next = clamp(value, 1, maxScale);
    if (next !== scale) sfx.play('tick');
    scaleChoice = next;
  }

  function numberFrom(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value);
  }

  function confirmOverwrite(names: string[]): Promise<boolean> {
    return app.confirm(t('setExport.overwrite.title'), t('setExport.overwrite.body', { names: names.join(', ') }), t('setExport.overwrite.ok'));
  }

  async function save(): Promise<void> {
    if (blocked) return;
    phase = 'saving';
    const base = baseName;
    try {
      if (format === 'sheet') await saveSheet(base);
      else await saveGif(base);
    } catch (error) {
      phase = 'choose';
      sfx.play('error');
      app.toast(error instanceof EngineError ? app.errorText(error) : error instanceof CoreError ? coreErrorText(error) : t('error.save'), 'error');
    }
  }

  async function saveSheet(base: string): Promise<void> {
    if (!packed) throw new CoreError('internal', 'No sheet to save.');
    const { sprite, layout } = packed;
    const png = await app.track(app.engine.exportPng(sprite, { optimize: app.optimizePng }));
    const pngName = `${base}.png`;
    const zipName = `${base}.zip`;
    const withJson = app.anim.sheetJson;
    if (!withJson) {
      const outcome = await saveFile(png, pngName, 'png');
      if (outcome.status === 'cancelled') {
        phase = 'choose';
        return;
      }
      app.lastAnimExport = { name: pngName, bytes: png };
      finish(outcome.status === 'saved' ? { status: 'saved', path: outcome.path } : { status: 'downloaded' }, pngName, false);
      track('export_anim', { kind: outcome.status, format: 'png', count, width: layout.width, height: layout.height, detail: app.anim.fps });
      return;
    }
    const json = sheetJson(layout, count, { image: pngName, name: base, fps: app.anim.fps, loop: app.anim.loopInGame, app: APP_NAME, version: APP_VERSION });
    const files: OutputFile[] = [
      { name: pngName, bytes: png },
      { name: `${base}.json`, bytes: new TextEncoder().encode(json) },
    ];
    const outcome = await saveFileSet(files, confirmOverwrite, zipName);
    if (outcome.status === 'cancelled') {
      phase = 'choose';
      return;
    }
    if (outcome.status === 'saved') {
      app.lastAnimExport = { name: pngName, bytes: png };
      finish({ status: 'saved', path: outcome.paths[0] ?? outcome.folder }, pngName, true);
    } else {
      const file = setDownloadFile(files, zipName);
      app.lastAnimExport = file ? { name: file.name, bytes: file.bytes } : null;
      finish({ status: 'downloaded' }, outcome.zip ?? pngName, true);
    }
    track('export_anim', { kind: outcome.status, format: outcome.status === 'downloaded' ? 'zip' : 'png', count, width: layout.width, height: layout.height, detail: app.anim.fps });
  }

  async function saveGif(base: string): Promise<void> {
    const name = `${base}.gif`;
    const fps = gifFps;
    const size = { width: cellW * scale, height: cellH * scale };
    const gif = await app.track(app.engine.exportGif(frames, { delays: gifDelays(count, fps), scale, background: gifBackground() }));
    const outcome = await saveFile(gif, name, 'gif');
    if (outcome.status === 'cancelled') {
      phase = 'choose';
      return;
    }
    app.lastAnimExport = { name, bytes: gif };
    finish(outcome.status === 'saved' ? { status: 'saved', path: outcome.path } : { status: 'downloaded' }, name, false);
    track('export_anim', { kind: outcome.status, format: 'gif', count, ...size, detail: fps });
  }

  function finish(result: Done, name: string, folder: boolean): void {
    done = result;
    doneName = name;
    doneFolder = folder;
    phase = 'done';
    app.markAnimExported();
    sfx.play('saved');
    if (!prefersReducedMotion()) confetti++;
  }

  async function openFolder(): Promise<void> {
    if (done?.status !== 'saved') return;
    try {
      await revealFile(done.path);
    } catch {
      app.toast(t('error.internal'), 'error');
    }
  }
</script>

<Dialog open={app.animExportOpen} labelledby="anim-export-title" onclose={close} wide>
  <div class="dialog-body anim-export">
    {#if phase !== 'done'}
      <h2 id="anim-export-title" class="export-title">{t('animExport.title')}</h2>

      <div class="field">
        <div class="segmented format" role="group" aria-label={t('animExport.format')}>
          <button type="button" aria-pressed={format === 'sheet'} disabled={phase === 'saving'} onclick={() => chooseFormat('sheet')}>{t('animExport.sheet')}</button>
          <button type="button" aria-pressed={format === 'gif'} disabled={phase === 'saving'} onclick={() => chooseFormat('gif')}>{t('animExport.gif')}</button>
        </div>
        <p class="hint">{format === 'sheet' ? t('animExport.sheetHint') : t('animExport.gifHint')}</p>
      </div>

      <div class="preview-row">
        <div class="preview" class:is-dark={previewBg === 'dark'} class:is-light={previewBg === 'light'}>
          {#if format === 'sheet'}
            {#if packed}
              <canvas class="preview-canvas" use:spriteThumb={packed.sprite} aria-hidden="true"></canvas>
            {/if}
          {:else if count > 0}
            <canvas class="preview-canvas" use:loopFrames={{ frames, version: app.anim.version, fps: gifFps, playing: gifPlaying }} aria-hidden="true"></canvas>
            {#if count > 1}
              <button
                type="button"
                class="icon-btn preview-toggle"
                aria-label={gifPlaying ? t('anim.pause') : t('anim.play')}
                title={gifPlaying ? t('anim.pause') : t('anim.play')}
                onclick={() => (gifPlaying = !gifPlaying)}
              >
                <Icon name={gifPlaying ? 'pause' : 'play'} size={16} />
              </button>
            {/if}
          {/if}
        </div>
        <div class="summary">
          {#if format === 'sheet'}
            {#if sheetError}
              <p class="error-note" role="alert"><Icon name="alert" size={18} />{sheetError}</p>
            {:else if packed}
              <span class="summary-dims">{t('export.dims', { w: packed.layout.width, h: packed.layout.height })}</span>
            {/if}
            <span class="hint">{t('animExport.sheetGrid', { frames: count === 1 ? t('animExport.framesOne') : t('animExport.framesMany', { count }), columns: columns === 1 ? t('animExport.columnsOne') : t('animExport.columnsMany', { count: columns }), rows: rows === 1 ? t('animExport.rowsOne') : t('animExport.rowsMany', { count: rows }) })}</span>
            <span class="hint">{t('animExport.cell', { w: cellW, h: cellH })}</span>
          {:else}
            <span class="summary-dims">{t('export.dims', { w: cellW * scale, h: cellH * scale })}</span>
            <span class="hint">{t('animExport.gifFrames', { frames: count === 1 ? t('animExport.framesOne') : t('animExport.framesMany', { count }), fps: gifFps })}</span>
            {#if app.anim.fps > GIF_MAX_FPS}
              <span class="hint warn">{t('animExport.fpsClamped', { fps: app.anim.fps, max: GIF_MAX_FPS })}</span>
            {/if}
          {/if}
        </div>
      </div>

      {#if format === 'sheet'}
        <div class="number-row">
          <label class="section-title" for="anim-export-columns">{t('animExport.columns')}</label>
          <span class="number-control">
            <button type="button" class="icon-btn step-btn" aria-label={t('animExport.columnsDown')} disabled={phase === 'saving' || columns <= 1} onclick={() => setColumns(columns - 1)}>−</button>
            <input
              id="anim-export-columns"
              name="anim-export-columns"
              class="number-input"
              type="number"
              inputmode="numeric"
              min="1"
              max={Math.max(1, count)}
              step="1"
              value={columns}
              disabled={phase === 'saving'}
              onchange={(event) => setColumns(numberFrom(event))}
            />
            <button type="button" class="icon-btn step-btn" aria-label={t('animExport.columnsUp')} disabled={phase === 'saving' || columns >= count} onclick={() => setColumns(columns + 1)}>+</button>
          </span>
        </div>

        <div class="toggles">
          <div class="toggle">
            <ToggleSwitch id="anim-export-json" label={t('animExport.json')} checked={app.anim.sheetJson} disabled={phase === 'saving'} onchange={(on) => app.anim.setSheetJson(on)} />
            <p class="hint">{t('animExport.jsonHint')}</p>
          </div>
          <div class="toggle">
            <ToggleSwitch id="anim-export-loop" label={t('animExport.loop')} checked={app.anim.loopInGame} disabled={phase === 'saving' || !app.anim.sheetJson} onchange={(on) => app.anim.setLoopInGame(on)} />
            <p class="hint">{app.anim.sheetJson ? t('animExport.loopHint') : t('animExport.loopOff')}</p>
          </div>
          <div class="toggle">
            <ToggleSwitch id="anim-export-optimize" label={t('export.optimize')} checked={app.optimizePng} disabled={phase === 'saving'} onchange={(on) => app.setOptimizePng(on)} />
            <p class="hint">{t('export.optimizeHint')}</p>
          </div>
        </div>
      {:else}
        <div class="number-row">
          <label class="section-title" for="anim-export-scale">{t('animExport.scale')}</label>
          <span class="number-control">
            <button type="button" class="icon-btn step-btn" aria-label={t('animExport.scaleDown')} disabled={phase === 'saving' || scale <= 1} onclick={() => setScale(scale - 1)}>−</button>
            <input
              id="anim-export-scale"
              name="anim-export-scale"
              class="number-input"
              type="number"
              inputmode="numeric"
              min="1"
              max={maxScale}
              step="1"
              value={scale}
              disabled={phase === 'saving'}
              onchange={(event) => setScale(numberFrom(event))}
            />
            <button type="button" class="icon-btn step-btn" aria-label={t('animExport.scaleUp')} disabled={phase === 'saving' || scale >= maxScale} onclick={() => setScale(scale + 1)}>+</button>
          </span>
        </div>

        <div class="field">
          <span class="section-title" id="anim-export-bg">{t('animExport.background')}</span>
          <div class="segmented" role="group" aria-labelledby="anim-export-bg">
            {#each BACKGROUNDS as option (option.value)}
              <button
                type="button"
                aria-pressed={gifBg === option.value}
                disabled={phase === 'saving'}
                onclick={() => {
                  gifBg = option.value;
                  sfx.play('tick');
                }}>{t(option.label)}</button
              >
            {/each}
          </div>
          {#if gifBg === 'checker'}
            <p class="hint">{t('animExport.transparentHint')}</p>
          {/if}
        </div>
      {/if}

      <div class="file-name">
        <span class="hint">{t('export.fileName')}</span>
        <FileNameField align="end" id="anim-export-file" base={baseName} {extension} disabled={phase === 'saving'} onrename={(next) => (customBase = next)} oninvalid={(invalid) => (nameInvalid = invalid)} />
      </div>
      {#if format === 'sheet' && app.anim.sheetJson}
        <p class="hint writes">{isDesktop ? t('animExport.writesFolder') : t('animExport.writesZip')}</p>
      {/if}

      <div class="dialog-actions">
        <button type="button" class="btn btn-quiet" onclick={close} disabled={phase === 'saving'}>{t('export.cancel')}</button>
        <button type="button" class="btn btn-primary btn-big" onclick={save} disabled={blocked}>
          <Icon name={isDesktop && format === 'sheet' && app.anim.sheetJson ? 'folder' : 'download'} size={20} />
          {#if phase === 'saving'}
            {t('export.saving')}
          {:else if format === 'gif'}
            {t('animExport.saveGif')}
          {:else if app.anim.sheetJson}
            {t('animExport.saveSheetJson')}
          {:else}
            {t('animExport.saveSheet')}
          {/if}
        </button>
      </div>
    {:else}
      <div class="done">
        <Burst trigger={confetti} count={TUNING.ui.confettiCount} colors={confettiColors} kind="confetti" />
        <span class="done-badge"><Icon name="check" size={40} /></span>
        <h2 id="anim-export-title" class="export-title">{t('export.done')}</h2>
        {#if done?.status === 'saved'}
          <p class="done-text">{doneFolder ? t('animExport.savedFolder', { path: done.path }) : t('export.savedTo', { path: done.path })}</p>
        {:else}
          <p class="done-text">{t('animExport.downloaded', { name: doneName })}</p>
        {/if}
        <div class="dialog-actions done-actions">
          {#if isDesktop && done?.status === 'saved'}
            <button type="button" class="btn btn-quiet" onclick={openFolder}>
              <Icon name="folder" size={18} />
              {t('export.openFolder')}
            </button>
          {/if}
          <button type="button" class="btn btn-quiet" onclick={close}>{t('animExport.close')}</button>
          <button type="button" class="btn btn-primary" onclick={() => app.startOverAnim()}>
            <Icon name="image" size={18} />
            {t('animExport.newVideo')}
          </button>
        </div>
      </div>
    {/if}
  </div>
</Dialog>

<style>
  @layer components {
    .export-title {
      font-size: 1.5rem;
    }

    .format button {
      min-height: 40px;
    }

    .preview-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      align-items: center;
      gap: var(--space-4);

      @media (max-width: 520px) {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    .preview {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      height: 160px;
      padding: var(--space-2);
      background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 12px 12px;
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      overflow: hidden;

      &.is-dark {
        background: var(--preview-dark);
      }

      &.is-light {
        background: var(--preview-light);
      }
    }

    .preview-canvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }

    .preview-toggle {
      position: absolute;
      inset-block-end: var(--space-2);
      inset-inline-end: var(--space-2);
      width: 32px;
      height: 32px;
      color: var(--text);
      background: var(--surface-2);
      border-color: var(--line);
    }

    .summary {
      display: grid;
      gap: var(--space-1);
      align-content: center;
    }

    .summary-dims {
      font: 700 1.375rem/1.1 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .warn {
      color: var(--yellow);
    }

    .error-note {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--danger-text);
      font-size: 0.875rem;

      & :global(.icon) {
        flex: none;
        margin-top: 2px;
      }
    }

    .number-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .number-control {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);

      & .number-input {
        width: 5rem;
        text-align: center;
      }
    }

    .step-btn {
      font: 700 1.25rem/1 var(--font-body);
      border-color: var(--line);
    }

    .toggles {
      display: grid;
      gap: var(--space-3);
    }

    .toggle {
      display: grid;
      gap: var(--space-1);
    }

    .file-name {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2);
    }

    .writes {
      margin-top: calc(var(--space-2) * -1);
      text-align: end;
    }

    .done {
      position: relative;
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      text-align: center;
    }

    .done-badge {
      display: grid;
      place-items: center;
      width: 76px;
      height: 76px;
      color: var(--on-primary);
      background: var(--primary);
      border: 3px solid var(--primary-edge);
      border-radius: var(--radius-l);
      box-shadow: 0 5px 0 var(--primary-depth);
      animation: badge-pop 520ms var(--ease-spring);
    }

    .done-text {
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .done-actions {
      justify-content: center;
    }

    @keyframes badge-pop {
      0% {
        transform: scale(0.2) rotate(-25deg);
        opacity: 0;
      }
    }
  }
</style>
