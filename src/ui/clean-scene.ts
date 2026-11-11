import type { Sprite } from '../core/types.ts';
import { TRANSPARENT } from '../core/color.ts';
import { TUNING } from '../app/tuning.ts';
import { clamp, type Camera, type Tile } from './camera.ts';
import {
  sparkColors,
  STAGE_COLORS,
  checkerPattern,
  contentRect,
  cssColor,
  drawFrame,
  easeInOutCubic,
  easeOutCubic,
  gridPath,
  intersect,
  progress,
  strokeGrid,
  viewRect,
  type Rect,
  type Scene,
  type StageHost,
} from './stage-renderer.ts';

export type PreviewBackground = 'checker' | 'dark' | 'light';

/** What the tile under the cursor shows: the ink that a click paints, an eraser mark or a picker mark. */
export type HoverMark = { kind: 'paint'; color: number } | { kind: 'erase' } | { kind: 'pick' } | null;

interface Wave {
  order: Int32Array;
  distance: Uint16Array;
  colors: Uint32Array;
  written: number;
  start: number;
  stepMs: number;
}

interface Pop {
  col: number;
  row: number;
  start: number;
}

interface Ripple {
  col: number;
  row: number;
  start: number;
}

export interface CompareLabels {
  before: string;
  after: string;
}

/** The Limpar screen: the before/after comparison, the sprite layer, the tool marks and the edit effects. */
export class CleanScene implements Scene {
  readonly contentW: number;
  readonly contentH: number;
  readonly maxZoom = TUNING.zoom.cleanMax;
  background: PreviewBackground = 'checker';
  showGrid = false;
  /** Fraction of the width that shows "before", from the left edge. */
  split = 0;
  private host: StageHost | null = null;
  private aligned: ImageBitmap;
  private readonly labels: CompareLabels;
  private readonly spriteCanvas: HTMLCanvasElement;
  private readonly spriteCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly image32: Uint32Array;
  private readonly boundsX: Float64Array;
  private readonly boundsY: Float64Array;
  private hover: Tile | null = null;
  private hoverMark: HoverMark = null;
  private sweepStart = -1;
  private waves: Wave[] = [];
  private pops: Pop[] = [];
  private ripples: Ripple[] = [];

  /** The entry sweep waits for the stage, because it needs the camera and the motion setting. */
  private introPending: boolean;

  constructor(sprite: Sprite, aligned: ImageBitmap, labels: CompareLabels, intro: boolean) {
    this.introPending = intro;
    this.contentW = sprite.cols;
    this.contentH = sprite.rows;
    this.aligned = aligned;
    this.labels = labels;
    this.spriteCanvas = document.createElement('canvas');
    this.spriteCanvas.width = sprite.cols;
    this.spriteCanvas.height = sprite.rows;
    const ctx = this.spriteCanvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.spriteCtx = ctx;
    this.image = ctx.createImageData(sprite.cols, sprite.rows);
    this.image32 = new Uint32Array(this.image.data.buffer);
    this.boundsX = Float64Array.from({ length: sprite.cols + 1 }, (_, i) => i);
    this.boundsY = Float64Array.from({ length: sprite.rows + 1 }, (_, i) => i);
    this.setSprite(sprite);
  }

  attach(host: StageHost | null): void {
    this.host = host;
    if (host && this.introPending) {
      this.introPending = false;
      this.playSweep();
    }
  }

  initialZoom(camera: Camera): number {
    return camera.fitZoom();
  }

  setAligned(aligned: ImageBitmap): void {
    this.aligned = aligned;
    this.host?.invalidate();
  }

  setSprite(sprite: Sprite): void {
    this.flushWaves();
    this.image32.set(sprite.pixels);
    this.spriteCtx.putImageData(this.image, 0, 0);
    this.host?.invalidate();
  }

  /** Writes only the changed tiles into the sprite layer. */
  writeTiles(indices: ArrayLike<number>, pixels: Uint32Array): void {
    this.flushWaves();
    if (indices.length === 0) return;
    for (let i = 0; i < indices.length; i++) this.image32[indices[i]] = pixels[indices[i]];
    this.putIndices(indices);
  }

  /** Live preview of one tile during a stroke, before the stroke becomes an undo step. */
  writeTile(index: number, color: number): void {
    this.flushWaves();
    this.image32[index] = color;
    this.putIndices([index]);
  }

  /** Fills the region tile by tile in BFS distance order, as a wave from the click. */
  startWave(indices: Int32Array, distance: Uint16Array, pixels: Uint32Array): void {
    this.flushWaves();
    if (indices.length === 0) return;
    const positions = Array.from(indices.keys()).sort((a, b) => distance[a] - distance[b]);
    const order = Int32Array.from(positions, (p) => indices[p]);
    const sortedDistance = Uint16Array.from(positions, (p) => distance[p]);
    const colors = Uint32Array.from(order, (index) => pixels[index]);
    const maxDistance = sortedDistance[sortedDistance.length - 1] || 1;
    const wave: Wave = {
      order,
      distance: sortedDistance,
      colors,
      written: 0,
      start: performance.now(),
      stepMs: Math.min(TUNING.clean.waveStepMs, TUNING.clean.waveMaxMs / maxDistance),
    };
    if (this.host?.reducedMotion) {
      this.advanceWave(wave, Infinity);
      return;
    }
    this.waves.push(wave);
    this.host?.invalidate();
  }

  flushWaves(): void {
    if (this.waves.length === 0) return;
    const waves = this.waves;
    this.waves = [];
    for (const wave of waves) this.advanceWave(wave, Infinity);
  }

  setHover(tile: Tile | null, mark: HoverMark): void {
    const same = tile?.col === this.hover?.col && tile?.row === this.hover?.row && sameMark(mark, this.hoverMark);
    this.hover = tile;
    this.hoverMark = mark;
    if (!same) this.host?.invalidate();
  }

  pop(tile: Tile): void {
    if (this.host?.reducedMotion) return;
    this.pops.push({ col: tile.col, row: tile.row, start: performance.now() });
    this.host?.invalidate();
  }

  ripple(tile: Tile): void {
    if (this.host?.reducedMotion) return;
    this.ripples.push({ col: tile.col, row: tile.row, start: performance.now() });
    this.host?.invalidate();
  }

  /** Erased tiles fall as particles in their old color. */
  shatter(indices: ArrayLike<number>, oldPixels: Uint32Array): void {
    const host = this.host;
    if (!host || host.reducedMotion || indices.length === 0) return;
    const { camera, particles } = host;
    const stride = Math.max(1, Math.ceil(indices.length / TUNING.particles.eraseMaxTiles));
    const side = clamp(camera.zoom * 0.45, 2, 14);
    for (let i = 0; i < indices.length; i += stride) {
      const index = indices[i];
      const color = oldPixels[index];
      if (color === TRANSPARENT) continue;
      const p = camera.imageToScreen((index % this.contentW) + 0.5, Math.floor(index / this.contentW) + 0.5);
      particles.burst(p.x, p.y, {
        count: TUNING.particles.eraseShards,
        colors: [cssColor(color)],
        speed: [40, 190],
        angle: -Math.PI / 2,
        spread: Math.PI * 0.9,
        life: [0.35, 0.75],
        size: [side * 0.6, side],
        jitter: camera.zoom * 0.6,
      });
    }
    host.invalidate();
  }

  playSweep(): void {
    if (!this.host || this.host.reducedMotion) {
      this.split = 0;
      this.sweepStart = -1;
    } else {
      this.split = 1;
      this.sweepStart = performance.now();
    }
    this.host?.invalidate();
  }

  get sweeping(): boolean {
    return this.sweepStart >= 0;
  }

  splitScreenX(): number {
    if (!this.host) return 0;
    const rect = contentRect(this.host.camera);
    return rect.x + rect.w * this.split;
  }

  hitSplit(sx: number, sy: number): boolean {
    if (!this.host) return false;
    const rect = contentRect(this.host.camera);
    return Math.abs(sx - this.splitScreenX()) <= TUNING.clean.splitHitPx && sy >= rect.y - 8 && sy <= rect.y + rect.h + 8;
  }

  setSplitFromScreen(sx: number): void {
    if (!this.host) return;
    const rect = contentRect(this.host.camera);
    this.setSplit((sx - rect.x) / Math.max(1, rect.w));
  }

  setSplit(value: number): void {
    this.sweepStart = -1;
    this.split = clamp(value, 0, 1);
    this.host?.invalidate();
  }

  draw(ctx: CanvasRenderingContext2D, fx: CanvasRenderingContext2D, now: number): boolean {
    const host = this.host;
    if (!host) return false;
    const { camera, dpr } = host;
    const rect = contentRect(camera);
    const clip = intersect(rect, viewRect(camera));
    let alive = false;

    if (this.sweepStart >= 0) {
      const t = progress(now, this.sweepStart, TUNING.clean.sweepMs);
      this.split = 1 - easeInOutCubic(t);
      if (t >= 1) {
        this.sweepStart = -1;
        this.split = 0;
      } else {
        alive = true;
        if (clip) this.sweepSparks(clip, rect);
      }
    }

    drawFrame(ctx, rect, dpr);
    if (!clip) {
      this.flushWaves();
      this.pops = [];
      this.ripples = [];
      return alive;
    }
    ctx.fillStyle = this.background === 'checker' ? checkerPattern(ctx) : this.background === 'dark' ? STAGE_COLORS.previewDark : STAGE_COLORS.previewLight;
    ctx.fillRect(clip.x, clip.y, clip.w, clip.h);

    const splitX = rect.x + rect.w * this.split;
    ctx.imageSmoothingEnabled = false;
    if (this.split > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, Math.max(0, splitX - clip.x), clip.h);
      ctx.clip();
      ctx.drawImage(this.aligned, rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }
    if (this.split < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, clip.y, Math.max(0, clip.x + clip.w - splitX), clip.h);
      ctx.clip();
      ctx.drawImage(this.spriteCanvas, rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }

    if (this.showGrid && camera.zoom >= TUNING.grid.minCellPx) {
      const path = gridPath(this.boundsX, this.boundsY, camera, clip, dpr);
      strokeGrid(ctx, path, dpr, STAGE_COLORS.gridSoft, camera.zoom >= TUNING.grid.haloMinCellPx);
    }

    alive = this.drawWaves(fx, camera, now) || alive;
    if (this.sweepStart < 0) this.drawHover(ctx, camera, dpr);
    this.drawSplit(ctx, rect, clip, splitX);
    alive = this.drawPops(fx, camera, now) || alive;
    alive = this.drawRipples(fx, camera, now) || alive;
    return alive;
  }

  private putIndices(indices: ArrayLike<number>): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < indices.length; i++) {
      const x = indices[i] % this.contentW;
      const y = Math.floor(indices[i] / this.contentW);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0) return;
    this.spriteCtx.putImageData(this.image, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
    this.host?.invalidate();
  }

  private advanceWave(wave: Wave, front: number): void {
    const from = wave.written;
    while (wave.written < wave.order.length && wave.distance[wave.written] <= front) {
      this.image32[wave.order[wave.written]] = wave.colors[wave.written];
      wave.written++;
    }
    if (wave.written > from) this.putIndices(wave.order.subarray(from, wave.written));
  }

  private drawWaves(fx: CanvasRenderingContext2D, camera: Camera, now: number): boolean {
    if (this.waves.length === 0) return false;
    const zoom = camera.zoom;
    fx.fillStyle = STAGE_COLORS.wave;
    for (const wave of this.waves) {
      const front = (now - wave.start) / wave.stepMs;
      this.advanceWave(wave, front);
      for (let i = wave.written - 1; i >= 0 && wave.distance[i] >= front - 1.5; i--) {
        const index = wave.order[i];
        const p = camera.imageToScreen(index % this.contentW, Math.floor(index / this.contentW));
        fx.fillRect(p.x, p.y, zoom, zoom);
      }
    }
    this.waves = this.waves.filter((wave) => wave.written < wave.order.length);
    return true;
  }

  private drawHover(ctx: CanvasRenderingContext2D, camera: Camera, dpr: number): void {
    const tile = this.hover;
    const mark = this.hoverMark;
    if (!tile || !mark) return;
    const p = camera.imageToScreen(tile.col, tile.row);
    const size = camera.zoom;
    if (mark.kind === 'paint' && mark.color !== TRANSPARENT) {
      ctx.fillStyle = cssColor(mark.color);
      ctx.globalAlpha = 0.8;
      ctx.fillRect(p.x, p.y, size, size);
      ctx.globalAlpha = 1;
    }
    const color = mark.kind === 'erase' || (mark.kind === 'paint' && mark.color === TRANSPARENT) ? STAGE_COLORS.danger : mark.kind === 'pick' ? STAGE_COLORS.teal : STAGE_COLORS.white;
    const line = Math.max(1, Math.min(2, size / 8));
    ctx.strokeStyle = STAGE_COLORS.shadow;
    ctx.lineWidth = (line + 2) / dpr;
    ctx.strokeRect(p.x, p.y, size, size);
    ctx.strokeStyle = color;
    ctx.lineWidth = line;
    ctx.strokeRect(p.x + line / 2, p.y + line / 2, size - line, size - line);
  }

  private drawSplit(ctx: CanvasRenderingContext2D, rect: Rect, clip: Rect, splitX: number): void {
    const knob = TUNING.clean.splitKnobPx;
    const top = clip.y;
    const bottom = clip.y + clip.h;
    if (splitX < clip.x - knob || splitX > clip.x + clip.w + knob) return;
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(splitX - 2, top, 4, bottom - top);
    ctx.fillStyle = STAGE_COLORS.white;
    ctx.fillRect(splitX - 1, top, 2, bottom - top);

    const cy = clamp(rect.y + rect.h / 2, top + knob, bottom - knob);
    const kx = Math.round(splitX - knob / 2);
    const ky = Math.round(cy - knob / 2);
    ctx.fillStyle = STAGE_COLORS.shadow;
    ctx.fillRect(kx + 3, ky + 3, knob, knob);
    ctx.fillStyle = STAGE_COLORS.white;
    ctx.fillRect(kx, ky, knob, knob);
    ctx.fillStyle = STAGE_COLORS.panel;
    const mid = ky + knob / 2;
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(kx + 6 + i, mid - 4 + i, 1, 8 - i * 2);
      ctx.fillRect(kx + knob - 7 - i, mid - 4 + i, 1, 8 - i * 2);
    }

    if (this.split <= 0.001 || this.sweepStart >= 0) return;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const labelY = Math.max(top + 14, rect.y + 14);
    this.drawLabel(ctx, this.labels.before, splitX - 10, labelY, 'right');
    if (this.split < 0.999) this.drawLabel(ctx, this.labels.after, splitX + 10, labelY, 'left');
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: 'left' | 'right'): void {
    const width = ctx.measureText(text).width + 14;
    const left = align === 'right' ? x - width : x;
    ctx.fillStyle = STAGE_COLORS.panel;
    ctx.fillRect(left, y - 11, width, 22);
    ctx.fillStyle = STAGE_COLORS.white;
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 7, y + 1);
  }

  private sweepSparks(clip: Rect, rect: Rect): void {
    const host = this.host;
    if (!host) return;
    const x = rect.x + rect.w * this.split;
    if (x < clip.x || x > clip.x + clip.w) return;
    const colors = sparkColors();
    for (let i = 0; i < TUNING.clean.sweepSparksPerFrame; i++) {
      host.particles.burst(x, clip.y + Math.random() * clip.h, {
        count: 1,
        colors: [colors[Math.floor(Math.random() * colors.length)]],
        speed: [80, 260],
        angle: Math.PI,
        spread: Math.PI * 0.7,
        gravity: 220,
        life: [0.25, TUNING.particles.sparkLifeS],
        size: [2, 5],
      });
    }
  }

  private drawPops(fx: CanvasRenderingContext2D, camera: Camera, now: number): boolean {
    if (this.pops.length === 0) return false;
    const { popMs, popScale } = TUNING.clean;
    this.pops = this.pops.filter((pop) => now - pop.start < popMs);
    fx.lineWidth = 2;
    for (const pop of this.pops) {
      const t = (now - pop.start) / popMs;
      const size = camera.zoom * (1 + popScale * easeOutCubic(t));
      const c = camera.imageToScreen(pop.col + 0.5, pop.row + 0.5);
      fx.globalAlpha = 1 - t;
      fx.strokeStyle = STAGE_COLORS.white;
      fx.strokeRect(c.x - size / 2, c.y - size / 2, size, size);
    }
    fx.globalAlpha = 1;
    return this.pops.length > 0;
  }

  private drawRipples(fx: CanvasRenderingContext2D, camera: Camera, now: number): boolean {
    if (this.ripples.length === 0) return false;
    const { rippleMs, rippleRadiusTiles } = TUNING.clean;
    this.ripples = this.ripples.filter((ripple) => now - ripple.start < rippleMs);
    fx.lineWidth = 3;
    for (const ripple of this.ripples) {
      const t = (now - ripple.start) / rippleMs;
      const half = camera.zoom * (0.5 + rippleRadiusTiles * easeOutCubic(t));
      const c = camera.imageToScreen(ripple.col + 0.5, ripple.row + 0.5);
      fx.globalAlpha = (1 - t) * 0.9;
      fx.strokeStyle = STAGE_COLORS.accent;
      fx.strokeRect(c.x - half, c.y - half, half * 2, half * 2);
    }
    fx.globalAlpha = 1;
    return this.ripples.length > 0;
  }
}

function sameMark(a: HoverMark, b: HoverMark): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind !== 'paint' || (b.kind === 'paint' && a.color === b.color);
}
