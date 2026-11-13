<script lang="ts">
  import { onMount } from 'svelte';
  import logoUrl from '../../app-icon.svg';
  import { app, isImageFile } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { isDesktop, launchFile } from '../app/platform.ts';
  import { zoomMoveOf } from '../app/zoom.ts';
  import AboutDialog from './AboutDialog.svelte';
  import CleanScreen from './CleanScreen.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import DropScreen from './DropScreen.svelte';
  import ExportDialog from './ExportDialog.svelte';
  import GridScreen from './GridScreen.svelte';
  import SetExportDialog from './SetExportDialog.svelte';
  import SetScreen from './SetScreen.svelte';
  import Icon from './Icon.svelte';
  import LanguageSelect from './LanguageSelect.svelte';
  import Stepper from './Stepper.svelte';
  import Toasts from './Toasts.svelte';
  import ZoomIndicator from './ZoomIndicator.svelte';

  const DEV = import.meta.env.DEV;
  let dragDepth = 0;

  function hasFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
  }

  function dialogOpen(): boolean {
    return app.exportOpen || app.setExportOpen || app.aboutOpen || app.confirmRequest !== null;
  }

  // Without these guards the WebView navigates to a file dropped anywhere on the window.
  function onDragEnter(event: DragEvent): void {
    event.preventDefault();
    if (!hasFiles(event)) return;
    dragDepth++;
    app.dragActive = !dialogOpen();
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = hasFiles(event) && !dialogOpen() ? 'copy' : 'none';
  }

  function onDragLeave(event: DragEvent): void {
    event.preventDefault();
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) app.dragActive = false;
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragDepth = 0;
    app.dragActive = false;
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0 || dialogOpen()) return;
    // A drop on the set card of the drop screen starts a set, even with one image.
    const asSet = event.target instanceof Element && event.target.closest('[data-drop-set]') !== null;
    void app.openFiles(Array.from(files), asSet);
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function onPaste(event: ClipboardEvent): void {
    if (dialogOpen()) return;
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    const images = files.filter(isImageFile);
    if (images.length > 0) {
      event.preventDefault();
      void app.openFiles(images);
    } else if (!isEditable(event.target) && app.screen === 'drop') {
      app.toast(files.length > 0 ? t('toast.notImage') : t('toast.nothingToPaste'), 'info');
    }
  }

  /** Capture phase: the interface zoom keys never reach a focused field or a screen shortcut. Desktop only. */
  function onZoomKey(event: KeyboardEvent): void {
    if (!isDesktop) return;
    const move = zoomMoveOf(event);
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat || move !== 'reset') void app.changeZoom(move);
  }

  /** Browser shortcuts that break the feel of a desktop app. Dev mode keeps them for debugging. */
  function onKeyDown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      return;
    }
    if (DEV) return;
    if (event.key === 'F5' || (mod && (key === 'r' || key === 'p' || key === 'f'))) event.preventDefault();
  }

  function onContextMenu(event: MouseEvent): void {
    if (DEV || isEditable(event.target)) return;
    event.preventDefault();
  }

  function onWheel(event: WheelEvent): void {
    if (event.ctrlKey) event.preventDefault();
  }

  onMount(() => {
    window.addEventListener('wheel', onWheel, { passive: false });
    launchFile()
      .then((file) => {
        if (file) void app.openBytes(file.bytes.slice().buffer, file.name);
      })
      .catch(() => app.toast(t('error.read'), 'error'));
    return () => window.removeEventListener('wheel', onWheel);
  });
</script>

<svelte:window
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onpaste={onPaste}
  onkeydown={onKeyDown}
  onkeydowncapture={onZoomKey}
  oncontextmenu={onContextMenu}
/>

<div class="app">
  <header class="app-header">
    <!-- The logo goes back to the drop screen by the path of the "Soltar" step, with its questions. -->
    <button
      type="button"
      class="brand"
      aria-label={t('header.home')}
      title={app.screen === 'drop' ? undefined : t('header.home')}
      aria-disabled={app.screen === 'drop'}
      onclick={() => {
        if (app.screen !== 'drop') void app.goTo('drop');
      }}
    >
      <img class="brand-logo" src={logoUrl} alt="" width="30" height="30" />
      <span class="brand-name">{t('app.name')}</span>
    </button>
    <Stepper />
    <div class="header-actions">
      {#if app.zoomAvailable && app.zoomPercent !== app.zoomDefault}
        <button type="button" class="zoom-chip" aria-label={t('zoom.chip', { value: app.zoomPercent })} title={t('zoom.chip', { value: app.zoomPercent })} onclick={() => app.showZoom()}>
          {app.zoomPercent}%
        </button>
      {/if}
      <LanguageSelect />
      <button
        type="button"
        class="icon-btn"
        aria-pressed={app.muted}
        aria-label={app.muted ? t('header.unmute') : t('header.mute')}
        title={app.muted ? t('header.unmute') : t('header.mute')}
        onclick={() => app.toggleMute()}
      >
        <Icon name={app.muted ? 'soundOff' : 'soundOn'} />
      </button>
      <button type="button" class="icon-btn" aria-label={t('header.about')} title={t('header.about')} onclick={() => (app.aboutOpen = true)}>
        <Icon name="info" />
      </button>
    </div>
  </header>

  <main class="app-main" aria-label={t('app.mainLabel')}>
    {#key app.screen}
      <div class="screen">
        {#if app.screen === 'set' && app.set.active}
          <SetScreen />
        {:else if (app.screen === 'grid' || app.screen === 'set-grid') && app.source}
          <GridScreen />
        {:else if app.screen === 'clean' && app.result}
          <CleanScreen />
        {:else}
          <DropScreen />
        {/if}
      </div>
    {/key}

    {#if app.dragActive && app.screen !== 'drop'}
      <div class="drag-overlay" aria-hidden="true">
        <div class="drag-card">
          <Icon name="image" size={40} />
          <span>{app.set.active ? t('drop.overlaySet') : t('drop.overlay')}</span>
        </div>
      </div>
    {/if}
  </main>
</div>

<Toasts />
{#if app.zoomAvailable}<ZoomIndicator />{/if}
<ConfirmDialog />
<AboutDialog />
<ExportDialog />
<SetExportDialog />

<style>
  @layer components {
    .app {
      display: grid;
      grid-template-rows: var(--header-h) minmax(0, 1fr);
      grid-template-columns: minmax(0, 1fr);
      width: 100%;
      height: 100dvh;
      overflow: clip;
    }

    .app-header {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: var(--space-4);
      padding: 0 var(--space-4);
      background: var(--surface-sunken);
      border-bottom: 2px solid var(--line);
    }

    .brand {
      display: flex;
      justify-self: start;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
      margin-left: calc(-1 * var(--space-1));
      color: var(--text);
      border-radius: var(--radius-m);
      transition:
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:not([aria-disabled='true']):hover {
        background: var(--surface-2);
      }

      &:not([aria-disabled='true']):active {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &[aria-disabled='true'] {
        cursor: default;
      }
    }

    .brand-logo {
      image-rendering: pixelated;
    }

    .brand-name {
      font: 600 1.125rem/1 var(--font-display);
      letter-spacing: 0.02em;
    }

    .header-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-1);
    }

    .zoom-chip {
      min-height: 28px;
      margin-right: var(--space-1);
      padding: 0 var(--space-2);
      color: var(--text-muted);
      background: var(--surface-2);
      border: 2px solid var(--line);
      border-radius: 999px;
      font: 700 0.8125rem/1 var(--font-body);
      font-variant-numeric: tabular-nums;
      transition:
        color var(--dur-hover) var(--ease-sym),
        border-color var(--dur-hover) var(--ease-sym);

      &:hover {
        color: var(--text);
        border-color: var(--line-strong);
      }
    }

    .header-actions :global(.icon-btn[aria-pressed='true']) {
      color: var(--text-muted);
      background: var(--surface-2);
    }

    .app-main {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .screen {
      min-width: 0;
      min-height: 0;
      overflow: clip;
      animation: screen-in var(--dur-screen) var(--ease-out);
    }

    .drag-overlay {
      position: absolute;
      inset: var(--space-3);
      z-index: 30;
      display: grid;
      place-items: center;
      background: var(--overlay);
      border: 3px dashed var(--primary);
      border-radius: var(--radius-l);
      pointer-events: none;
      animation: fade-in var(--dur-pop) var(--ease-out);
    }

    .drag-card {
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      padding: var(--space-5) var(--space-6);
      color: var(--primary);
      font: 600 1.5rem/1.2 var(--font-display);
      background: var(--surface-1);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-l);
      box-shadow: 0 6px 0 var(--depth);
      animation: drag-card-in var(--dur-modal) var(--ease-spring);
    }

    @keyframes screen-in {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
    }

    @keyframes drag-card-in {
      from {
        transform: scale(0.9);
      }
    }
  }
</style>
