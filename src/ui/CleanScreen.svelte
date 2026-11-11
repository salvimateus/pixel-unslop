<script lang="ts">
  import { untrack } from 'svelte';
  import { TRANSPARENT } from '../core/color.ts';
  import { borderBackground, floodRegion, indicesOfColor, lineTiles, listPalette } from '../core/sprite.ts';
  import { opaqueBox } from '../app/image-set.svelte.ts';
  import { app, type Tool } from '../app/state.svelte.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import { TUNING } from '../app/tuning.ts';
  import type { Tile } from './camera.ts';
  import { CleanScene, type HoverMark, type PreviewBackground } from './clean-scene.ts';
  import Icon, { type IconName } from './Icon.svelte';
  import CleanupPresets from './CleanupPresets.svelte';
  import PalettePanel from './PalettePanel.svelte';
  import ProgressPill from './ProgressPill.svelte';
  import Stage from './Stage.svelte';
  import type { StagePointer } from './stage-renderer.ts';

  interface ToolInfo {
    id: Tool;
    icon: IconName;
    label: TextKey;
    key: string;
  }

  const TOOLS: readonly ToolInfo[] = [
    { id: 'view', icon: 'view', label: 'clean.tool.view', key: 'V' },
    { id: 'pencil', icon: 'pencil', label: 'clean.tool.pencil', key: 'B' },
    { id: 'eraser', icon: 'eraser', label: 'clean.tool.eraser', key: 'E' },
    { id: 'bucket', icon: 'bucket', label: 'clean.tool.bucket', key: 'G' },
    { id: 'picker', icon: 'picker', label: 'clean.tool.picker', key: 'I' },
  ];
  const BACKGROUNDS: ReadonlyArray<{ id: PreviewBackground; label: TextKey }> = [
    { id: 'checker', label: 'clean.bg.checker' },
    { id: 'dark', label: 'clean.bg.dark' },
    { id: 'light', label: 'clean.bg.light' },
  ];

  interface Stroke {
    color: number;
    erase: boolean;
    last: Tile;
    indices: number[];
    seen: Set<number>;
  }

  let stage: Stage | undefined = $state();
  let palettePanel: PalettePanel | undefined = $state();
  let scene = $state.raw<CleanScene | null>(null);
  let sceneAligned: ImageBitmap | null = null;
  let stroke: Stroke | null = null;
  let draggingSplit = false;
  let overSplit = $state(false);
  let splitPercent = $state(0);

  const result = $derived(app.result);
  const palette = $derived.by(() => {
    void app.editVersion;
    return result ? listPalette(app.session.composed().pixels) : [];
  });
  /** The preview background shows only through transparent tiles; without them the control is disabled. */
  const hasTransparency = $derived.by(() => {
    void app.editVersion;
    return result ? app.session.composed().pixels.includes(TRANSPARENT) : false;
  });
  /** The box that the export writes: the opaque tiles. The stage outlines it when it is smaller than the canvas. */
  const exportBox = $derived.by(() => {
    void app.editVersion;
    return result ? opaqueBox(app.session.composed()) : null;
  });
  const trimmed = $derived(exportBox !== null && result !== null && (exportBox.cols !== result.sprite.cols || exportBox.rows !== result.sprite.rows));
  const canUndo = $derived.by(() => {
    void app.editVersion;
    return app.session.canUndo;
  });
  const canRedo = $derived.by(() => {
    void app.editVersion;
    return app.session.canRedo;
  });
  const cursor = $derived(overSplit ? 'ew-resize' : app.tool === 'view' ? 'grab' : app.tool === 'picker' ? 'copy' : 'crosshair');

  /** A new result (new grid) builds a new scene with the entry sweep; a merge only rewrites the sprite layer. */
  $effect(() => {
    const current = result;
    void app.baseVersion;
    untrack(() => {
      if (!current) {
        scene = null;
        return;
      }
      const composed = app.session.composed();
      if (!scene || sceneAligned !== current.aligned || scene.contentW !== composed.cols || scene.contentH !== composed.rows) {
        sceneAligned = current.aligned;
        const next = new CleanScene(composed, current.aligned, { before: t('clean.before'), after: t('clean.after') }, true);
        next.background = app.previewBg;
        next.showGrid = app.showTileGrid;
        scene = next;
        splitPercent = 0;
        sfx.play('sweep');
      } else {
        scene.setSprite(composed);
      }
    });
  });

  $effect(() => {
    const bg = app.previewBg;
    const grid = app.showTileGrid;
    if (!scene) return;
    scene.background = bg;
    scene.showGrid = grid;
    stage?.invalidate();
  });

  $effect(() => {
    const box = trimmed ? exportBox : null;
    if (!scene) return;
    scene.exportBox = box;
    stage?.invalidate();
  });

  function tileOf(p: StagePointer): Tile | null {
    if (!scene) return null;
    const col = Math.floor(p.ix);
    const row = Math.floor(p.iy);
    return col >= 0 && row >= 0 && col < scene.contentW && row < scene.contentH ? { col, row } : null;
  }

  function hoverMark(): HoverMark {
    switch (app.tool) {
      case 'pencil':
      case 'bucket':
        return { kind: 'paint', color: app.ink };
      case 'eraser':
        return { kind: 'erase' };
      case 'picker':
        return { kind: 'pick' };
      default:
        return null;
    }
  }

  function edited(): void {
    app.editVersion++;
  }

  function paintTile(tile: Tile): void {
    if (!stroke || !scene) return;
    const index = tile.row * scene.contentW + tile.col;
    if (stroke.seen.has(index)) return;
    stroke.seen.add(index);
    const pixels = app.session.composed().pixels;
    if (pixels[index] === stroke.color) return;
    stroke.indices.push(index);
    scene.writeTile(index, stroke.color);
    if (stroke.erase) {
      scene.shatter([index], pixels);
      sfx.play('erase');
    } else {
      scene.pop(tile);
      sfx.play('paint');
    }
  }

  function pickAt(tile: Tile | null): void {
    if (!tile || !scene) return;
    app.ink = app.session.composed().pixels[tile.row * scene.contentW + tile.col];
    sfx.play('tick');
  }

  function fillAt(tile: Tile): void {
    if (!scene) return;
    const composed = app.session.composed();
    const start = tile.row * composed.cols + tile.col;
    if (composed.pixels[start] === app.ink) {
      sfx.play('tick');
      return;
    }
    const region = floodRegion(composed, start);
    const changed = app.session.apply(region.indices, app.ink);
    if (changed.length === 0) return;
    scene.startWave(region.indices, region.distance, app.session.composed().pixels);
    scene.ripple(tile);
    sfx.play('fill');
    edited();
  }

  function onDown(p: StagePointer): boolean | 'pan' {
    if (!scene) return false;
    if (scene.hitSplit(p.sx, p.sy)) {
      draggingSplit = true;
      return true;
    }
    if (scene.sweeping) scene.setSplit(0);
    const tile = tileOf(p);
    switch (app.tool) {
      case 'view':
        return 'pan';
      case 'picker':
        pickAt(tile);
        if (tile && TUNING.clean.eyedropperReturnsToPencil) app.tool = 'pencil';
        return false;
      case 'bucket':
        if (tile) fillAt(tile);
        return false;
      case 'pencil':
      case 'eraser': {
        const erase = app.tool === 'eraser' || app.ink === TRANSPARENT;
        const start = { col: Math.floor(p.ix), row: Math.floor(p.iy) };
        stroke = { color: app.tool === 'eraser' ? TRANSPARENT : app.ink, erase, last: start, indices: [], seen: new Set() };
        if (tile) paintTile(tile);
        return true;
      }
    }
  }

  function onMove(p: StagePointer): void {
    if (draggingSplit) {
      scene?.setSplitFromScreen(p.sx);
      splitPercent = Math.round((scene?.split ?? 0) * 100);
      return;
    }
    if (!stroke || !scene) return;
    const col = Math.floor(p.ix);
    const row = Math.floor(p.iy);
    if (col === stroke.last.col && row === stroke.last.row) return;
    const line = lineTiles(stroke.last.col, stroke.last.row, col, row);
    for (let i = 0; i < line.length; i += 2) {
      const x = line[i];
      const y = line[i + 1];
      if (x >= 0 && y >= 0 && x < scene.contentW && y < scene.contentH) paintTile({ col: x, row: y });
    }
    stroke.last = { col, row };
    scene.setHover(tileOf(p), hoverMark());
  }

  function onUp(): void {
    if (draggingSplit) {
      draggingSplit = false;
      return;
    }
    const finished = stroke;
    stroke = null;
    if (!finished || finished.indices.length === 0) return;
    app.session.apply(Int32Array.from(finished.indices), finished.color);
    edited();
  }

  function onHover(p: StagePointer | null): void {
    if (!scene) return;
    overSplit = p !== null && scene.hitSplit(p.sx, p.sy);
    scene.setHover(p && !overSplit ? tileOf(p) : null, hoverMark());
  }

  function selectTool(tool: Tool): void {
    if (app.tool === tool) return;
    app.tool = tool;
    sfx.play('tick');
  }

  function undo(): void {
    const changed = app.session.undo();
    if (!changed || !scene) return;
    scene.writeTiles(changed, app.session.composed().pixels);
    sfx.play('undo');
    edited();
  }

  function redo(): void {
    const changed = app.session.redo();
    if (!changed || !scene) return;
    scene.writeTiles(changed, app.session.composed().pixels);
    sfx.play('undo');
    edited();
  }

  /** Erases tiles with the falling-shards effect. Returns how many tiles changed. */
  function eraseTiles(indices: Int32Array): number {
    if (!scene) return 0;
    const before = app.session.composed().pixels;
    const changed = app.session.apply(indices, TRANSPARENT);
    if (changed.length === 0) return 0;
    scene.writeTiles(changed, app.session.composed().pixels);
    scene.shatter(changed, before);
    sfx.play('erase');
    edited();
    return changed.length;
  }

  function removeBackground(): void {
    const indices = borderBackground(app.session.composed());
    if (indices.length === 0 || eraseTiles(indices) === 0) {
      app.toast(t('toast.noBackground'), 'info');
      return;
    }
    app.toast(t('toast.bgRemoved'), 'success');
  }

  function deleteColor(color: number): void {
    const count = eraseTiles(indicesOfColor(app.session.composed().pixels, color));
    if (count > 0) app.toast(t('toast.colorDeleted', { count }), 'success');
    if (app.ink === color) app.ink = TRANSPARENT;
  }

  function swapColor(from: number, to: number): void {
    if (!scene) return;
    const changed = app.session.swapColor(from, to);
    if (changed.length === 0) return;
    scene.writeTiles(changed, app.session.composed().pixels);
    if (app.ink === from) app.ink = to;
    sfx.play('fill');
    app.toast(t('toast.colorSwapped', { count: changed.length }), 'success');
    edited();
  }

  function selectColor(color: number): void {
    app.ink = color;
    if (app.tool === 'view' || app.tool === 'picker' || (app.tool === 'eraser' && color !== TRANSPARENT)) app.tool = 'pencil';
    sfx.play('tick');
  }

  function onCompareInput(event: Event): void {
    splitPercent = Number((event.currentTarget as HTMLInputElement).value);
    scene?.setSplit(splitPercent / 100);
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (app.exportOpen || app.confirmRequest || app.aboutOpen) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      redo();
    } else if (mod && key === 's') {
      event.preventDefault();
      if (app.editingId === null) app.exportOpen = true;
    } else if (event.key === 'Escape') {
      palettePanel?.cancelSwap();
    } else if (!mod && !event.altKey && !isEditable(event.target)) {
      const tool = TOOLS.find((entry) => entry.key.toLowerCase() === key);
      if (tool) {
        event.preventDefault();
        selectTool(tool.id);
      }
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<section class="clean-screen">
  <nav class="tool-rail" aria-label={t('clean.toolsLabel')}>
    {#each TOOLS as tool (tool.id)}
      <button
        type="button"
        class="tool"
        aria-pressed={app.tool === tool.id}
        aria-keyshortcuts={tool.key}
        title="{t(tool.label)} ({tool.key})"
        onclick={() => selectTool(tool.id)}
      >
        <Icon name={tool.icon} size={22} />
        <span class="tool-label">{t(tool.label)}</span>
        <kbd class="tool-key">{tool.key}</kbd>
      </button>
    {/each}
    <p class="rail-hint">{t('clean.rightClickHint')}</p>
  </nav>

  <div class="clean-main">
    <div class="toolbar">
      <div class="toolbar-group">
        <button type="button" class="icon-btn" aria-label={t('clean.undo')} title="{t('clean.undo')} (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!canUndo} onclick={undo}>
          <Icon name="undo" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.redo')} title="{t('clean.redo')} (Ctrl+Y)" aria-keyshortcuts="Control+Y" disabled={!canRedo} onclick={redo}>
          <Icon name="redo" />
        </button>
      </div>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <div class="toolbar-group">
        <button type="button" class="icon-btn" aria-label={t('clean.zoomOut')} title={t('clean.zoomOut')} onclick={() => stage?.zoomBy(1 / TUNING.zoom.buttonStep)}>
          <Icon name="zoomOut" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.zoomIn')} title={t('clean.zoomIn')} onclick={() => stage?.zoomBy(TUNING.zoom.buttonStep)}>
          <Icon name="zoomIn" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.fit')} title={t('clean.fit')} onclick={() => stage?.fitView()}>
          <Icon name="fit" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('clean.grid')} title={t('clean.grid')} aria-pressed={app.showTileGrid} onclick={() => (app.showTileGrid = !app.showTileGrid)}>
          <Icon name="grid" />
        </button>
      </div>
      <div class="toolbar-group toolbar-end">
        <span class="toolbar-label" id="bg-label">{t('clean.background')}</span>
        <div class="segmented bg-choice" role="group" aria-labelledby="bg-label" aria-describedby={hasTransparency ? undefined : 'bg-hint'}>
          {#each BACKGROUNDS as bg (bg.id)}
            <button type="button" aria-pressed={app.previewBg === bg.id} disabled={!hasTransparency} onclick={() => app.setPreviewBackground(bg.id)}>{t(bg.label)}</button>
          {/each}
        </div>
      </div>
      {#if !hasTransparency}
        <p class="toolbar-hint" id="bg-hint">{t('clean.bgOpaque')}</p>
      {/if}
    </div>

    <div class="clean-stage">
      {#if scene}
        <Stage
          bind:this={stage}
          {scene}
          label={t('clean.stageLabel')}
          {cursor}
          onprimarydown={onDown}
          onprimarymove={onMove}
          onprimaryup={onUp}
          onaltclick={(p) => pickAt(tileOf(p))}
          onhover={onHover}
        >
          <label class="compare">
            <span class="compare-end">{t('clean.before')}</span>
            <input id="compare-split" name="compare-split" class="compare-range" type="range" min="0" max="100" step="1" value={splitPercent} aria-label={t('clean.compare')} oninput={onCompareInput} />
            <span class="compare-end">{t('clean.after')}</span>
          </label>
        </Stage>
      {/if}
      <ProgressPill />
    </div>
  </div>

  <aside class="clean-panel">
    <div class="clean-panel-scroll">
      <header class="clean-head">
        {#if app.editingId !== null && app.source}<p class="piece-tag">{t('clean.piece', { name: app.source.name })}</p>{/if}
        <h1 class="clean-title">{t('clean.title')}</h1>
        {#if result}<p class="hint">{t('clean.size', { cols: result.sprite.cols, rows: result.sprite.rows })} · {t('rule.pixel')}</p>{/if}
        {#if trimmed && exportBox}<p class="hint export-box-note"><span class="export-box-swatch" aria-hidden="true"></span>{t('clean.exportBox', { w: exportBox.cols, h: exportBox.rows })}</p>{/if}
      </header>

      <PalettePanel bind:this={palettePanel} colors={palette} ink={app.ink} onselect={selectColor} onswap={swapColor} ondelete={deleteColor} />

      <button type="button" class="btn btn-quiet remove-bg" onclick={removeBackground}>
        <Icon name="sparkle" size={18} />
        {t('clean.removeBg')}
      </button>

      <CleanupPresets hint={t('cleanup.hint')} />
    </div>

    <div class="clean-actions">
      <button type="button" class="btn btn-quiet" title={t('clean.backToGrid')} onclick={() => app.goTo(app.editingId !== null ? 'set-grid' : 'grid')}>
        <Icon name="back" size={18} />
        <span class="back-label">{t('clean.backToGrid')}</span>
      </button>
      {#if app.editingId !== null}
        <button type="button" class="btn btn-primary btn-big" onclick={() => app.returnToSet()} disabled={app.loading}>
          <Icon name="check" size={20} />
          {t('set.backToSet')}
        </button>
      {:else}
        <button type="button" class="btn btn-primary btn-big" aria-keyshortcuts="Control+S" title="{t('clean.export')} (Ctrl+S)" onclick={() => (app.exportOpen = true)}>
          <Icon name="download" size={20} />
          {t('clean.export')}
        </button>
      {/if}
    </div>
  </aside>
</section>

<style>
  @layer components {
    .export-box-note {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-variant-numeric: tabular-nums;
    }

    .export-box-swatch {
      flex: none;
      width: 14px;
      height: 10px;
      border: 1px dashed var(--teal);
    }

    .clean-screen {
      display: grid;
      grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--panel-w);
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: clip;
    }

    .tool-rail {
      display: grid;
      align-content: start;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-2);
      background: var(--surface-1);
      border-right: 2px solid var(--line);
      overflow: hidden auto;
    }

    .tool {
      position: relative;
      min-width: 0;
      display: grid;
      justify-items: center;
      gap: 3px;
      padding: var(--space-2) 2px;
      color: var(--text-muted);
      border: 2px solid transparent;
      border-radius: var(--radius-m);
      transition:
        transform var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym),
        color var(--dur-hover) var(--ease-sym);

      &:hover {
        color: var(--text);
        background: var(--surface-2);
      }

      &:active {
        transform: translateY(2px);
        transition-duration: 60ms;
      }

      &[aria-pressed='true'] {
        color: var(--on-primary);
        background: var(--primary);
        border-color: var(--primary-edge);
        box-shadow: 0 3px 0 var(--primary-depth);
      }
    }

    .tool-label {
      max-width: 100%;
      font: 600 0.75rem/1.1 var(--font-display);
      overflow-wrap: anywhere;
    }

    .tool-key {
      position: absolute;
      top: 3px;
      right: 4px;
      font: 600 0.625rem/1 var(--font-body);
      opacity: 0.8;
    }

    .rail-hint {
      margin-top: var(--space-2);
      padding: 0 2px;
      color: var(--text-muted);
      font-size: 0.6875rem;
      line-height: 1.3;
      text-align: center;
    }

    .clean-main {
      container-type: inline-size;
      display: grid;
      grid-template: auto minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--surface-1);
      border-bottom: 2px solid var(--line);
    }

    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .toolbar-end {
      gap: var(--space-2);
      margin-left: auto;
    }

    .toolbar-hint {
      flex-basis: 100%;
      margin-top: -2px;
      color: var(--text-muted);
      font-size: 0.75rem;
      text-align: right;
    }

    .toolbar-sep {
      width: 2px;
      height: 24px;
      background: var(--line);
    }

    .toolbar-label {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    @container (width < 560px) {
      .toolbar-label {
        display: none;
      }
    }

    .bg-choice button {
      flex: none;
      padding: 0 var(--space-2);
    }

    .clean-stage {
      position: relative;
      display: grid;
      grid-template: minmax(0, 1fr) / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
    }

    .compare {
      position: absolute;
      left: 50%;
      bottom: var(--space-3);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-1);
      border: 2px solid var(--line);
      border-radius: 999px;
      box-shadow: 0 4px 0 var(--depth);
      translate: -50% 0;
    }

    .compare-end {
      font: 600 0.8125rem/1 var(--font-display);
      color: var(--text-muted);
    }

    .compare-range {
      width: 140px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .clean-panel {
      display: grid;
      grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--surface-1);
      border-left: 2px solid var(--line);
    }

    .clean-panel-scroll {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      overflow-x: hidden;
      align-content: start;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-5);
      overflow-y: auto;
    }

    .clean-head {
      display: grid;
      gap: var(--space-1);
    }

    .clean-title {
      font-size: 1.5rem;
      text-wrap: balance;
    }

    .piece-tag {
      justify-self: start;
      max-width: 100%;
      padding: 2px var(--space-2);
      overflow: hidden;
      color: var(--on-primary);
      background: var(--teal);
      border-radius: var(--radius-s);
      font: 600 0.8125rem/1.3 var(--font-body);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .remove-bg {
      justify-self: stretch;
    }

    .clean-actions {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-5) var(--space-5);
      border-top: 2px solid var(--line);
    }

    @media (max-height: 760px) {
      .clean-panel-scroll {
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }

      .clean-title {
        font-size: 1.125rem;
      }

      .clean-actions {
        grid-template-columns: auto minmax(0, 1fr);
        padding: var(--space-3) var(--space-4) var(--space-4);
      }

      .clean-actions :global(.btn-big) {
        min-height: 44px;
        padding: 0 var(--space-3);
        font-size: 1.0625rem;
      }

      .back-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }

      .tool {
        padding-block: 6px;
      }
    }
  }
</style>
