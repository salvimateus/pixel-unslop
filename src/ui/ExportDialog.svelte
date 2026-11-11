<script lang="ts">
  import { toHex } from '../core/color.ts';
  import { PARAMS } from '../core/params.ts';
  import { EngineError } from '../app/engine.ts';
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { isDesktop, revealFile, savePng, type SaveResult } from '../app/platform.ts';
  import * as sfx from '../app/sfx.ts';
  import { readStored, writeStored } from '../app/storage.ts';
  import { TUNING } from '../app/tuning.ts';
  import Burst from './Burst.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import { sparkColors } from './stage-renderer.ts';

  type ChoiceId = '1' | '2' | '4' | '8' | '16' | 'original';

  interface Choice {
    id: ChoiceId;
    scale: number;
    label: string;
    width: number;
    height: number;
    tooBig: boolean;
  }

  const SCALES = [1, 2, 4, 8, 16] as const;
  const SCALE_KEY = 'exportScale';

  let phase = $state<'choose' | 'saving' | 'done'>('choose');
  let saved = $state.raw<Exclude<SaveResult, { status: 'cancelled' }> | null>(null);
  let savedName = $state('');
  let confetti = $state(0);
  let selected = $state<ChoiceId>((readStored(SCALE_KEY) as ChoiceId | null) ?? '1');

  const cols = $derived(app.result?.sprite.cols ?? 0);
  const rows = $derived(app.result?.sprite.rows ?? 0);
  const originalScale = $derived(app.fit ? Math.max(1, Math.round((app.fit.axes.x.period + app.fit.axes.y.period) / 2)) : 1);
  const choices = $derived.by((): Choice[] => {
    const list: Array<{ id: ChoiceId; scale: number; label: string }> = SCALES.map((scale) => ({
      id: String(scale) as ChoiceId,
      scale,
      label: scale === 1 ? t('export.scaleTrue') : t('export.scale', { k: scale }),
    }));
    list.push({ id: 'original', scale: originalScale, label: t('export.scaleOriginal') });
    return list.map((choice) => {
      const width = cols * choice.scale;
      const height = rows * choice.scale;
      return { ...choice, width, height, tooBig: Math.max(width, height) > PARAMS.limits.maxExportSide };
    });
  });
  const active = $derived(choices.find((choice) => choice.id === selected && !choice.tooBig) ?? choices[0]);
  const fileName = $derived(`${app.source?.name ?? 'image'}-pixel-${cols}x${rows}${active && active.scale > 1 ? `-x${active.scale}` : ''}.png`);
  const confettiColors = $derived.by(() => {
    const palette = app.result?.palette ?? new Uint32Array(0);
    return [...Array.from(palette.subarray(0, 8), (color) => toHex(color)), ...sparkColors()];
  });

  $effect(() => {
    if (app.exportOpen) {
      phase = 'choose';
      saved = null;
    }
  });

  function close(): void {
    if (phase === 'saving') return;
    app.exportOpen = false;
  }

  function pick(choice: Choice): void {
    if (choice.tooBig) return;
    selected = choice.id;
    writeStored(SCALE_KEY, choice.id);
    sfx.play('tick');
  }

  async function save(): Promise<void> {
    if (!active || !app.result || phase === 'saving') return;
    phase = 'saving';
    const name = fileName;
    try {
      const png = await app.track(app.engine.exportPng(app.session.composed(), active.scale));
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

<Dialog open={app.exportOpen} labelledby="export-title" onclose={close} wide>
  <div class="dialog-body export">
    {#if phase !== 'done'}
      <h2 id="export-title" class="export-title">{t('export.title')}</h2>
      <fieldset class="field">
        <legend class="section-title">{t('export.size')}</legend>
        <div class="choices">
          {#each choices as choice (choice.id)}
            <label class="choice" class:is-active={active?.id === choice.id} class:is-disabled={choice.tooBig}>
              <input
                class="visually-hidden"
                type="radio"
                id="export-scale-{choice.id}"
                name="export-scale"
                value={choice.id}
                checked={active?.id === choice.id}
                disabled={choice.tooBig || phase === 'saving'}
                onchange={() => pick(choice)}
              />
              <span class="choice-label">{choice.label}</span>
              <span class="choice-dims">{choice.tooBig ? t('export.tooBig') : t('export.dims', { w: choice.width, h: choice.height })}</span>
            </label>
          {/each}
        </div>
      </fieldset>
      <p class="file-name"><span class="hint">{t('export.fileName')}</span> <code>{fileName}</code></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-quiet" onclick={close} disabled={phase === 'saving'}>{t('export.cancel')}</button>
        <button type="button" class="btn btn-primary btn-big" onclick={save} disabled={phase === 'saving' || !active}>
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

    .choices {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-2);
      margin-top: var(--space-2);
    }

    .choice {
      display: grid;
      gap: 2px;
      padding: var(--space-3);
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-m);
      cursor: pointer;
      transition:
        transform var(--dur-hover) var(--ease-sym),
        border-color var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym);

      &:hover:not(.is-disabled) {
        border-color: var(--line-strong);
        transform: translateY(-2px);
      }

      &:focus-within {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }

      &.is-active {
        background: color-mix(in oklch, var(--primary), var(--surface-sunken) 82%);
        border-color: var(--primary);
      }

      &.is-disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
    }

    .choice-label {
      font: 700 1rem/1.2 var(--font-body);
      font-variant-numeric: tabular-nums;
    }

    .choice-dims {
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }

    .file-name {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);

      & code {
        font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
        font-size: 0.875rem;
        overflow-wrap: anywhere;
        color: var(--text);
      }
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
