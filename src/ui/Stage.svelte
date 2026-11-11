<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { app } from '../app/state.svelte.ts';
  import { TUNING } from '../app/tuning.ts';
  import { Camera, type Point } from './camera.ts';
  import { ParticleField } from './particles.ts';
  import type { Scene, StageHost, StagePointer } from './stage-renderer.ts';

  interface Props {
    scene: Scene;
    label: string;
    cursor?: string;
    /** Return false to ignore the press, or 'pan' to move the view with it. */
    onprimarydown?: (p: StagePointer) => boolean | 'pan' | void;
    onprimarymove?: (p: StagePointer) => void;
    onprimaryup?: (p: StagePointer) => void;
    /** A right click that did not turn into a pan. */
    onaltclick?: (p: StagePointer) => void;
    onhover?: (p: StagePointer | null) => void;
    /** After a zoom or a pan, so the screen can update its hints. */
    onviewchange?: () => void;
    children?: Snippet;
  }

  let { scene, label, cursor = 'default', onprimarydown, onprimarymove, onprimaryup, onaltclick, onhover, onviewchange, children }: Props = $props();

  type DragMode = 'pan' | 'tool' | 'alt';
  interface Drag {
    mode: DragMode;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  }

  const ALT_PAN_THRESHOLD_PX = 4;

  let wrap: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let fxCanvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let fx: CanvasRenderingContext2D | null = null;
  let sized = false;
  let raf = 0;
  let lastFrame = 0;
  let drag: Drag | null = null;
  let spaceHeld = $state(false);
  let panning = $state(false);
  let dpr = 1;
  /** Until the user zooms or pans, a window resize frames the content again. */
  let userMoved = false;
  let reducedMotion = false;

  const camera = new Camera();
  const particles = new ParticleField();

  const host: StageHost = {
    camera,
    particles,
    get dpr() {
      return dpr;
    },
    get reducedMotion() {
      return reducedMotion;
    },
    invalidate,
  };

  export function invalidate(): void {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  export function fitView(): void {
    userMoved = false;
    camera.fit(scene.initialZoom(camera));
    invalidate();
    onviewchange?.();
  }

  /**
   * Reads the content size of the scene again and keeps the zoom. With `keep`, the content point `from`
   * (old units) stays at its screen position, now as the point `to` (new units). Until the user zooms or pans,
   * content that grew past the view is framed again. Never call it during a drag.
   */
  export function syncContent(keep?: { from: Point; to: Point }): void {
    const anchor = keep ? camera.imageToScreen(keep.from.x, keep.from.y) : null;
    camera.setContent(scene.contentW, scene.contentH, scene.maxZoom);
    if (!userMoved && camera.fitZoom() < camera.zoom) {
      camera.fit(scene.initialZoom(camera));
      invalidate();
      onviewchange?.();
      return;
    }
    if (anchor && keep) {
      camera.panX = anchor.x - keep.to.x * camera.zoom;
      camera.panY = anchor.y - keep.to.y * camera.zoom;
    }
    camera.panBy(0, 0);
    invalidate();
    onviewchange?.();
  }

  export function zoomBy(factor: number): void {
    userMoved = true;
    camera.zoomAtCenter(factor);
    invalidate();
  }

  function frame(now: number): void {
    raf = 0;
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 1 / 60;
    const moving = camera.step(dt);
    const sparks = particles.step(dt);
    const alive = render(now);
    if (moving) onviewchange?.();
    if (moving || sparks || alive) {
      lastFrame = now;
      invalidate();
    } else {
      lastFrame = 0;
    }
  }

  function render(now: number): boolean {
    if (!ctx || !fx || !sized) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, camera.viewW, camera.viewH);
    ctx.imageSmoothingEnabled = false;
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.clearRect(0, 0, camera.viewW, camera.viewH);
    fx.imageSmoothingEnabled = false;
    const alive = scene.draw(ctx, fx, now);
    particles.draw(fx);
    return alive;
  }

  function resize(width: number, height: number): void {
    dpr = Math.min(window.devicePixelRatio || 1, TUNING.stage.maxDpr);
    for (const target of [canvas, fxCanvas]) {
      target.width = Math.max(1, Math.round(width * dpr));
      target.height = Math.max(1, Math.round(height * dpr));
    }
    camera.setViewport(width, height);
    if (!sized) {
      sized = true;
      camera.setContent(scene.contentW, scene.contentH, scene.maxZoom);
    }
    if (!userMoved) {
      camera.fit(scene.initialZoom(camera));
      onviewchange?.();
    }
    // A canvas resize clears it: draw now so the frame never flashes empty.
    render(performance.now());
    invalidate();
  }

  $effect(() => {
    const current = scene;
    current.attach(host);
    userMoved = false;
    if (sized) {
      camera.setContent(current.contentW, current.contentH, current.maxZoom);
      camera.fit(current.initialZoom(camera));
      onviewchange?.();
    }
    invalidate();
    return () => current.attach(null);
  });

  onMount(() => {
    ctx = canvas.getContext('2d');
    fx = fxCanvas.getContext('2d');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = () => {
      reducedMotion = motion.matches;
      particles.enabled = !reducedMotion;
      if (reducedMotion) particles.clear();
    };
    applyMotion();
    motion.addEventListener('change', applyMotion);

    const observer = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      if (box.width > 0 && box.height > 0) resize(box.width, box.height);
    });
    observer.observe(wrap);

    const probe = { camera, canvas };
    app.stage = probe;

    // Wheel needs passive: false, or preventDefault cannot stop the page from zooming or scrolling.
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', applyMotion);
      wrap.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (app.stage === probe) app.stage = null;
    };
  });

  function pointer(event: PointerEvent | WheelEvent): StagePointer {
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const p = camera.screenToImage(sx, sy);
    return { sx, sy, ix: p.x, iy: p.y, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey || event.metaKey };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? camera.viewH : 1;
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
    const p = pointer(event);
    userMoved = true;
    camera.zoomAt(p.sx, p.sy, Math.exp(-delta * TUNING.zoom.wheelSensitivity));
    invalidate();
  }

  function onPointerDown(event: PointerEvent): void {
    if (drag) return;
    const p = pointer(event);
    let mode: DragMode | null = null;
    if (event.button === 1 || (event.button === 0 && spaceHeld)) mode = 'pan';
    else if (event.button === 2) mode = 'alt';
    else if (event.button === 0) {
      const answer = onprimarydown?.(p);
      mode = answer === false ? null : answer === 'pan' ? 'pan' : 'tool';
    }
    if (!mode) return;
    event.preventDefault();
    drag = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY };
    panning = mode === 'pan';
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    const p = pointer(event);
    if (!drag || drag.pointerId !== event.pointerId) {
      onhover?.(p);
      return;
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (drag.mode === 'alt' && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > ALT_PAN_THRESHOLD_PX) {
      drag.mode = 'pan';
      panning = true;
      camera.panBy(event.clientX - drag.startX - dx, event.clientY - drag.startY - dy);
    }
    if (drag.mode === 'pan') {
      userMoved = true;
      camera.panBy(dx, dy);
      invalidate();
      onviewchange?.();
    } else if (drag.mode === 'tool') {
      onprimarymove?.(p);
    }
  }

  function endDrag(event: PointerEvent, cancelled: boolean): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const p = pointer(event);
    const mode = drag.mode;
    drag = null;
    panning = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (mode === 'tool') onprimaryup?.(p);
    else if (mode === 'alt' && !cancelled) onaltclick?.(p);
  }

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function onWindowKeyDown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || isEditable(event.target)) return;
    if (!(event.target instanceof HTMLButtonElement)) event.preventDefault();
    spaceHeld = true;
  }

  function onWindowKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') spaceHeld = false;
  }

  function onStageKeyDown(event: KeyboardEvent): void {
    const step = TUNING.stage.keyPanPx;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (move) {
      camera.panBy(move[0], move[1]);
    } else if (event.key === '+' || event.key === '=') {
      camera.zoomAtCenter(TUNING.zoom.buttonStep);
    } else if (event.key === '-' || event.key === '_') {
      camera.zoomAtCenter(1 / TUNING.zoom.buttonStep);
    } else if (event.key === '0') {
      camera.fit(scene.initialZoom(camera));
    } else {
      return;
    }
    userMoved = event.key !== '0';
    event.preventDefault();
    invalidate();
    onviewchange?.();
  }

  const activeCursor = $derived(panning ? 'grabbing' : spaceHeld ? 'grab' : cursor);
</script>

<svelte:window onkeydown={onWindowKeyDown} onkeyup={onWindowKeyUp} onblur={() => (spaceHeld = false)} />

<!-- The stage is a focusable application region: arrow keys pan and +/- zoom. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="stage"
  bind:this={wrap}
  role="application"
  aria-label={label}
  tabindex="0"
  style:cursor={activeCursor}
  onkeydown={onStageKeyDown}
>
  <canvas
    class="stage-canvas"
    bind:this={canvas}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={(event) => endDrag(event, false)}
    onpointercancel={(event) => endDrag(event, true)}
    onpointerleave={() => {
      if (!drag) onhover?.(null);
    }}
    oncontextmenu={(event) => event.preventDefault()}
  ></canvas>
  <canvas class="stage-fx" bind:this={fxCanvas} aria-hidden="true"></canvas>
  {#if children}
    <div class="stage-overlay">{@render children()}</div>
  {/if}
</div>

<style>
  @layer components {
    .stage {
      position: relative;
      min-width: 0;
      min-height: 0;
      overflow: clip;
      contain: strict;
      background:
        radial-gradient(circle at 50% 40%, var(--stage-glow) 0%, transparent 70%),
        var(--bg);
      touch-action: none;
      user-select: none;

      &:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: -4px;
      }
    }

    .stage-canvas,
    .stage-fx {
      position: absolute;
      image-rendering: pixelated;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }

    .stage-fx {
      pointer-events: none;
    }

    .stage-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;

      & > :global(*) {
        pointer-events: auto;
      }
    }
  }
</style>
