<script lang="ts">
  import { toHex } from '../core/color.ts';
  import { EngineError } from '../app/engine.ts';
  import { trimOrNull } from '../app/image-set.svelte.ts';
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { isDesktop, revealFile, savePng, type SaveResult } from '../app/platform.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import Burst from './Burst.svelte';
  import Dialog from './Dialog.svelte';
  import FileNameField from './FileNameField.svelte';
  import SizeDelta from './SizeDelta.svelte';
  import ToggleSwitch from './ToggleSwitch.svelte';
  import Icon from './Icon.svelte';
  import { sparkColors } from './stage-renderer.ts';

  let phase = $state<'choose' | 'saving' | 'done'>('choose');
  let saved = $state.raw<Exclude<SaveResult, { status: 'cancelled' }> | null>(null);
  let savedName = $state('');
  let confetti = $state(0);
  /** The base name that the user typed, or null for the suggested one. */
  let customBase = $state<string | null>(null);
  let nameInvalid = $state(false);
  /** Both encodes of the open dialog, made once in the worker so the sizes show at once when the switch moves. */
  let encoded = $state.raw<{ plain: Uint8Array; optimized: Uint8Array } | null>(null);
  let encodeRun = 0;
  /** The size that the export writes: the sprite cropped to its opaque tiles. Null when no tile is opaque. */
  const output = $derived.by(() => {
    void app.editVersion;
    if (!app.exportOpen || !app.result) return null;
    const full = app.session.composed();
    const sprite = trimOrNull(full);
    return sprite ? { cols: sprite.cols, rows: sprite.rows, trimmed: sprite.cols !== full.cols || sprite.rows !== full.rows } : null;
  });

  const cols = $derived(output?.cols ?? 0);
  const rows = $derived(output?.rows ?? 0);
  const empty = $derived(app.exportOpen && output === null && app.result !== null);
  const suggestedBase = $derived(`${app.source?.name ?? 'image'}-pixel-${cols}x${rows}`);
  const baseName = $derived(customBase ?? suggestedBase);
  const fileName = $derived(`${baseName}.png`);
  const confettiColors = $derived.by(() => {
    const palette = app.result?.palette ?? new Uint32Array(0);
    return [...Array.from(palette.subarray(0, 8), (color) => toHex(color)), ...sparkColors()];
  });

  $effect(() => {
    if (app.exportOpen) {
      phase = 'choose';
      saved = null;
      customBase = null;
      nameInvalid = false;
      void encode();
    }
  });

  const activeBytes = $derived(encoded ? (app.optimizePng ? encoded.optimized : encoded.plain) : null);

  /** The composed sprite cropped to the box of its opaque tiles: the export never writes an empty border. */
  function exportSprite() {
    return trimOrNull(app.session.composed());
  }

  async function encode(): Promise<void> {
    const run = ++encodeRun;
    encoded = null;
    if (!app.result) return;
    const sprite = exportSprite();
    if (!sprite) return;
    try {
      const [plain, optimized] = await Promise.all([app.engine.exportPng(sprite, { optimize: false }), app.engine.exportPng(sprite, { optimize: true })]);
      if (run === encodeRun) encoded = { plain, optimized };
    } catch (error) {
      if (run !== encodeRun) return;
      sfx.play('error');
      app.toast(error instanceof EngineError ? app.errorText(error) : t('error.save'), 'error');
    }
  }

  function close(): void {
    if (phase === 'saving') return;
    app.exportOpen = false;
  }

  async function save(): Promise<void> {
    const sprite = exportSprite();
    if (!app.result || !sprite || phase === 'saving' || nameInvalid) return;
    phase = 'saving';
    const name = fileName;
    try {
      const png = activeBytes ?? (await app.track(app.engine.exportPng(sprite, { optimize: app.optimizePng })));
      const outcome = await savePng(png, name);
      if (outcome.status === 'cancelled') {
        phase = 'choose';
        return;
      }
      saved = outcome;
      savedName = outcome.status === 'saved' ? (outcome.path.split(/[\\/]/).pop() ?? name) : name;
      phase = 'done';
      app.markExported();
      sfx.play('saved');
      confetti++;
    } catch (error) {
      phase = 'choose';
      sfx.play('error');
      app.toast(error instanceof EngineError ? app.errorText(error) : t('error.save'), 'error');
    }
  }

  async function openFolder(): Promise<void> {
    if (saved?.status !== 'saved') return;
    try {
      await revealFile(saved.path);
    } catch {
      app.toast(t('error.internal'), 'error');
    }
  }
</script>

<Dialog open={app.exportOpen} labelledby="export-title" onclose={close}>
  <div class="dialog-body export">
    {#if phase !== 'done'}
      <h2 id="export-title" class="export-title">{t('export.title')}</h2>
      <div class="summary">
        {#if empty}
          <p class="empty-note" role="alert"><Icon name="alert" size={18} />{t('export.empty')}</p>
        {:else}
          <span class="summary-dims">{t('export.dims', { w: cols, h: rows })}</span>
          <p class="hint">{t('rule.pixel')}</p>
          <p class="hint">{output?.trimmed ? t('export.trimmed') : t('export.trimRule')}</p>
        {/if}
      </div>
      <div class="optimize">
        <ToggleSwitch id="export-optimize" label={t('export.optimize')} checked={app.optimizePng} disabled={phase === 'saving'} onchange={(on) => app.setOptimizePng(on)} />
        <p class="hint">{t('export.optimizeHint')}</p>
        <p class="file-size" aria-live="polite">
          <span class="hint">{t('export.fileSizeLabel')}</span>
          <SizeDelta before={encoded?.plain.length ?? null} after={encoded?.optimized.length ?? null} optimize={app.optimizePng} />
        </p>
      </div>
      <div class="file-name">
        <span class="hint">{t('export.fileName')}</span>
        <FileNameField id="export-file" base={baseName} disabled={phase === 'saving'} onrename={(next) => (customBase = next)} oninvalid={(invalid) => (nameInvalid = invalid)} />
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-quiet" onclick={close} disabled={phase === 'saving'}>{t('export.cancel')}</button>
        <button type="button" class="btn btn-primary btn-big" onclick={save} disabled={phase === 'saving' || !app.result || empty || nameInvalid}>
          <Icon name="download" size={20} />
          {phase === 'saving' ? t('export.saving') : t('export.save')}
        </button>
      </div>
    {:else}
      <div class="done">
        <Burst trigger={confetti} count={TUNING.ui.confettiCount} colors={confettiColors} kind="confetti" />
        <span class="done-badge"><Icon name="check" size={40} /></span>
        <h2 id="export-title" class="export-title">{t('export.done')}</h2>
        {#if saved?.status === 'saved'}
          <p class="done-text">{t('export.savedTo', { path: saved.path })}</p>
        {:else if saved?.status === 'downloaded'}
          <p class="done-text">{t('export.downloaded')}</p>
          <a class="download-link" href={saved.url} download={savedName}>
            <Icon name="download" size={18} />
            {t('export.downloadLink', { name: savedName })}
          </a>
        {/if}
        <div class="dialog-actions done-actions">
          {#if isDesktop && saved?.status === 'saved'}
            <button type="button" class="btn btn-quiet" onclick={openFolder}>
              <Icon name="folder" size={18} />
              {t('export.openFolder')}
            </button>
          {/if}
          <button type="button" class="btn btn-quiet" onclick={close}>{t('export.keepEditing')}</button>
          <button type="button" class="btn btn-primary" onclick={() => app.startOver()}>
            <Icon name="image" size={18} />
            {t('export.another')}
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

    .summary {
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3) var(--space-4);
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
    }

    .empty-note {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      color: var(--danger-text);

      & :global(.icon) {
        flex: none;
        margin-top: 2px;
      }
    }

    .summary-dims {
      font: 700 1.375rem/1.1 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .optimize {
      display: grid;
      gap: var(--space-1);
    }

    .file-size {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      margin-top: var(--space-1);
    }

    .file-name {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2);
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

    .download-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--teal);
      font-weight: 600;
      text-underline-offset: 3px;
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
