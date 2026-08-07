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
  /**
   * Inharmonic partial ratio shared by the FM modulator and the ring modulator.
   * Non-integer values (1.41, 3.13, 5.19) are what make the tone clangorous
   * rather than musical.
   */
  ratio: number;
  /** FM index — how hard the modulator bends the carrier (0..1). */
  fm: number;
  /** Ring modulation depth: 0 = dry, 1 = fully multiplied (0..1). */
  ring: number;
  /** Resonant noise band mixed under the tone (0..1). */
  noise: number;
  /** Bit-crush amount — digital staircase / aliasing (0..1). */
  crush: number;
  /** Comb feedback — short metallic delay resonance (0..1). */
  comb: number;
  /** Stutter gate depth; two incommensurate square LFOs chop the voice (0..1). */
  glitch: number;
  /** Random sample-and-hold drift on the cutoff (0..1). */
  drift: number;
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
  ratio: [0.25, 8],
  fm: [0, 1],
  ring: [0, 1],
  noise: [0, 1],
  crush: [0, 1],
  comb: [0, 1],
  glitch: [0, 1],
  drift: [0, 1],
} as const;

/**
 * Zones as textures rather than chords — nothing here is meant to sit on a
 * keyboard. Frequencies are deliberately off the tempered grid and the ratios
 * are irrational, so the partials never resolve into a triad.
 *
 * Hook: a bright metallic strike that stutters. FormWait: sparse, gated almost
 * to silence, mostly resonant air. Development: a low crushed machine pulse.
 * Climax: dense FM noise, the gate held open. CTA: a hollow comb tail drifting
 * out.
 */
export const DEFAULT_DRONE_BY_ZONE: ReelDroneByZone = {
  hook: {
    enabled: true,
    freq: 218.5,
    gain: 0.06,
    type: "sawtooth",
    detune: 18,
    cutoff: 1800,
    lfoRate: 6.5,
    lfoDepth: 0.4,
    subGain: 0.25,
    ratio: 3.13,
    fm: 0.35,
    ring: 0.45,
    noise: 0.2,
    crush: 0.4,
    comb: 0.3,
    glitch: 0.5,
    drift: 0.25,
  },
  formwait: {
    enabled: true,
    freq: 247.7,
    gain: 0.05,
    type: "triangle",
    detune: 33,
    cutoff: 1100,
    lfoRate: 0.7,
    lfoDepth: 0.6,
    subGain: 0.1,
    ratio: 1.41,
    fm: 0.2,
    ring: 0.6,
    noise: 0.35,
    crush: 0.25,
    comb: 0.55,
    glitch: 0.75,
    drift: 0.5,
  },
  development: {
    enabled: true,
    freq: 109.3,
    gain: 0.05,
    type: "sawtooth",
    detune: 12,
    cutoff: 800,
    lfoRate: 3.2,
    lfoDepth: 0.55,
    subGain: 0.5,
    ratio: 2.07,
    fm: 0.15,
    ring: 0.2,
    noise: 0.15,
    crush: 0.55,
    comb: 0.4,
    glitch: 0.35,
    drift: 0.3,
  },
  climax: {
    enabled: true,
    freq: 163.8,
    gain: 0.085,
    type: "sawtooth",
    detune: 26,
    cutoff: 3200,
    lfoRate: 8.5,
    lfoDepth: 0.5,
    subGain: 0.55,
    ratio: 5.19,
    fm: 0.6,
    ring: 0.5,
    noise: 0.45,
    crush: 0.7,
    comb: 0.25,
    glitch: 0.2,
    drift: 0.2,
  },
  cta: {
    enabled: true,
    freq: 81.7,
    gain: 0.055,
    type: "triangle",
    detune: 8,
    cutoff: 700,
    lfoRate: 0.5,
    lfoDepth: 0.25,
    subGain: 0.45,
    ratio: 1.49,
    fm: 0.1,
    ring: 0.15,
    noise: 0.1,
    crush: 0.2,
    comb: 0.65,
    glitch: 0.1,
    drift: 0.4,
  },
};

/**
 * Signal path:
 *   oscA/oscB (detuned) + sub + resonant noise
 *     → ring modulator → bit crusher → comb (delay + damped feedback)
 *     → lowpass swept by an LFO and a random drift source
 *     → two incommensurate square gates → out
 * `fmOsc` bends the carriers at an inharmonic ratio on the way in.
 */
interface DroneVoice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sub: OscillatorNode;
  subLevel: GainNode;
  fmOsc: OscillatorNode;
  fmDepth: GainNode;
  noiseBand: BiquadFilterNode;
  noiseLevel: GainNode;
  ringDry: GainNode;
  ringOsc: OscillatorNode;
  ringLevel: GainNode;
  crusher: WaveShaperNode;
  crushAmount: number;
  combDelay: DelayNode;
  combFeedback: GainNode;
  combLevel: GainNode;
  filter: BiquadFilterNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  driftLevel: GainNode;
  gateA: GainNode;
  gateAOsc: OscillatorNode;
  gateALevel: GainNode;
  gateB: GainNode;
  gateBOsc: OscillatorNode;
  gateBLevel: GainNode;
  out: GainNode;
}

/** Bumped whenever the node graph changes shape — see `bus()`. */
const CUE_BUS_VERSION = 2;

interface CueBus {
  version: number;
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
  // The bus survives HMR. A bus built by an older graph shape would be driven
  // through params its nodes do not have, so rebuild instead of reusing it.
  if (typeof window !== "undefined" && window.__visioReelCueBus) {
    const existing = window.__visioReelCueBus;
    if (existing.version === CUE_BUS_VERSION) return existing;
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
    version: CUE_BUS_VERSION,
    master,
    drone: null,
    droneZone: null,
    metroTimer: null,
    metroNext: 0,
  };
  if (typeof window !== "undefined") window.__visioReelCueBus = created;
  return created;
}

function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * A handful of random samples played back far below rate — the resampler's
 * interpolation turns them into a slow wander, which is the cheapest
 * sample-and-hold there is without an AudioWorklet.
 */
function driftSource(ctx: BaseAudioContext, steps: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(2, steps), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Quantisation staircase: 16 bits (transparent) down to ~2, where the aliasing
 * products are the point rather than an artefact.
 */
function crushCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const bits = 16 - amount * 14;
  const steps = Math.max(2, Math.pow(2, bits) / 2);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(-1, Math.min(1, Math.round(x * steps) / steps));
  }
  return curve;
}

/**
 * Zone boundary / metronome transient. Not a beep: a pitch that falls off a
 * cliff inside 40 ms plus a resonant noise burst, so it reads as a click or a
 * data glitch rather than a tone.
 */
export function scheduleTick(
  when = 0,
  opts: {
    freq?: number;
    dur?: number;
    gain?: number;
    type?: OscWave;
    /** Share of the hit that is filtered noise rather than pitch (0..1). */
    noise?: number;
    /** Where the pitch lands, as a fraction of `freq`. */
    sweep?: number;
  } = {},
): void {
  const ctx = audioContext();
  const b = bus();
  const t0 = Math.max(ctx.currentTime, when || ctx.currentTime);
  const peak = opts.gain ?? 0.12;
  const dur = opts.dur ?? 0.045;
  const freq = opts.freq ?? 880;
  const noiseAmount = Math.max(0, Math.min(1, opts.noise ?? 0.55));

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  env.connect(b.master);

  const osc = ctx.createOscillator();
  const oscLevel = ctx.createGain();
  osc.type = opts.type ?? "square";
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(30, freq * (opts.sweep ?? 0.18)),
    t0 + dur,
  );
  oscLevel.gain.value = 1 - noiseAmount * 0.75;
  osc.connect(oscLevel);
  oscLevel.connect(env);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);

  let noiseSrc: AudioBufferSourceNode | null = null;
  let band: BiquadFilterNode | null = null;
  let noiseLevel: GainNode | null = null;
  if (noiseAmount > 0) {
    noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = whiteNoise(ctx, Math.max(0.05, dur + 0.05));
    band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(freq * 2.4, t0);
    band.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.6), t0 + dur);
    band.Q.value = 14;
    noiseLevel = ctx.createGain();
    noiseLevel.gain.value = noiseAmount;
    noiseSrc.connect(band);
    band.connect(noiseLevel);
    noiseLevel.connect(env);
    noiseSrc.start(t0);
    noiseSrc.stop(t0 + dur + 0.02);
  }

  osc.onended = () => {
    for (const node of [osc, oscLevel, env, noiseSrc, band, noiseLevel]) {
      try {
        node?.disconnect();
      } catch {
        /* already gone */
      }
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
      // Drier and shorter than the zone tick — a dead impulse, no ring to it.
      scheduleTick(b.metroNext, {
        freq: 1400,
        dur: 0.022,
        gain: 0.09,
        type: "square",
        noise: 0.35,
        sweep: 0.5,
      });
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

  // --- tail: gates → out ---------------------------------------------------
  const out = ctx.createGain();
  out.gain.value = 0.0001;
  out.connect(b.master);

  const gateB = ctx.createGain();
  gateB.gain.value = 1;
  gateB.connect(out);
  const gateA = ctx.createGain();
  gateA.gain.value = 1;
  gateA.connect(gateB);

  // Square LFOs swing ±1, so `gate.gain = 1 - d` plus a ±d square lands between
  // 1 - 2d and 1: at d = 0.5 the voice chops fully on/off. Two of them at an
  // irrational ratio never line up, which is what keeps the stutter from
  // sounding like a tremolo.
  const gateAOsc = ctx.createOscillator();
  const gateALevel = ctx.createGain();
  gateAOsc.type = "square";
  gateAOsc.frequency.value = 3;
  gateALevel.gain.value = 0;
  gateAOsc.connect(gateALevel);
  gateALevel.connect(gateA.gain);

  const gateBOsc = ctx.createOscillator();
  const gateBLevel = ctx.createGain();
  gateBOsc.type = "square";
  gateBOsc.frequency.value = 4.85;
  gateBLevel.gain.value = 0;
  gateBOsc.connect(gateBLevel);
  gateBLevel.connect(gateB.gain);

  // --- filter + its modulators ---------------------------------------------
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 800;
  filter.Q.value = 6;
  filter.connect(gateA);

  const lfo = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 1;
  lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth);
  lfoDepth.connect(filter.frequency);

  const driftSrc = ctx.createBufferSource();
  driftSrc.buffer = driftSource(ctx, 96);
  driftSrc.loop = true;
  driftSrc.playbackRate.value = 0.0012;
  const driftLevel = ctx.createGain();
  driftLevel.gain.value = 0;
  driftSrc.connect(driftLevel);
  driftLevel.connect(filter.frequency);

  // --- comb: parallel short delay with damped feedback ---------------------
  const combDelay = ctx.createDelay(0.2);
  combDelay.delayTime.value = 0.013;
  const combFeedback = ctx.createGain();
  combFeedback.gain.value = 0;
  const combDamp = ctx.createBiquadFilter();
  combDamp.type = "lowpass";
  combDamp.frequency.value = 3200;
  const combLevel = ctx.createGain();
  combLevel.gain.value = 0;
  combDelay.connect(combDamp);
  combDamp.connect(combFeedback);
  combFeedback.connect(combDelay);
  combDelay.connect(combLevel);
  combLevel.connect(filter);

  // --- crusher feeds both the dry path and the comb ------------------------
  const crusher = ctx.createWaveShaper();
  crusher.curve = crushCurve(0);
  crusher.oversample = "none";
  crusher.connect(filter);
  crusher.connect(combDelay);

  // --- ring modulator: dry gain plus an audio-rate gain from ringOsc -------
  const ringDry = ctx.createGain();
  ringDry.gain.value = 1;
  ringDry.connect(crusher);
  const ringOsc = ctx.createOscillator();
  const ringLevel = ctx.createGain();
  ringOsc.type = "sine";
  ringOsc.frequency.value = 300;
  ringLevel.gain.value = 0;
  ringOsc.connect(ringLevel);
  ringLevel.connect(ringDry.gain);

  // --- sources --------------------------------------------------------------
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
  // The stacked pair runs hot into the chain; halve it so gain stays the level.
  const pairLevel = ctx.createGain();
  pairLevel.gain.value = 0.5;
  oscA.connect(pairLevel);
  oscB.connect(pairLevel);
  pairLevel.connect(ringDry);
  sub.connect(subLevel);
  subLevel.connect(ringDry);

  const fmOsc = ctx.createOscillator();
  const fmDepth = ctx.createGain();
  fmOsc.type = "sine";
  fmOsc.frequency.value = 300;
  fmDepth.gain.value = 0;
  fmOsc.connect(fmDepth);
  fmDepth.connect(oscA.frequency);
  fmDepth.connect(oscB.frequency);

  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = whiteNoise(ctx, 2);
  noiseSrc.loop = true;
  const noiseBand = ctx.createBiquadFilter();
  noiseBand.type = "bandpass";
  noiseBand.frequency.value = 900;
  // Wide on purpose: a narrow band is a whistle, and it leaves the comb behind
  // it with nothing broadband to ring on.
  noiseBand.Q.value = 1.4;
  const noiseLevel = ctx.createGain();
  noiseLevel.gain.value = 0;
  noiseSrc.connect(noiseBand);
  noiseBand.connect(noiseLevel);
  noiseLevel.connect(ringDry);

  for (const node of [oscA, oscB, sub, fmOsc, ringOsc, lfo, gateAOsc, gateBOsc]) {
    node.start();
  }
  noiseSrc.start();
  driftSrc.start();

  const voice: DroneVoice = {
    oscA,
    oscB,
    sub,
    subLevel,
    fmOsc,
    fmDepth,
    noiseBand,
    noiseLevel,
    ringDry,
    ringOsc,
    ringLevel,
    crusher,
    crushAmount: 0,
    combDelay,
    combFeedback,
    combLevel,
    filter,
    lfo,
    lfoDepth,
    driftLevel,
    gateA,
    gateAOsc,
    gateALevel,
    gateB,
    gateBOsc,
    gateBLevel,
    out,
  };
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
  const ratio = clampTo(DRONE_RANGES.ratio, p.ratio, 2);
  const fm = clampTo(DRONE_RANGES.fm, p.fm, 0);
  const ring = clampTo(DRONE_RANGES.ring, p.ring, 0);
  const noise = clampTo(DRONE_RANGES.noise, p.noise, 0);
  const crush = clampTo(DRONE_RANGES.crush, p.crush, 0);
  const comb = clampTo(DRONE_RANGES.comb, p.comb, 0);
  const glitch = clampTo(DRONE_RANGES.glitch, p.glitch, 0);
  const drift = clampTo(DRONE_RANGES.drift, p.drift, 0);

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
  voice.driftLevel.gain.cancelScheduledValues(now);
  voice.driftLevel.gain.setTargetAtTime(cutoff * drift * 0.6, now, 0.12);

  // FM index scales with the carrier: the same `fm` bends a 80 Hz drone and a
  // 250 Hz one by the same musical amount rather than the same Hz.
  voice.fmOsc.frequency.cancelScheduledValues(now);
  voice.fmOsc.frequency.setTargetAtTime(freq * ratio, now, 0.08);
  voice.fmDepth.gain.cancelScheduledValues(now);
  voice.fmDepth.gain.setTargetAtTime(freq * fm * 3, now, 0.08);

  voice.ringOsc.frequency.cancelScheduledValues(now);
  voice.ringOsc.frequency.setTargetAtTime(freq * ratio * 0.5, now, 0.08);
  voice.ringDry.gain.cancelScheduledValues(now);
  voice.ringDry.gain.setTargetAtTime(1 - ring, now, 0.08);
  voice.ringLevel.gain.cancelScheduledValues(now);
  voice.ringLevel.gain.setTargetAtTime(ring, now, 0.08);

  voice.noiseBand.frequency.cancelScheduledValues(now);
  voice.noiseBand.frequency.setTargetAtTime(Math.min(8000, cutoff * 1.5), now, 0.1);
  voice.noiseLevel.gain.cancelScheduledValues(now);
  voice.noiseLevel.gain.setTargetAtTime(noise * 0.5, now, 0.1);

  // Rebuilding the curve is cheap and only happens on a zone change; skip it
  // when the amount has not moved so the staircase does not jump mid-note.
  if (Math.abs(voice.crushAmount - crush) > 1e-3) {
    voice.crusher.curve = crushCurve(crush);
    voice.crushAmount = crush;
  }

  // The comb resonates at the inharmonic partial, so its pitch falls between the
  // tone's harmonics — that mistuning is what rings metallic.
  //
  // A DelayNode inside a feedback cycle gets one render quantum added to the
  // loop, so the ring lands at 1/(delayTime + quantum). Uncompensated, a 2.9 ms
  // delay asking for 344 Hz measured 179. Subtract the quantum, and fold the
  // target down by octaves until the compensated delay is still positive —
  // above ~1/quantum the loop simply cannot ring that high.
  const quantum = 128 / ctx.sampleRate;
  let combHz = freq * ratio;
  while (combHz > 1 / (quantum * 2)) combHz /= 2;
  voice.combDelay.delayTime.cancelScheduledValues(now);
  voice.combDelay.delayTime.setTargetAtTime(
    Math.max(0.0005, Math.min(0.06, 1 / combHz - quantum)),
    now,
    0.1,
  );
  voice.combFeedback.gain.cancelScheduledValues(now);
  voice.combFeedback.gain.setTargetAtTime(comb * 0.82, now, 0.1);
  voice.combLevel.gain.cancelScheduledValues(now);
  voice.combLevel.gain.setTargetAtTime(comb * 0.7, now, 0.1);

  // Gate rates ride the LFO so the stutter belongs to the same motion; the
  // golden ratio between them keeps the two from ever repeating together.
  const gateRate = 2 + glitch * 16 + lfoRate * 0.5;
  const gateDepth = glitch * 0.5;
  voice.gateAOsc.frequency.cancelScheduledValues(now);
  voice.gateAOsc.frequency.setTargetAtTime(gateRate, now, 0.05);
  voice.gateBOsc.frequency.cancelScheduledValues(now);
  voice.gateBOsc.frequency.setTargetAtTime(gateRate * 1.6180339887, now, 0.05);
  for (const [level, gate] of [
    [voice.gateALevel, voice.gateA],
    [voice.gateBLevel, voice.gateB],
  ] as const) {
    level.gain.cancelScheduledValues(now);
    level.gain.setTargetAtTime(gateDepth, now, 0.05);
    gate.gain.cancelScheduledValues(now);
    gate.gain.setTargetAtTime(1 - gateDepth, now, 0.05);
  }

  // Two gates in series halve the average level; lift the make-up with depth.
  voice.out.gain.cancelScheduledValues(now);
  voice.out.gain.setTargetAtTime(Math.max(0.0001, gain * (1 + glitch * 0.8)), now, 0.06);
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
      ratio: num("ratio", r.ratio, base.ratio),
      fm: num("fm", r.fm, base.fm),
      ring: num("ring", r.ring, base.ring),
      noise: num("noise", r.noise, base.noise),
      crush: num("crush", r.crush, base.crush),
      comb: num("comb", r.comb, base.comb),
      glitch: num("glitch", r.glitch, base.glitch),
      drift: num("drift", r.drift, base.drift),
    };
  }
  return out;
}
