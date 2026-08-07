/**
 * Live cue sounds for reel timeline zones — ticks, Development metronome, drones.
 * Uses the shared AudioContext only (no stores / registry).
 */

import { audioContext } from "./audioEngine";
import { REEL_ZONE_META, type ReelZoneId } from "./reelMarkers";

export type OscWave = OscillatorType;

export interface ReelDroneParams {
  enabled: boolean;
  freq: number;
  gain: number;
  type: OscWave;
  /** Cents between the two stacked oscillators — beating / width. */
  detune: number;
  /** Lowpass cutoff (Hz) — how bright the voice sits. */
  cutoff: number;
  /** Filter LFO speed (Hz); 0 keeps the tone static. */
  lfoRate: number;
  /** How far the LFO sweeps the cutoff (0..1). */
  lfoDepth: number;
  /** Sub oscillator an octave down, relative to the voice level (0..1). */
  subGain: number;
}

export type ReelDroneByZone = Record<ReelZoneId, ReelDroneParams>;

export const DEFAULT_DEVELOPMENT_BPM = 120;

export const DRONE_RANGES = {
  freq: [20, 2000],
  gain: [0, 0.35],
  detune: [0, 60],
  cutoff: [60, 8000],
  lfoRate: [0, 12],
  lfoDepth: [0, 1],
  subGain: [0, 1],
} as const;

/**
 * One character per zone rather than one sine for all of them: bright and
 * moving for Hook, a tense narrow beat for FormWait, a slow pulse under
 * Development, a wide bright stack at the Climax, warm and settled for CTA.
 */
export const DEFAULT_DRONE_BY_ZONE: ReelDroneByZone = {
  hook: {
    enabled: true,
    freq: 220,
    gain: 0.06,
    type: "sawtooth",
    detune: 14,
    cutoff: 1400,
    lfoRate: 5.5,
    lfoDepth: 0.35,
    subGain: 0.3,
  },
  formwait: {
    enabled: true,
    freq: 246.94,
    gain: 0.05,
    type: "triangle",
    detune: 28,
    cutoff: 900,
    lfoRate: 0.9,
    lfoDepth: 0.55,
    subGain: 0.15,
  },
  development: {
    enabled: true,
    freq: 110,
    gain: 0.05,
    type: "sawtooth",
    detune: 10,
    cutoff: 700,
    lfoRate: 3.2,
    lfoDepth: 0.5,
    subGain: 0.45,
  },
  climax: {
    enabled: true,
    freq: 165,
    gain: 0.085,
    type: "sawtooth",
    detune: 22,
    cutoff: 2200,
    lfoRate: 7.5,
    lfoDepth: 0.45,
    subGain: 0.6,
  },
  cta: {
    enabled: true,
    freq: 82.41,
    gain: 0.055,
    type: "triangle",
    detune: 6,
    cutoff: 600,
    lfoRate: 0.6,
    lfoDepth: 0.2,
    subGain: 0.5,
  },
};

/** Two detuned oscillators + sub through a lowpass the LFO sweeps. */
interface DroneVoice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sub: OscillatorNode;
  subLevel: GainNode;
  filter: BiquadFilterNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  out: GainNode;
}

interface CueBus {
  master: GainNode;
  drone: DroneVoice | null;
  droneZone: ReelZoneId | null;
  metroTimer: number | null;
  metroNext: number;
}

declare global {
  interface Window {
    __visioReelCueBus?: CueBus;
  }
}

function bus(): CueBus {
  // `drone` guard: an HMR-surviving bus from the single-oscillator build has the
  // old shape and would be driven with fields it does not own.
  if (typeof window !== "undefined" && window.__visioReelCueBus) {
    const existing: CueBus = window.__visioReelCueBus;
    if ("drone" in (existing as object)) return existing;
    try {
      existing.master.disconnect();
    } catch {
      /* already gone */
    }
  }
  const ctx = audioContext();
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  const created: CueBus = {
    master,
    drone: null,
    droneZone: null,
    metroTimer: null,
    metroNext: 0,
  };
  if (typeof window !== "undefined") window.__visioReelCueBus = created;
  return created;
}

/** Short click for zone boundaries / metronome. */
export function scheduleTick(
  when = 0,
  opts: { freq?: number; dur?: number; gain?: number; type?: OscWave } = {},
): void {
  const ctx = audioContext();
  const b = bus();
  const t0 = Math.max(ctx.currentTime, when || ctx.currentTime);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type ?? "square";
  osc.frequency.setValueAtTime(opts.freq ?? 880, t0);
  const peak = opts.gain ?? 0.12;
  const dur = opts.dur ?? 0.045;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(b.master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  osc.onended = () => {
    try {
      osc.disconnect();
      g.disconnect();
    } catch {
      /* already gone */
    }
  };
}

export function stopMetronome(): void {
  const b = bus();
  if (b.metroTimer != null) {
    window.clearInterval(b.metroTimer);
    b.metroTimer = null;
  }
}

/**
 * Lookahead metronome while Development is active. Call start when entering
 * the zone / enabling; stopMetronome when leaving.
 */
export function startMetronome(bpm: number): void {
  stopMetronome();
  const rate = Math.max(40, Math.min(240, bpm));
  const interval = 60 / rate;
  const ctx = audioContext();
  const b = bus();
  b.metroNext = ctx.currentTime + 0.05;

  const scheduleAhead = () => {
    const now = audioContext().currentTime;
    const horizon = now + 0.15;
    while (b.metroNext < horizon) {
      scheduleTick(b.metroNext, { freq: 1200, dur: 0.03, gain: 0.09, type: "square" });
      b.metroNext += interval;
    }
  };

  scheduleAhead();
  b.metroTimer = window.setInterval(scheduleAhead, 50);
}

function ensureDrone(): DroneVoice {
  const ctx = audioContext();
  const b = bus();
  if (b.drone) return b.drone;

  const out = ctx.createGain();
  out.gain.value = 0.0001;
  out.connect(b.master);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 800;
  filter.Q.value = 4;
  filter.connect(out);

  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();
  const sub = ctx.createOscillator();
  const subLevel = ctx.createGain();
  oscA.type = "sawtooth";
  oscB.type = "sawtooth";
  sub.type = "sine";
  oscA.frequency.value = 110;
  oscB.frequency.value = 110;
  sub.frequency.value = 55;
  subLevel.gain.value = 0.4;
  // The stacked pair runs hot into the filter; halve it so gain stays the level.
  const pairLevel = ctx.createGain();
  pairLevel.gain.value = 0.5;
  oscA.connect(pairLevel);
  oscB.connect(pairLevel);
  pairLevel.connect(filter);
  sub.connect(subLevel);
  subLevel.connect(filter);

  const lfo = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 1;
  lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth);
  lfoDepth.connect(filter.frequency);

  oscA.start();
  oscB.start();
  sub.start();
  lfo.start();

  const voice: DroneVoice = { oscA, oscB, sub, subLevel, filter, lfo, lfoDepth, out };
  b.drone = voice;
  return voice;
}

function clampTo(range: readonly [number, number], value: number, fallback: number): number {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(range[0], Math.min(range[1], n));
}

/** Ramp drone to a zone's params, or silence if disabled / cues off. */
export function setDroneZone(
  zone: ReelZoneId | null,
  params: ReelDroneByZone,
  enabled: boolean,
): void {
  const b = bus();
  const ctx = audioContext();
  const voice = ensureDrone();
  const now = ctx.currentTime;

  const silence = () => {
    voice.out.gain.cancelScheduledValues(now);
    voice.out.gain.setTargetAtTime(0.0001, now, 0.04);
  };

  if (!enabled || zone == null) {
    silence();
    b.droneZone = null;
    return;
  }
  const p = params[zone] ?? DEFAULT_DRONE_BY_ZONE[zone];
  if (!p.enabled) {
    silence();
    b.droneZone = zone;
    return;
  }

  const freq = clampTo(DRONE_RANGES.freq, p.freq, 110);
  const detune = clampTo(DRONE_RANGES.detune, p.detune, 0);
  const cutoff = clampTo(DRONE_RANGES.cutoff, p.cutoff, 800);
  const lfoRate = clampTo(DRONE_RANGES.lfoRate, p.lfoRate, 0);
  const lfoDepth = clampTo(DRONE_RANGES.lfoDepth, p.lfoDepth, 0);
  const subGain = clampTo(DRONE_RANGES.subGain, p.subGain, 0.4);
  const gain = clampTo(DRONE_RANGES.gain, p.gain, 0.05);

  voice.oscA.type = p.type;
  voice.oscB.type = p.type;
  for (const [node, cents] of [
    [voice.oscA, detune / 2],
    [voice.oscB, -detune / 2],
  ] as const) {
    node.frequency.cancelScheduledValues(now);
    node.frequency.setTargetAtTime(freq, now, 0.08);
    node.detune.cancelScheduledValues(now);
    node.detune.setTargetAtTime(cents, now, 0.08);
  }
  voice.sub.frequency.cancelScheduledValues(now);
  voice.sub.frequency.setTargetAtTime(freq / 2, now, 0.08);
  voice.subLevel.gain.cancelScheduledValues(now);
  voice.subLevel.gain.setTargetAtTime(subGain, now, 0.08);

  voice.filter.frequency.cancelScheduledValues(now);
  voice.filter.frequency.setTargetAtTime(cutoff, now, 0.08);
  voice.lfo.frequency.cancelScheduledValues(now);
  voice.lfo.frequency.setTargetAtTime(Math.max(0.01, lfoRate), now, 0.08);
  voice.lfoDepth.gain.cancelScheduledValues(now);
  // Sweep is relative to the cutoff and capped short of 0 Hz, so a deep LFO
  // opens and closes the filter instead of choking it.
  voice.lfoDepth.gain.setTargetAtTime(
    lfoRate > 0 ? cutoff * lfoDepth * 0.9 : 0,
    now,
    0.08,
  );

  voice.out.gain.cancelScheduledValues(now);
  voice.out.gain.setTargetAtTime(Math.max(0.0001, gain), now, 0.06);
  b.droneZone = zone;
}

export function silenceAllCues(): void {
  stopMetronome();
  setDroneZone(null, DEFAULT_DRONE_BY_ZONE, false);
}

export function parseDroneByZone(raw: unknown): ReelDroneByZone {
  const out = {} as ReelDroneByZone;
  for (const meta of REEL_ZONE_META) out[meta.id] = { ...DEFAULT_DRONE_BY_ZONE[meta.id] };
  if (!raw || typeof raw !== "object") return out;
  for (const meta of REEL_ZONE_META) {
    const row = (raw as Record<string, unknown>)[meta.id];
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<ReelDroneParams>;
    const base = out[meta.id];
    const num = (
      key: keyof typeof DRONE_RANGES,
      value: number | undefined,
      fallback: number,
    ): number =>
      typeof value === "number" && Number.isFinite(value)
        ? clampTo(DRONE_RANGES[key], value, fallback)
        : fallback;
    out[meta.id] = {
      enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
      freq: num("freq", r.freq, base.freq),
      gain: num("gain", r.gain, base.gain),
      type:
        r.type === "sine" || r.type === "triangle" || r.type === "sawtooth" || r.type === "square"
          ? r.type
          : base.type,
      detune: num("detune", r.detune, base.detune),
      cutoff: num("cutoff", r.cutoff, base.cutoff),
      lfoRate: num("lfoRate", r.lfoRate, base.lfoRate),
      lfoDepth: num("lfoDepth", r.lfoDepth, base.lfoDepth),
      subGain: num("subGain", r.subGain, base.subGain),
    };
  }
  return out;
}
