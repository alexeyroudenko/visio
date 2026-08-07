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
}

export type ReelDroneByZone = Record<ReelZoneId, ReelDroneParams>;

export const DEFAULT_DEVELOPMENT_BPM = 120;

export const DEFAULT_DRONE_BY_ZONE: ReelDroneByZone = {
  hook: { enabled: true, freq: 220, gain: 0.06, type: "sine" },
  development: { enabled: true, freq: 110, gain: 0.05, type: "sine" },
  climax: { enabled: true, freq: 165, gain: 0.08, type: "triangle" },
  cta: { enabled: true, freq: 82.41, gain: 0.05, type: "sine" },
};

interface CueBus {
  master: GainNode;
  droneOsc: OscillatorNode | null;
  droneGain: GainNode | null;
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
  if (typeof window !== "undefined" && window.__visioReelCueBus) {
    return window.__visioReelCueBus;
  }
  const ctx = audioContext();
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  const created: CueBus = {
    master,
    droneOsc: null,
    droneGain: null,
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

function ensureDrone(): { osc: OscillatorNode; gain: GainNode } {
  const ctx = audioContext();
  const b = bus();
  if (b.droneOsc && b.droneGain) return { osc: b.droneOsc, gain: b.droneGain };
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 110;
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(b.master);
  osc.start();
  b.droneOsc = osc;
  b.droneGain = gain;
  return { osc, gain };
}

/** Ramp drone to a zone's params, or silence if disabled / cues off. */
export function setDroneZone(
  zone: ReelZoneId | null,
  params: ReelDroneByZone,
  enabled: boolean,
): void {
  const b = bus();
  const ctx = audioContext();
  const { osc, gain } = ensureDrone();
  const now = ctx.currentTime;
  if (!enabled || zone == null) {
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0.0001, now, 0.04);
    b.droneZone = null;
    return;
  }
  const p = params[zone] ?? DEFAULT_DRONE_BY_ZONE[zone];
  if (!p.enabled) {
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0.0001, now, 0.04);
    b.droneZone = zone;
    return;
  }
  osc.type = p.type;
  osc.frequency.cancelScheduledValues(now);
  osc.frequency.setTargetAtTime(Math.max(20, Math.min(2000, p.freq)), now, 0.05);
  gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(Math.max(0.0001, Math.min(0.35, p.gain)), now, 0.06);
  b.droneZone = zone;
}

export function silenceAllCues(): void {
  stopMetronome();
  setDroneZone(null, DEFAULT_DRONE_BY_ZONE, false);
}

export function parseDroneByZone(raw: unknown): ReelDroneByZone {
  const out: ReelDroneByZone = {
    hook: { ...DEFAULT_DRONE_BY_ZONE.hook },
    development: { ...DEFAULT_DRONE_BY_ZONE.development },
    climax: { ...DEFAULT_DRONE_BY_ZONE.climax },
    cta: { ...DEFAULT_DRONE_BY_ZONE.cta },
  };
  if (!raw || typeof raw !== "object") return out;
  for (const meta of REEL_ZONE_META) {
    const row = (raw as Record<string, unknown>)[meta.id];
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<ReelDroneParams>;
    const base = out[meta.id];
    out[meta.id] = {
      enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
      freq:
        typeof r.freq === "number" && Number.isFinite(r.freq)
          ? Math.max(20, Math.min(2000, r.freq))
          : base.freq,
      gain:
        typeof r.gain === "number" && Number.isFinite(r.gain)
          ? Math.max(0, Math.min(0.35, r.gain))
          : base.gain,
      type:
        r.type === "sine" || r.type === "triangle" || r.type === "sawtooth" || r.type === "square"
          ? r.type
          : base.type,
    };
  }
  return out;
}
