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
}

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

/** One palette for sprites that already merged their own colors: the second stage of mergeShared. */
export function unifyPalettes(own: Sprite[], options: MergeOptions): Sprite[] {
  const counts = new Map<number, number>();
  for (const sprite of own) for (const { color, count } of listPalette(sprite.pixels)) counts.set(color, (counts.get(color) ?? 0) + count);
  const entries = [...counts.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count || a.color - b.color);
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
