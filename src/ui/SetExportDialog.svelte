<script lang="ts">
  import { toHex } from '../core/color.ts';
  import { exportSprite } from '../core/pipeline.ts';
  import type { SetExportFile } from '../app/image-set.svelte.ts';
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { isDesktop, revealFile, savePngSet, type SaveSetResult } from '../app/platform.ts';
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
  let saved = $state.raw<Exclude<SaveSetResult, { status: 'cancelled' }> | null>(null);
  let confetti = $state(0);
  /** Ids of the pieces that the user cleared; every file starts checked. */
  let excluded = $state.raw(new Set<number>());
  /** Base names that the user typed, by piece id. */
  let renamed = $state.raw(new Map<number, string>());
  /** Pieces whose name field is open with a name that cannot be saved. */
  let invalid = $state.raw(new Set<number>());
  /** Both encodes of each file, made after the dialog opens, one file per task so the dialog stays responsive. */
  let encoded = $state.raw(new Map<number, { plain: Uint8Array; optimized: Uint8Array }>());
  let encodeRun = 0;

  const files = $derived.by(() => {
    void app.set.version;
    return app.setExportOpen ? app.set.exportFiles() : [];
  });
  const named = $derived(files.map((file) => ({ ...file, base: renamed.get(file.object.id) ?? file.name.replace(/\.png$/i, '') })));
  const chosen = $derived(named.filter((file) => !excluded.has(file.object.id)));
  /** Selected files that share a name; Windows file names ignore case. */
  const conflicts = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const file of chosen) seen.set(file.base.toLowerCase(), (seen.get(file.base.toLowerCase()) ?? 0) + 1);
    return new Set(chosen.filter((file) => (seen.get(file.base.toLowerCase()) ?? 0) > 1).map((file) => file.object.id));
  });
  const blocked = $derived(conflicts.size > 0 || [...invalid].some((id) => !excluded.has(id)));
  const skipped = $derived(app.set.pieces.length - files.length);
  const allChecked = $derived(files.length > 0 && chosen.length === files.length);
  const someChecked = $derived(chosen.length > 0 && chosen.length < files.length);
  const confettiColors = $derived.by(() => {
    void app.set.version;
    return [...Array.from(app.set.palette().subarray(0, 8), (color) => toHex(color)), ...sparkColors()];
  });

  $effect(() => {
    if (app.setExportOpen) {
      phase = 'choose';
      saved = null;
      excluded = new Set();
      renamed = new Map();
      invalid = new Set();
      void encodeAll();
      app.setExportSelection = () => chosen.map((file) => ({ name: `${file.base}.png`, bytes: bytesOf(file.object.id, file.sprite) }));
    } else {
      app.setExportSelection = null;
    }
  });

  function close(): void {
    if (phase === 'saving') return;
    app.setExportOpen = false;
  }

  function toggle(id: number, on: boolean): void {
    const next = new Set(excluded);
    if (on) next.delete(id);
    else next.add(id);
    excluded = next;
    sfx.play('tick');
  }

  /** Main-thread encode with the core export, so the bytes equal the CLI bytes with the same option. */
  async function encodeAll(): Promise<void> {
    const run = ++encodeRun;
    encoded = new Map();
    for (const file of app.set.exportFiles()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (run !== encodeRun || !app.setExportOpen) return;
      try {
        const entry = { plain: exportSprite(file.sprite), optimized: exportSprite(file.sprite, { optimize: true }) };
        encoded = new Map(encoded).set(file.object.id, entry);
      } catch {
        // The save encodes the file again and reports the error.
      }
    }
  }

  function bytesOf(id: number, sprite: SetExportFile['sprite']): Uint8Array {
    const entry = encoded.get(id);
    if (entry) return app.optimizePng ? entry.optimized : entry.plain;
    return exportSprite(sprite, { optimize: app.optimizePng });
  }

  const totals = $derived.by(() => {
    let plain = 0;
    let optimized = 0;
    for (const file of chosen) {
      const entry = encoded.get(file.object.id);
      if (!entry) return null;
      plain += entry.plain.length;
      optimized += entry.optimized.length;
    }
    return { plain, optimized };
  });

  function rename(id: number, base: string): void {
    const next = new Map(renamed);
    next.set(id, base);
    renamed = next;
  }

  function markInvalid(id: number, on: boolean): void {
    if (invalid.has(id) === on) return;
    const next = new Set(invalid);
    if (on) next.add(id);
    else next.delete(id);
    invalid = next;
  }

  function toggleAll(on: boolean): void {
    excluded = on ? new Set() : new Set(files.map((file) => file.object.id));
    sfx.play('tick');
  }

  /** The mixed state of "Todos" is a DOM property with no attribute. */
  function mixed(input: HTMLInputElement, value: boolean) {
    input.indeterminate = value;
    return { update: (next: boolean) => (input.indeterminate = next) };
  }

  function confirmOverwrite(names: string[]): Promise<boolean> {
    return app.confirm(t('setExport.overwrite.title'), t('setExport.overwrite.body', { names: names.join(', ') }), t('setExport.overwrite.ok'));
  }

  async function save(): Promise<void> {
    if (phase === 'saving' || chosen.length === 0 || blocked) return;
    phase = 'saving';
    try {
      // Main-thread encode with the core export, so the bytes equal the CLI bytes.
      const pngs = chosen.map((file) => ({ name: `${file.base}.png`, bytes: bytesOf(file.object.id, file.sprite) }));
      const outcome = await savePngSet(pngs, confirmOverwrite);
      if (outcome.status === 'cancelled') {
        phase = 'choose';
        return;
      }
      saved = outcome;
      phase = 'done';
      app.markSetExported();
      sfx.play('saved');
      confetti++;
    } catch {
      phase = 'choose';
      sfx.play('error');
      app.toast(t('error.save'), 'error');
    }
  }

  async function openFolder(): Promise<void> {
    if (saved?.status !== 'saved' || saved.paths.length === 0) return;
    try {
      await revealFile(saved.paths[0]);
    } catch {
      app.toast(t('error.internal'), 'error');
    }
  }
</script>

<Dialog open={app.setExportOpen} labelledby="set-export-title" onclose={close} wide>
  <div class="dialog-body set-export">
    {#if phase !== 'done'}
      <h2 id="set-export-title" class="export-title">{t('setExport.title')}</h2>
      <p class="hint">{t('setExport.body')} {t('export.trimRule')}</p>
      <section class="field" aria-labelledby="set-export-files">
        <div class="files-head">
          <h3 class="section-title" id="set-export-files">{t('setExport.files')}</h3>
          <label class="check all-check" for="set-export-all">
            <input
              id="set-export-all"
              name="set-export-all"
              type="checkbox"
              checked={allChecked}
              use:mixed={someChecked}
              disabled={phase === 'saving' || files.length === 0}
              onchange={(event) => toggleAll((event.currentTarget as HTMLInputElement).checked)}
            />
            {t('setExport.all')}
          </label>
        </div>
        <ul class="file-list">
          {#each named as file (file.object.id)}
            <li class="file-row" class:is-off={excluded.has(file.object.id)}>
              <span class="file-main">
                <input
                  class="file-check"
                  id="set-export-{file.object.id}"
                  name="set-export-{file.object.id}"
                  type="checkbox"
                  aria-label={file.base}
                  checked={!excluded.has(file.object.id)}
                  disabled={phase === 'saving'}
                  onchange={(event) => toggle(file.object.id, (event.currentTarget as HTMLInputElement).checked)}
                />
                <FileNameField
                  id="set-export-{file.object.id}"
                  base={file.base}
                  conflict={conflicts.has(file.object.id) ? t('fileName.duplicate') : null}
                  disabled={phase === 'saving'}
                  onrename={(next) => rename(file.object.id, next)}
                  oninvalid={(on) => markInvalid(file.object.id, on)}
                />
              </span>
              <span class="file-meta">
                <span class="file-dims">{t('export.dims', { w: file.sprite.cols, h: file.sprite.rows })}</span>
                <SizeDelta before={encoded.get(file.object.id)?.plain.length ?? null} after={encoded.get(file.object.id)?.optimized.length ?? null} optimize={app.optimizePng} />
              </span>
            </li>
          {/each}
        </ul>
        {#if chosen.length === 0 && files.length > 0}
          <p class="skipped"><Icon name="alert" size={16} />{t('setExport.noneSelected')}</p>
        {/if}
        {#if skipped > 0}
          <p class="skipped"><Icon name="alert" size={16} />{skipped === 1 ? t('setExport.skippedOne') : t('setExport.skipped', { count: skipped })}</p>
        {/if}
      </section>
      <div class="optimize">
        <ToggleSwitch id="set-export-optimize" label={t('export.optimize')} checked={app.optimizePng} disabled={phase === 'saving'} onchange={(on) => app.setOptimizePng(on)} />
        <p class="hint">{t('export.optimizeHint')}</p>
        {#if chosen.length > 0}
          <p class="file-size" aria-live="polite">
            <span class="hint">{t('export.total')}</span>
            <SizeDelta before={totals?.plain ?? null} after={totals?.optimized ?? null} optimize={app.optimizePng} strong />
          </p>
        {/if}
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-quiet" onclick={close} disabled={phase === 'saving'}>{t('export.cancel')}</button>
        <button type="button" class="btn btn-primary btn-big" onclick={save} disabled={phase === 'saving' || chosen.length === 0 || blocked}>
          <Icon name={isDesktop ? 'folder' : 'download'} size={20} />
          {#if phase === 'saving'}
            {t('setExport.saving')}
          {:else if chosen.length === 0}
            {t('setExport.saveNone')}
          {:else if isDesktop}
            {chosen.length === 1 ? t('setExport.saveDesktopOne') : t('setExport.saveDesktopMany', { count: chosen.length })}
          {:else}
            {chosen.length === 1 ? t('setExport.saveBrowserOne') : t('setExport.saveBrowserZip', { count: chosen.length })}
          {/if}
        </button>
      </div>
    {:else}
      <div class="done">
        <Burst trigger={confetti} count={TUNING.ui.confettiCount} colors={confettiColors} kind="confetti" />
        <span class="done-badge"><Icon name="check" size={40} /></span>
        <h2 id="set-export-title" class="export-title">{t('setExport.done')}</h2>
        {#if saved?.status === 'saved'}
          <p class="done-text">{t('setExport.savedTo', { count: saved.paths.length, folder: saved.folder })}</p>
        {:else if saved?.status === 'downloaded'}
          <p class="done-text">{saved.zip ? t('setExport.downloadedZip', { count: saved.count }) : t('export.downloaded')}</p>
        {/if}
        <div class="dialog-actions done-actions">
          {#if isDesktop && saved?.status === 'saved'}
            <button type="button" class="btn btn-quiet" onclick={openFolder}>
              <Icon name="folder" size={18} />
              {t('export.openFolder')}
            </button>
          {/if}
          <button type="button" class="btn btn-quiet" onclick={close}>{t('setExport.keepEditing')}</button>
          <button type="button" class="btn btn-primary" onclick={() => app.startOverSet()}>
            <Icon name="image" size={18} />
            {t('setExport.another')}
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

    .file-list {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      max-height: min(280px, 40dvh);
      overflow: hidden auto;
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
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

    .file-meta {
      display: grid;
      justify-items: end;
      gap: 2px;
      flex: none;
    }

    .files-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .check {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      cursor: pointer;

      & input {
        flex: none;
        width: 18px;
        height: 18px;
        accent-color: var(--primary);
        cursor: pointer;
      }
    }

    .all-check {
      font-weight: 600;
      font-size: 0.875rem;
    }

    .file-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-3);
      transition: opacity var(--dur-hover) var(--ease-sym);

      &.is-off .file-main :global(.file-name) {
        opacity: 0.55;
      }

      & + & {
        border-top: 1px solid var(--line);
      }
    }

    .file-main {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      flex: 1 1 auto;
    }

    .file-check {
      flex: none;
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .file-dims {
      flex: none;
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }

    .skipped {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--yellow);
      font-size: 0.875rem;
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
