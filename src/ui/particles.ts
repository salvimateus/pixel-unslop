import { TUNING } from '../app/tuning.ts';

export interface BurstOptions {
  count: number;
  colors: readonly string[];
  /** Pixels per second. */
  speed: readonly [number, number];
  /** Center direction in radians (0 points right, positive turns down). */
  angle?: number;
  /** Full cone width in radians. 2π is a full circle. */
  spread?: number;
  gravity?: number;
  /** Seconds. */
  life: readonly [number, number];
  /** Side of the square, in CSS pixels. */
  size: readonly [number, number];
  /** Random start offset around (x, y), in CSS pixels. */
  jitter?: number;
}

/** Square particles from a fixed pool, drawn with fillRect grouped by color. Screen space, CSS pixels. */
export class ParticleField {
  enabled = true;
  private readonly capacity: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly gravity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Uint8Array;
  private readonly palette: string[] = [];
  private readonly paletteIndex = new Map<string, number>();
  private count = 0;

  constructor(capacity: number = TUNING.particles.budget) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.color = new Uint8Array(capacity);
  }

  get alive(): boolean {
    return this.count > 0;
  }

  burst(x: number, y: number, options: BurstOptions): void {
    if (!this.enabled || options.colors.length === 0) return;
    const spread = options.spread ?? Math.PI * 2;
    const angle = options.angle ?? 0;
    const jitter = options.jitter ?? 0;
    const room = this.capacity - this.count;
    const total = Math.min(options.count, room);
    for (let n = 0; n < total; n++) {
      const i = this.count++;
      const direction = angle + (Math.random() - 0.5) * spread;
      const speed = between(options.speed);
      this.x[i] = x + (Math.random() - 0.5) * jitter;
      this.y[i] = y + (Math.random() - 0.5) * jitter;
      this.vx[i] = Math.cos(direction) * speed;
      this.vy[i] = Math.sin(direction) * speed;
      this.gravity[i] = options.gravity ?? TUNING.particles.gravity;
      this.maxLife[i] = this.life[i] = between(options.life);
      this.size[i] = between(options.size);
      this.color[i] = this.colorSlot(options.colors[n % options.colors.length]);
    }
  }

  /** Returns true while a particle is alive. */
  step(dt: number): boolean {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.removeAt(i);
        continue;
      }
      this.vy[i] += this.gravity[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      i++;
    }
    if (this.count === 0) this.resetPalette();
    return this.count > 0;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.count === 0) return;
    for (let slot = 0; slot < this.palette.length; slot++) {
      ctx.fillStyle = this.palette[slot];
      for (let i = 0; i < this.count; i++) {
        if (this.color[i] !== slot) continue;
        const side = this.size[i] * Math.min(1, (this.life[i] / this.maxLife[i]) * 1.6);
        ctx.fillRect(this.x[i] - side / 2, this.y[i] - side / 2, side, side);
      }
    }
  }

  clear(): void {
    this.count = 0;
    this.resetPalette();
  }

  private colorSlot(color: string): number {
    const known = this.paletteIndex.get(color);
    if (known !== undefined) return known;
    if (this.palette.length >= TUNING.particles.maxColors) return this.palette.length - 1;
    this.palette.push(color);
    this.paletteIndex.set(color, this.palette.length - 1);
    return this.palette.length - 1;
  }

  private resetPalette(): void {
    this.palette.length = 0;
    this.paletteIndex.clear();
  }

  private removeAt(i: number): void {
    const last = --this.count;
    this.x[i] = this.x[last];
    this.y[i] = this.y[last];
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.gravity[i] = this.gravity[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size[i] = this.size[last];
    this.color[i] = this.color[last];
  }
}

function between(range: readonly [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}
