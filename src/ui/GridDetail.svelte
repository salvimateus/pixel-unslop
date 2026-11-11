<script lang="ts">
  import { t } from '../app/i18n.ts';
  import type { GridScene } from './grid-scene.ts';

  interface Props {
    scene: GridScene;
  }

  let { scene }: Props = $props();

  let canvas: HTMLCanvasElement;
  let box: HTMLDivElement;

  /** The scene draws the detail on each frame of the stage, at the CSS size that the box has now. */
  $effect(() => {
    const current = scene;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      current.setDetail(canvas, rect.width, rect.height);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      current.setDetail(null);
    };
  });
</script>

<figure class="detail">
  <div class="detail-box" bind:this={box}>
    <canvas class="detail-canvas" bind:this={canvas} width="1" height="1" aria-hidden="true"></canvas>
  </div>
  <figcaption class="detail-caption">{t('grid.detailCaption')}</figcaption>
</figure>

<style>
  @layer components {
    .detail {
      display: grid;
      gap: var(--space-1);
      margin: 0;
    }

    .detail-box {
      position: relative;
      height: clamp(112px, 22dvh, 200px);
      overflow: hidden;
      background: var(--surface-sunken);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-m);
    }

    .detail-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }

    .detail-caption {
      color: var(--text-muted);
      font-size: 0.8125rem;
      line-height: 1.35;
    }
  }
</style>
