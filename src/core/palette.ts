import { TRANSPARENT, blue, green, pack, red, toOklab } from './color.ts';
import { PARAMS } from './params.ts';
import type { MergeOptions } from './protocol.ts';
import { listPalette } from './sprite.ts';
import type { Sprite } from './types.ts';

export interface ColorCount { color: number; count: number }

/** Leader clustering stops growing above this many leaders before the maxColors reduction. */
const MAX_LEADERS_FOR_REDUCTION = 2048;

class LabTable {
  readonly l: Float64Array;
  readonly a: Float64Array;
  readonly b: Float64Array;

  constructor(colors: ArrayLike<number>) {
    this.l = new Float64Array(colors.length);
    this.a = new Float64Array(colors.length);
    this.b = new Float64Array(colors.length);
    for (let i = 0; i < colors.length; i++) this.set(i, colors[i]);
  }

  set(i: number, color: number): void {
    const [l, a, b] = toOklab(color);
    this.l[i] = l;
    this.a[i] = a;
    this.b[i] = b;
  }

  distance(i: number, other: LabTable, j: number): number {
    return Math.hypot(this.l[i] - other.l[j], this.a[i] - other.a[j], this.b[i] - other.b[j]);
  }

  /** Applies the tone to every color, in place. */
  move(tone: Tone): this {
    for (let i = 0; i < this.l.length; i++) {
      this.l[i] = tone.scale * this.l[i] + tone.l;
      this.a[i] = tone.scale * this.a[i] + tone.a;
      this.b[i] = tone.scale * this.b[i] + tone.b;
    }
    return this;
  }
}

/** A uniform OKLab scale (a linear gain of the image) plus an offset. */
interface Tone { scale: number; l: number; a: number; b: number }

const NO_TONE: Tone = { scale: 1, l: 0, a: 0, b: 0 };

/** Index of the nearest color of `targets` (lowest index on ties). */
function nearest(source: LabTable, i: number, targets: LabTable, count: number): { index: number; distance: number } {
  let index = -1;
  let distance = Infinity;
  for (let j = 0; j < count; j++) {
    const d = source.distance(i, targets, j);
    if (d < distance) {
      distance = d;
      index = j;
    }
  }
  return { index, distance };
}

/** Count-weighted lower median per channel. */
function medianOf(members: ColorCount[]): number {
  let total = 0;
  for (const m of members) total += m.count;
  const half = total / 2;
  const channel = (get: (color: number) => number) => {
    const sorted = members.map((m) => ({ v: get(m.color), w: m.count })).sort((p, q) => p.v - q.v);
    let sum = 0;
    for (const entry of sorted) {
      sum += entry.w;
      if (sum >= half) return entry.v;
    }
    return sorted[sorted.length - 1].v;
  };
  return pack(channel(red), channel(green), channel(blue));
}

function leaderClusters(entries: ColorCount[], labs: LabTable, strength: number): number[] {
  const leaders: number[] = [];
  const leaderLabs = new LabTable(new Uint32Array(entries.length));
  for (let i = 0; i < entries.length; i++) {
    const found = nearest(labs, i, leaderLabs, leaders.length);
    if (found.index < 0 || !(found.distance < strength)) {
      leaderLabs.set(leaders.length, entries[i].color);
      leaders.push(entries[i].color);
    }
  }
  return leaders;
}

/** Assigns each entry to its nearest leader; returns the members per leader. */
function assign(entries: ColorCount[], labs: LabTable, leaders: number[]): ColorCount[][] {
  const leaderLabs = new LabTable(leaders);
  const members: ColorCount[][] = leaders.map(() => []);
  for (let i = 0; i < entries.length; i++) members[nearest(labs, i, leaderLabs, leaders.length).index].push(entries[i]);
  return members;
}

/** Merges the closest pair of clusters until at most maxColors remain. The heavier cluster keeps its color. */
function reduce(clusters: Array<{ color: number; weight: number; members: ColorCount[] }>, maxColors: number): void {
  const labs = new LabTable(clusters.map((c) => c.color));
  const alive = clusters.map(() => true);
  const neighbor = new Int32Array(clusters.length).fill(-1);
  const gap = new Float64Array(clusters.length).fill(Infinity);
  const update = (i: number) => {
    neighbor[i] = -1;
    gap[i] = Infinity;
    for (let j = 0; j < clusters.length; j++) {
      if (j === i || !alive[j]) continue;
      const d = labs.distance(i, labs, j);
      if (d < gap[i]) {
        gap[i] = d;
        neighbor[i] = j;
      }
    }
  };
  for (let i = 0; i < clusters.length; i++) update(i);
  let count = clusters.length;
  while (count > maxColors) {
    let a = -1;
    for (let i = 0; i < clusters.length; i++) if (alive[i] && neighbor[i] >= 0 && (a < 0 || gap[i] < gap[a])) a = i;
    if (a < 0) break;
    const b = neighbor[a];
    const heavier = clusters[a].weight > clusters[b].weight || (clusters[a].weight === clusters[b].weight && a < b) ? a : b;
    const lighter = heavier === a ? b : a;
    clusters[heavier].weight += clusters[lighter].weight;
    clusters[heavier].members.push(...clusters[lighter].members);
    alive[lighter] = false;
    count--;
    for (let i = 0; i < clusters.length; i++) if (alive[i] && (i === heavier || neighbor[i] === a || neighbor[i] === b)) update(i);
  }
  for (let i = clusters.length - 1; i >= 0; i--) if (!alive[i]) clusters.splice(i, 1);
}

/**
 * Maps each color to the color of its cluster. Equal intended colors become identical.
 * `entries` must be sorted by count descending, then by value ascending.
 */
export function clusterColors(entries: ColorCount[], options: MergeOptions, refinePasses: number = PARAMS.palette.refinePasses): Map<number, number> {
  const map = new Map<number, number>();
  const strength = Number.isFinite(options.strength) ? Math.max(0, options.strength) : 0;
  const maxColors = options.maxColors !== undefined && Number.isFinite(options.maxColors) && options.maxColors >= 1 ? Math.floor(options.maxColors) : 0;
  if (entries.length === 0 || (strength <= 0 && (maxColors === 0 || entries.length <= maxColors))) {
    for (const e of entries) map.set(e.color, e.color);
    return map;
  }
  const labs = new LabTable(entries.map((e) => e.color));
  let leaders = leaderClusters(entries, labs, strength);
  if (maxColors > 0) {
    let wider = Math.max(strength, 0.005);
    while (leaders.length > MAX_LEADERS_FOR_REDUCTION) {
      wider *= 1.5;
      leaders = leaderClusters(entries, labs, wider);
    }
  }
  let members = assign(entries, labs, leaders);
  for (let pass = 0; pass < refinePasses; pass++) {
    leaders = members.filter((m) => m.length > 0).map(medianOf);
    members = assign(entries, labs, leaders);
  }
  const clusters = leaders
    .map((color, i) => ({ color, weight: members[i].reduce((sum, m) => sum + m.count, 0), members: members[i] }))
    .filter((c) => c.members.length > 0);
  if (maxColors > 0 && clusters.length > maxColors) reduce(clusters, maxColors);
  for (const cluster of clusters) for (const m of cluster.members) map.set(m.color, cluster.color);
  return map;
}

export function applyColorMap(sprite: Sprite, map: Map<number, number>): Sprite {
  const pixels = new Uint32Array(sprite.pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const color = sprite.pixels[i];
    pixels[i] = color === TRANSPARENT ? TRANSPARENT : (map.get(color) ?? color);
  }
  return { cols: sprite.cols, rows: sprite.rows, pixels };
}

/** The unique opaque colors of the sprite, sorted by count descending, then by value ascending. */
export function paletteOf(sprite: Sprite): Uint32Array {
  return Uint32Array.from(listPalette(sprite.pixels).map((entry) => entry.color));
}

/** Palette merge of one sprite. */
export function mergePalette(raw: Sprite, options: MergeOptions): { sprite: Sprite; palette: Uint32Array } {
  const sprite = applyColorMap(raw, clusterColors(listPalette(raw.pixels), options));
  return { sprite, palette: paletteOf(sprite) };
}

/**
 * One palette for several sprites. Each sprite first merges its own colors, so a color that is rare in the
 * set (a red scarf among brown pieces) keeps its hue. Then the palettes of all sprites merge with a
 * smaller strength and no median refinement: each cluster takes the color of its heaviest member.
 */
export function mergeShared(raws: Sprite[], options: MergeOptions): Sprite[] {
  return unifyPalettes(raws.map((raw) => mergePalette(raw, { strength: options.strength }).sprite), options);
}

/** The opaque colors of several sprites with their summed counts, sorted by count descending, then by value ascending. */
export function combinedColors(sprites: readonly Sprite[]): ColorCount[] {
  const counts = new Map<number, number>();
  for (const sprite of sprites) for (const { color, count } of listPalette(sprite.pixels)) counts.set(color, (counts.get(color) ?? 0) + count);
  return [...counts.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count || a.color - b.color);
}

/** One palette for sprites that already merged their own colors: the second stage of mergeShared. */
export function unifyPalettes(own: Sprite[], options: MergeOptions): Sprite[] {
  const entries = combinedColors(own);
  const shared = { strength: options.strength * PARAMS.palette.sharedFactor, maxColors: options.maxColors };
  const map = clusterColors(entries, shared, 0);
  return own.map((sprite) => applyColorMap(sprite, map));
}

/** Maps every opaque tile to the nearest color of `palette` in OKLab. */
export function mapToPalette(sprite: Sprite, palette: ArrayLike<number>): Sprite {
  if (palette.length === 0) return { cols: sprite.cols, rows: sprite.rows, pixels: sprite.pixels.slice() };
  const targets = new LabTable(palette);
  const entries = listPalette(sprite.pixels);
  const labs = new LabTable(entries.map((e) => e.color));
  const map = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) map.set(entries[i].color, palette[nearest(labs, i, targets, palette.length).index]);
  return applyColorMap(sprite, map);
}

/** How much color mass of two palettes meets under `tone`: each pair counts by both tile counts and by its closeness. */
function overlap(source: LabTable, weights: Float64Array, targets: LabTable, targetWeights: Float64Array, tone: Tone, radius: number): number {
  const limit = radius * radius;
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    const l = tone.scale * source.l[i] + tone.l;
    const a = tone.scale * source.a[i] + tone.a;
    const b = tone.scale * source.b[i] + tone.b;
    let inner = 0;
    for (let j = 0; j < targetWeights.length; j++) {
      const dl = l - targets.l[j];
      const da = a - targets.a[j];
      const db = b - targets.b[j];
      const d2 = dl * dl + da * da + db * db;
      if (d2 >= limit) continue;
      const near = 1 - d2 / limit;
      inner += targetWeights[j] * near * near;
    }
    sum += weights[i] * inner;
  }
  return sum;
}

/** Steps of one tone axis, nearest first: 0, +1, -1, +2, -2 and so on. */
function stepOrder(steps: number): number[] {
  const order = [0];
  for (let k = 1; k <= steps; k++) order.push(k, -k);
  return order;
}

/**
 * The tone change that all colors of the image share against the reference. The candidates are a fixed grid
 * that starts at "no change"; a later candidate wins only with a higher score, so a tie keeps the smaller change.
 * A change must beat "no change" by `minGain`, else the result is NO_TONE. Only basic arithmetic and strict
 * comparisons decide, so every runtime gives the same tone.
 */
function sharedTone(entries: readonly ColorCount[], reference: readonly ColorCount[]): Tone {
  const params = PARAMS.palette.reference;
  const top = entries.slice(0, params.topColors);
  const topReference = reference.slice(0, params.topColors);
  const source = new LabTable(top.map((e) => e.color));
  const targets = new LabTable(topReference.map((e) => e.color));
  const weights = Float64Array.from(top, (e) => e.count);
  const targetWeights = Float64Array.from(topReference, (e) => e.count);
  let best = NO_TONE;
  let bestScore = overlap(source, weights, targets, targetWeights, NO_TONE, params.radius) * (1 + params.minGain);
  const lights = stepOrder(params.lightSteps);
  const chromas = stepOrder(params.chromaSteps);
  for (const scale of params.scales) {
    for (const il of lights) {
      for (const ia of chromas) {
        for (const ib of chromas) {
          const tone: Tone = { scale, l: il * params.step, a: ia * params.step, b: ib * params.step };
          const score = overlap(source, weights, targets, targetWeights, tone, params.radius);
          if (score > bestScore) {
            best = tone;
            bestScore = score;
          }
        }
      }
    }
  }
  return best;
}

/**
 * The reference color of each color of an image: the nearest reference color in OKLab (lowest index on ties),
 * after the tone change that all colors share is taken out. Both lists are sorted by count descending, then by
 * value ascending. An empty reference maps each color to itself. With no tone change the result is mapToPalette.
 */
export function matchColors(entries: readonly ColorCount[], reference: readonly ColorCount[]): Map<number, number> {
  const map = new Map<number, number>();
  if (reference.length === 0) {
    for (const e of entries) map.set(e.color, e.color);
    return map;
  }
  if (entries.length === 0) return map;
  const tone = sharedTone(entries, reference);
  const labs = new LabTable(entries.map((e) => e.color));
  if (tone !== NO_TONE) labs.move(tone);
  const targets = new LabTable(reference.map((e) => e.color));
  for (let i = 0; i < entries.length; i++) map.set(entries[i].color, reference[nearest(labs, i, targets, reference.length).index].color);
  return map;
}

/** The sprite painted with the colors of the reference (see matchColors). Transparent tiles stay. */
export function matchToReference(sprite: Sprite, reference: readonly ColorCount[]): Sprite {
  return applyColorMap(sprite, matchColors(listPalette(sprite.pixels), reference));
}
