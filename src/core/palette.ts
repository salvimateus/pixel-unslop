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

/** Integer units of the plan: one share of tiles is MASS_UNIT, and a squared OKLab distance of 1 costs COST_UNIT. */
const MASS_UNIT = 1_000_000_000;
const COST_UNIT = 1_000_000;
/** Keeps the curve fit defined when the pairs have fewer than three lightness values: it holds the scale and the bend at zero. */
const RIDGE = 1e-6;
/** The curve fit has no solution when a pivot is smaller than this. */
const MIN_PIVOT = 1e-12;

/** A lightness move c0 + c1 L + c2 L^2. */
type Curve = [number, number, number];

/** The colors that the plan reads. `of[i]` is the plan color of entry i. */
interface PlanColors { colors: readonly ColorCount[]; of: Int32Array }

/** The two palettes of the plan. Only the first `imageSize` and `targetSize` plan colors take part. */
interface Plan {
  image: PlanColors;
  target: PlanColors;
  labs: LabTable;
  targets: LabTable;
  imageSize: number;
  targetSize: number;
  imageTotal: number;
  targetTotal: number;
}

/** Squared distance of color i, at lightness `light[i]`, to color j of `targets`. */
function squaredGap(labs: LabTable, light: Float64Array, i: number, targets: LabTable, j: number): number {
  const dl = light[i] - targets.l[j];
  const da = labs.a[i] - targets.a[j];
  const db = labs.b[i] - targets.b[j];
  return dl * dl + da * da + db * db;
}

/**
 * A palette of at most `topColors` colors is read as it is. A larger palette is merged first: each color joins the
 * heaviest color nearer than `planStrength`. Then the heaviest colors hold the image again.
 */
function planColors(entries: readonly ColorCount[]): PlanColors {
  const of = new Int32Array(entries.length);
  if (entries.length <= PARAMS.palette.reference.topColors) {
    for (let i = 0; i < of.length; i++) of[i] = i;
    return { colors: entries, of };
  }
  const leader = clusterColors(entries.slice(), { strength: PARAMS.palette.reference.planStrength }, 0);
  const counts = new Map<number, number>();
  for (const e of entries) {
    const to = leader.get(e.color) as number;
    counts.set(to, (counts.get(to) ?? 0) + e.count);
  }
  const colors = [...counts.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count || a.color - b.color);
  const index = new Map<number, number>();
  colors.forEach((e, k) => index.set(e.color, k));
  for (let i = 0; i < of.length; i++) of[i] = index.get(leader.get(entries[i].color) as number) as number;
  return { colors, of };
}

function planOf(entries: readonly ColorCount[], reference: readonly ColorCount[]): Plan {
  const topColors = PARAMS.palette.reference.topColors;
  const image = planColors(entries);
  const target = planColors(reference);
  let imageTotal = 0;
  let targetTotal = 0;
  for (const e of entries) imageTotal += e.count;
  for (const e of reference) targetTotal += e.count;
  return {
    image,
    target,
    labs: new LabTable(image.colors.map((e) => e.color)),
    targets: new LabTable(target.colors.map((e) => e.color)),
    imageSize: Math.min(image.colors.length, topColors),
    targetSize: Math.min(target.colors.length, topColors),
    imageTotal,
    targetTotal,
  };
}

/** A flow network. Each edge has a reverse edge at index ^ 1. */
interface Graph { head: Int32Array; next: number[]; to: number[]; room: number[]; cost: number[] }

/** Adds an edge and its reverse edge. The edges of a node are read newest first. */
function addEdge(graph: Graph, from: number, to: number, room: number, cost: number): number {
  const id = graph.to.length;
  graph.to.push(to, from);
  graph.room.push(room, 0);
  graph.cost.push(cost, -cost);
  graph.next.push(graph.head[from], graph.head[to]);
  graph.head[from] = id;
  graph.head[to] = id + 1;
  return id;
}

/**
 * Min-cost flow by successive shortest paths, with integer rooms and costs, so each result is exact. Each round is a
 * dense Dijkstra on the reduced costs: the open node with the smallest distance goes first, lowest index on ties.
 * Then the path takes the largest flow that it permits. The flow stops when the sink has no path.
 */
function minCostFlow(graph: Graph, nodes: number, source: number, sink: number): void {
  const potential = new Float64Array(nodes);
  const distance = new Float64Array(nodes);
  const closed = new Uint8Array(nodes);
  const via = new Int32Array(nodes);
  for (;;) {
    distance.fill(Infinity);
    closed.fill(0);
    distance[source] = 0;
    for (;;) {
      let node = -1;
      for (let v = 0; v < nodes; v++) if (!closed[v] && distance[v] < Infinity && (node < 0 || distance[v] < distance[node])) node = v;
      if (node < 0) break;
      closed[node] = 1;
      for (let e = graph.head[node]; e >= 0; e = graph.next[e]) {
        if (graph.room[e] <= 0) continue;
        const v = graph.to[e];
        const d = distance[node] + graph.cost[e] + potential[node] - potential[v];
        if (d < distance[v]) {
          distance[v] = d;
          via[v] = e;
        }
      }
    }
    if (distance[sink] === Infinity) return;
    for (let v = 0; v < nodes; v++) if (distance[v] < Infinity) potential[v] += distance[v];
    let push = Infinity;
    for (let v = sink; v !== source; v = graph.to[via[v] ^ 1]) if (graph.room[via[v]] < push) push = graph.room[via[v]];
    for (let v = sink; v !== source; v = graph.to[via[v] ^ 1]) {
      graph.room[via[v]] -= push;
      graph.room[via[v] ^ 1] += push;
    }
  }
}

/**
 * The plan: the tile shares of the image colors go to the reference colors at the lowest sum of squared distances.
 * A reference color accepts its own share of tiles and no more. A tile pairs only with a color nearer than `reach`.
 * A tile with no partner costs as much as a pair at `reach`. `flow[i * targetSize + j]` is the share, in MASS_UNIT,
 * of image color i that reference color j gets.
 */
function transport(plan: Plan, light: Float64Array): Float64Array {
  const { image, target, labs, targets, imageSize, targetSize } = plan;
  const source = imageSize + targetSize;
  const sink = source + 1;
  const graph: Graph = { head: new Int32Array(sink + 1).fill(-1), next: [], to: [], room: [], cost: [] };
  const reach2 = PARAMS.palette.reference.reach * PARAMS.palette.reference.reach;
  const looseCost = Math.round(reach2 * COST_UNIT);
  const supply = new Float64Array(imageSize);
  for (let i = 0; i < imageSize; i++) {
    supply[i] = Math.round((image.colors[i].count / plan.imageTotal) * MASS_UNIT);
    addEdge(graph, source, i, supply[i], 0);
  }
  for (let j = 0; j < targetSize; j++) addEdge(graph, imageSize + j, sink, Math.round((target.colors[j].count / plan.targetTotal) * MASS_UNIT), 0);
  const pair = new Int32Array(imageSize * targetSize).fill(-1);
  for (let i = 0; i < imageSize; i++) {
    for (let j = 0; j < targetSize; j++) {
      const d2 = squaredGap(labs, light, i, targets, j);
      if (d2 < reach2) pair[i * targetSize + j] = addEdge(graph, i, imageSize + j, supply[i], Math.round(d2 * COST_UNIT));
    }
    addEdge(graph, i, sink, supply[i], looseCost);
  }
  minCostFlow(graph, sink + 1, source, sink);
  const flow = new Float64Array(imageSize * targetSize);
  for (let k = 0; k < flow.length; k++) if (pair[k] >= 0) flow[k] = graph.room[pair[k] + 1];
  return flow;
}

/** The lightness curve that fits the pairs of the plan best: least squares, each pair by its share of tiles. Null when it has no solution. */
function fitCurve(plan: Plan, flow: Float64Array, light: Float64Array): Curve | null {
  const { targets, imageSize, targetSize } = plan;
  const m = [[0, 0, 0], [0, RIDGE, 0], [0, 0, RIDGE]];
  const v = [0, 0, 0];
  for (let i = 0; i < imageSize; i++) {
    const x = light[i];
    const basis = [1, x, x * x];
    for (let j = 0; j < targetSize; j++) {
      const f = flow[i * targetSize + j];
      if (f <= 0) continue;
      const w = f / MASS_UNIT;
      const y = targets.l[j] - x;
      for (let p = 0; p < 3; p++) {
        v[p] += w * basis[p] * y;
        for (let q = 0; q < 3; q++) m[p][q] += w * basis[p] * basis[q];
      }
    }
  }
  // Gauss-Jordan. The pivot of a column is the first row with the largest absolute value.
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let row = c + 1; row < 3; row++) if (Math.abs(m[row][c]) > Math.abs(m[pivot][c])) pivot = row;
    if (Math.abs(m[pivot][c]) < MIN_PIVOT) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    [v[c], v[pivot]] = [v[pivot], v[c]];
    for (let row = 0; row < 3; row++) {
      if (row === c) continue;
      const f = m[row][c] / m[c][c];
      for (let k = c; k < 3; k++) m[row][k] -= f * m[c][k];
      v[row] -= f * v[c];
    }
  }
  return [v[0] / m[0][0], v[1] / m[1][1], v[2] / m[2][2]];
}

/** Moves each lightness by the curve. One move is `reach` at most. */
function moveLight(curve: Curve, from: Float64Array): Float64Array {
  const reach = PARAMS.palette.reference.reach;
  const next = new Float64Array(from.length);
  for (let i = 0; i < from.length; i++) {
    const x = from[i];
    let move = curve[0] + curve[1] * x + curve[2] * x * x;
    if (move > reach) move = reach;
    if (move < -reach) move = -reach;
    next[i] = x + move;
  }
  return next;
}

/**
 * Each pass pairs the tiles by share and distance, fits one lightness curve to the pairs and moves each color.
 * `planLight` is the lightness of the plan colors, `light` the lightness of each entry.
 */
function fitTone(plan: Plan, start: Float64Array): { planLight: Float64Array; light: Float64Array } {
  let planLight: Float64Array = plan.labs.l.slice();
  let light: Float64Array = start.slice();
  for (let pass = 0; pass < PARAMS.palette.reference.passes; pass++) {
    const curve = fitCurve(plan, transport(plan, planLight), planLight);
    if (!curve) break;
    planLight = moveLight(curve, planLight);
    light = moveLight(curve, light);
  }
  return { planLight, light };
}

/** The gate score: the pairs of colors nearer than `radius`, each by both tile counts and by its closeness. */
function meetScore(plan: Plan, light: Float64Array): number {
  const { image, target, labs, targets, imageSize, targetSize } = plan;
  const limit = PARAMS.palette.reference.radius * PARAMS.palette.reference.radius;
  let sum = 0;
  for (let i = 0; i < imageSize; i++) {
    let inner = 0;
    for (let j = 0; j < targetSize; j++) {
      const d2 = squaredGap(labs, light, i, targets, j);
      if (d2 >= limit) continue;
      const near = 1 - d2 / limit;
      inner += target.colors[j].count * near * near;
    }
    sum += image.colors[i].count * inner;
  }
  return sum;
}

/** The curve applies only when the two palettes meet clearly better with it. */
function passesGate(plan: Plan, planLight: Float64Array): boolean {
  return meetScore(plan, planLight) > meetScore(plan, plan.labs.l) * (1 + PARAMS.palette.reference.minGain);
}

/** The two nearest colors of `targets`, lowest index on ties. `second` is -1 or equal to `first` when no second color is nearer than Infinity. */
function nearestTwo(source: LabTable, i: number, targets: LabTable, count: number): { first: number; second: number; gap: number } {
  let first = 0;
  let second = -1;
  let d1 = Infinity;
  let d2 = Infinity;
  for (let j = 0; j < count; j++) {
    const d = source.distance(i, targets, j);
    if (d < d1) {
      second = first;
      d2 = d1;
      first = j;
      d1 = d;
    } else if (d < d2) {
      second = j;
      d2 = d;
    }
  }
  return { first, second, gap: d2 - d1 };
}

/**
 * The reference color of each color of an image. The rule removes first the lightness change that the image shares
 * with the reference: a transport plan pairs the colors, and one lightness curve fits the pairs. A gate keeps the
 * curve only when it clearly helps. Then each color takes the nearest reference color in OKLab, lowest index on ties.
 * After a tone change, of two almost equally near colors, the plan selects the one that gets more tiles of the color.
 * Both lists are sorted by count descending, then by value ascending. An empty reference maps each color to itself.
 * With no tone change the result is mapToPalette.
 */
export function matchColors(entries: readonly ColorCount[], reference: readonly ColorCount[]): Map<number, number> {
  const map = new Map<number, number>();
  if (reference.length === 0) {
    for (const e of entries) map.set(e.color, e.color);
    return map;
  }
  if (entries.length === 0) return map;
  const plan = planOf(entries, reference);
  const labs = new LabTable(entries.map((e) => e.color));
  const targets = new LabTable(reference.map((e) => e.color));
  const { planLight, light } = fitTone(plan, labs.l);
  if (!passesGate(plan, planLight)) {
    for (let i = 0; i < entries.length; i++) map.set(entries[i].color, reference[nearest(labs, i, targets, reference.length).index].color);
    return map;
  }
  labs.l.set(light);
  const { image, target, imageSize, targetSize } = plan;
  let flow: Float64Array | null = null;
  for (let i = 0; i < entries.length; i++) {
    const { first, second, gap } = nearestTwo(labs, i, targets, reference.length);
    let chosen = first;
    if (second >= 0 && gap < PARAMS.palette.reference.close && image.of[i] < imageSize) {
      flow ??= transport(plan, planLight);
      const row = image.of[i] * targetSize;
      const toFirst = target.of[first] < targetSize ? flow[row + target.of[first]] : 0;
      const toSecond = target.of[second] < targetSize ? flow[row + target.of[second]] : 0;
      if (toSecond > toFirst) chosen = second;
    }
    map.set(entries[i].color, reference[chosen].color);
  }
  return map;
}

/** The sprite painted with the colors of the reference (see matchColors). Transparent tiles stay. */
export function matchToReference(sprite: Sprite, reference: readonly ColorCount[]): Sprite {
  return applyColorMap(sprite, matchColors(listPalette(sprite.pixels), reference));
}
