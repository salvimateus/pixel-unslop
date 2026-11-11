import { TUNING } from './tuning.ts';
import { readStored, writeStored } from './storage.ts';

export type SoundName = 'drop' | 'tick' | 'lock' | 'sweep' | 'paint' | 'erase' | 'fill' | 'undo' | 'saved' | 'error';

const MUTE_KEY = 'mute';

interface ToneSpec {
  freq: number;
  to?: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  vol?: number;
}

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = readStored(MUTE_KEY) === '1';
const lastPlayed = new Map<SoundName, number>();

function unlock(): void {
  if (context) {
    if (context.state === 'suspended') void context.resume();
    return;
  }
  try {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = muted ? 0 : TUNING.sfx.master;
    master.connect(context.destination);
  } catch {
    context = null;
    master = null;
  }
}

/** The browser allows audio only after a user gesture, so the context starts on the first one. */
export function installAudioUnlock(): void {
  const options = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', unlock, options);
  window.addEventListener('keydown', unlock, options);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  writeStored(MUTE_KEY, value ? '1' : '0');
  if (master && context) master.gain.setTargetAtTime(value ? 0 : TUNING.sfx.master, context.currentTime, 0.02);
}

function tone(ctx: AudioContext, out: AudioNode, spec: ToneSpec): void {
  const start = ctx.currentTime + (spec.at ?? 0);
  const end = start + spec.dur;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = spec.type ?? 'square';
  osc.frequency.setValueAtTime(spec.freq, start);
  if (spec.to) osc.frequency.exponentialRampToValueAtTime(spec.to, end);
  const peak = spec.vol ?? 0.3;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(end + 0.02);
}

function noise(ctx: AudioContext, out: AudioNode, at: number, dur: number, vol: number, cutoff: number): void {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
  }
  const start = ctx.currentTime + at;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  source.connect(filter).connect(gain).connect(out);
  source.start(start);
  source.stop(start + dur + 0.02);
}

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

const recipes: Record<SoundName, (ctx: AudioContext, out: AudioNode) => void> = {
  drop(ctx, out) {
    noise(ctx, out, 0, 0.06, 0.25, 2400);
    tone(ctx, out, { freq: 220, to: 880, dur: 0.14, vol: 0.22 });
    tone(ctx, out, { freq: 880, to: 1320, at: 0.1, dur: 0.1, type: 'triangle', vol: 0.2 });
  },
  tick(ctx, out) {
    tone(ctx, out, { freq: 1400, dur: 0.025, type: 'triangle', vol: 0.12 });
  },
  lock(ctx, out) {
    noise(ctx, out, 0, 0.05, 0.3, 1800);
    tone(ctx, out, { freq: C5, dur: 0.09, vol: 0.18 });
    tone(ctx, out, { freq: G5, at: 0.07, dur: 0.18, vol: 0.18 });
    tone(ctx, out, { freq: C6, at: 0.07, dur: 0.22, type: 'triangle', vol: 0.14 });
  },
  sweep(ctx, out) {
    const notes = [C5, E5, G5, C6, E5 * 2];
    notes.forEach((freq, i) => tone(ctx, out, { freq, at: i * 0.075, dur: 0.12, vol: 0.16 }));
    tone(ctx, out, { freq: C6, at: notes.length * 0.075, dur: 0.35, type: 'triangle', vol: 0.16 });
  },
  paint(ctx, out) {
    const freq = 640 + Math.random() * 220;
    tone(ctx, out, { freq, to: freq * 1.25, dur: 0.045, type: 'triangle', vol: 0.16 });
  },
  erase(ctx, out) {
    noise(ctx, out, 0, 0.08, 0.18, 1200);
    tone(ctx, out, { freq: 420, to: 150, dur: 0.08, vol: 0.1 });
  },
  fill(ctx, out) {
    tone(ctx, out, { freq: 260, to: 1040, dur: 0.2, type: 'triangle', vol: 0.22 });
    tone(ctx, out, { freq: 520, to: 1560, at: 0.05, dur: 0.18, vol: 0.08 });
  },
  undo(ctx, out) {
    tone(ctx, out, { freq: 720, to: 480, dur: 0.07, type: 'triangle', vol: 0.16 });
  },
  saved(ctx, out) {
    const notes = [C5, E5, G5, C6];
    notes.forEach((freq, i) => tone(ctx, out, { freq, at: i * 0.09, dur: 0.12, vol: 0.16 }));
    [C6, E5 * 2, G5 * 2].forEach((freq) => tone(ctx, out, { freq, at: 0.38, dur: 0.5, type: 'triangle', vol: 0.12 }));
  },
  error(ctx, out) {
    tone(ctx, out, { freq: 160, dur: 0.12, vol: 0.16 });
    tone(ctx, out, { freq: 120, at: 0.13, dur: 0.18, vol: 0.16 });
  },
};

const minIntervalMs: Partial<Record<SoundName, number>> = {
  paint: TUNING.sfx.paintMinIntervalMs,
  tick: TUNING.sfx.tickMinIntervalMs,
};

export function play(name: SoundName): void {
  if (muted || !context || !master || context.state !== 'running') return;
  const now = performance.now();
  const interval = minIntervalMs[name];
  if (interval !== undefined && now - (lastPlayed.get(name) ?? -Infinity) < interval) return;
  lastPlayed.set(name, now);
  recipes[name](context, master);
}
