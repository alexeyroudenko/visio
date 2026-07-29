import type { AudioValue, BoxesValue } from "../../engine/types";
import { ensureAudioBuffer } from "../../lib/audioBuffers";
import { audioContext } from "../../lib/audioEngine";
import { publishGrains, type GrainMark } from "../../store/grainStore";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";

/**
 * One rectangle → one looping grain.
 *
 * A rectangle appearing cuts a slice out of the source audio at that instant
 * and loops it for as long as the rectangle is on screen; the rectangle's size
 * drives a lowpass — the smaller it is, the higher the cutoff. Identity comes
 * from `box.id`, which Features Grid keeps stable across frames.
 */

interface Voice {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
  level: number;
  /** Where in the source the loop reads from — for the timeline overlay. */
  offsetSec: number;
  /** Semitones off the source pitch; the overlay colours by it. */
  pitch: number;
  /** Context time the release ramp ends, or null while the rect is alive. */
  endAt: number | null;
}

interface GranularState {
  voices: Map<number, Voice>;
  master: GainNode | null;
  limiter: DynamicsCompressorNode | null;
  /**
   * Sits inline on the master purely so the debug panel can show that sound is
   * actually leaving the node — "8 grains" is not the same as "8 grains audible".
   */
  meter: AnalyserNode | null;
  meterBuffer: Float32Array<ArrayBuffer> | null;
  /** The context the chain above belongs to — rebuilt if HMR swaps it out. */
  ctx: AudioContext | null;
  /** Set once we have complained about a missing/undecodable track. */
  reported: string | null;
}

/** Peak of the last analyser window, as a 0..1 level plus a coarse dBFS. */
function readLevel(state: GranularState): { peak: number; db: number } {
  const meter = state.meter;
  if (!meter) return { peak: 0, db: -Infinity };
  if (!state.meterBuffer || state.meterBuffer.length !== meter.fftSize) {
    state.meterBuffer = new Float32Array(meter.fftSize);
  }
  const buffer = state.meterBuffer;
  meter.getFloatTimeDomainData(buffer);
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const value = Math.abs(buffer[i]!);
    if (value > peak) peak = value;
  }
  return { peak, db: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

/** Perceptual size of a normalized rectangle: 1 = the whole frame. */
export function rectScale(w: number, h: number): number {
  return Math.sqrt(Math.max(0, w) * Math.max(0, h));
}

export interface CutoffMapping {
  /** Scale at or below which the cutoff sits at `cutoffHigh`. */
  sizeMin: number;
  /** Scale at or above which it sits at `cutoffLow`. */
  sizeMax: number;
  cutoffLow: number;
  cutoffHigh: number;
}

/**
 * Size → lowpass cutoff, log-interpolated so equal size steps are equal
 * octave steps. Monotonically decreasing: small rectangle, high cutoff.
 */
export function cutoffForScale(scale: number, map: CutoffMapping): number {
  const low = Math.max(20, Math.min(map.cutoffLow, map.cutoffHigh));
  const high = Math.max(low + 1, Math.max(map.cutoffLow, map.cutoffHigh));
  const span = Math.max(1e-4, map.sizeMax - map.sizeMin);
  const t = Math.min(1, Math.max(0, (scale - map.sizeMin) / span));
  return high * Math.pow(low / high, t);
}

/**
 * Cut a loopable grain out of `source`.
 *
 * The samples that follow the slice are folded back over its head with an
 * equal-power crossfade, so looping the result is continuous in the original
 * material instead of stepping at the seam.
 */
export function sliceLoop(
  ctx: BaseAudioContext,
  source: AudioBuffer,
  offsetSec: number,
  lengthSec: number,
  fadeSec: number,
): AudioBuffer | null {
  const rate = source.sampleRate;
  const total = source.length;
  if (total < 32) return null;

  let length = Math.max(16, Math.round(lengthSec * rate));
  let fade = Math.max(1, Math.round(fadeSec * rate));
  if (length + fade > total) {
    // Short file: shrink the grain rather than refusing to play it.
    length = Math.max(16, Math.floor(total / 2));
    fade = Math.max(1, Math.min(fade, Math.floor(length / 2), total - length));
  }
  fade = Math.min(fade, Math.floor(length / 2));

  const start = Math.max(0, Math.min(Math.round(offsetSec * rate), total - length - fade));
  const channels = Math.min(2, source.numberOfChannels);
  const out = ctx.createBuffer(channels, length, rate);

  for (let ch = 0; ch < channels; ch += 1) {
    const src = source.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < length; i += 1) dst[i] = src[start + i] ?? 0;
    for (let i = 0; i < fade; i += 1) {
      const t = (i / fade) * (Math.PI / 2);
      dst[i] = (src[start + i] ?? 0) * Math.sin(t) + (src[start + length + i] ?? 0) * Math.cos(t);
    }
  }
  return out;
}

function ensureChain(state: GranularState): { ctx: AudioContext; master: GainNode } {
  const ctx = audioContext();
  if (state.ctx !== ctx || !state.master || !state.limiter || !state.meter) {
    state.ctx = ctx;
    state.master = ctx.createGain();
    state.master.gain.value = 0;
    state.meter = ctx.createAnalyser();
    state.meter.fftSize = 1024;
    state.meterBuffer = null;
    state.limiter = ctx.createDynamicsCompressor();
    // A safety net, not an effect: a dozen loops stacking up would otherwise
    // clip the moment several large cells appear at once.
    state.limiter.threshold.value = -8;
    state.limiter.ratio.value = 12;
    state.limiter.attack.value = 0.003;
    state.limiter.release.value = 0.15;
    // The meter is inline rather than a side tap: an analyser only runs when it
    // reaches the destination, and a dangling one would read silence forever.
    state.master.connect(state.meter).connect(state.limiter).connect(ctx.destination);
  }
  return { ctx, master: state.master };
}

function stopVoice(voice: Voice, when: number): void {
  try {
    voice.source.stop(when);
  } catch {
    // Already stopped — the node is single-use, so this is not an error.
  }
}

function disposeVoice(voice: Voice): void {
  stopVoice(voice, 0);
  voice.source.disconnect();
  voice.filter.disconnect();
  voice.gain.disconnect();
  voice.panner.disconnect();
}

function releaseAll(state: GranularState): void {
  for (const voice of state.voices.values()) disposeVoice(voice);
  state.voices.clear();
}

export const granularNode = defineNode<GranularState>({
  type: "audio.granular",
  label: "Granular",
  category: "audio",
  description: "Each rectangle loops a grain of the source audio; size sets the filter cutoff.",
  inputs: [
    { id: "audio", label: "audio", type: "audio" },
    { id: "rects", label: "rects", type: "boxes" },
  ],
  outputs: [],
  params: [
    { key: "playing", label: "Play", type: "toggle", default: true },
    { key: "master", label: "Master", type: "range", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: "grainMs", label: "Grain length", type: "range", min: 30, max: 2000, step: 10, default: 240 },
    { key: "crossfadeMs", label: "Loop crossfade", type: "range", min: 1, max: 200, step: 1, default: 30 },
    { key: "maxVoices", label: "Max voices", type: "range", min: 1, max: 24, step: 1, default: 8 },
    { key: "minScale", label: "Ignore smaller than", type: "range", min: 0, max: 0.5, step: 0.01, default: 0.02 },
    {
      key: "posMode",
      label: "Grain position",
      type: "select",
      options: [
        { value: "playhead", label: "playhead" },
        { value: "rectX", label: "rect x → track" },
        { value: "random", label: "random" },
      ],
      default: "playhead",
    },
    { key: "sprayMs", label: "Position spray", type: "range", min: 0, max: 4000, step: 10, default: 0 },
    { key: "cutoffLow", label: "Cutoff — biggest", type: "range", min: 60, max: 4000, step: 10, default: 300 },
    { key: "cutoffHigh", label: "Cutoff — smallest", type: "range", min: 500, max: 18000, step: 100, default: 9000 },
    { key: "sizeMin", label: "Size → min", type: "range", min: 0, max: 1, step: 0.01, default: 0.05 },
    { key: "sizeMax", label: "Size → max", type: "range", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: "resonance", label: "Resonance", type: "range", min: 0.1, max: 20, step: 0.1, default: 1 },
    { key: "pitch", label: "Pitch", type: "range", min: -24, max: 24, step: 1, default: 0 },
    { key: "pitchByY", label: "Pitch by height", type: "range", min: 0, max: 24, step: 1, default: 0 },
    { key: "pan", label: "Pan by x", type: "range", min: 0, max: 1, step: 0.05, default: 0.6 },
    { key: "attackMs", label: "Attack", type: "range", min: 1, max: 2000, step: 10, default: 80 },
    { key: "releaseMs", label: "Release", type: "range", min: 1, max: 3000, step: 10, default: 300 },
  ],
  createState() {
    return {
      voices: new Map(),
      master: null,
      limiter: null,
      meter: null,
      meterBuffer: null,
      ctx: null,
      reported: null,
    };
  },
  disposeState(state) {
    releaseAll(state);
    state.master?.disconnect();
    state.meter?.disconnect();
    state.limiter?.disconnect();
    state.master = null;
    state.meter = null;
    state.limiter = null;
    state.ctx = null;
  },
  suspend({ runtime }) {
    // The engine stops ticking while paused, so anything still looping would
    // never be told to stop.
    releaseAll(runtime.state);
    runtime.state.master?.gain.setValueAtTime(0, runtime.state.ctx?.currentTime ?? 0);
  },
  evaluate({ ctx: engine, nodeId, inputs, params, runtime, debug }) {
    const state = runtime.state;
    if (!state.voices) state.voices = new Map();

    const audio = inputs.audio as AudioValue | null;
    const rects = inputs.rects as BoxesValue | null;
    const playing = paramBool(params, "playing", true);

    if (!audio) {
      releaseAll(state);
      engine.report(nodeId, "idle", "wire an audio source");
      if (debug) engine.debugRows(nodeId, [{ label: "source", value: "not connected" }]);
      return {};
    }

    const decoded = audio.buffer ?? ensureAudioBuffer(audio.url).buffer;
    const { ctx, master } = ensureChain(state);
    const now = ctx.currentTime;

    if (!decoded) {
      releaseAll(state);
      const entry = ensureAudioBuffer(audio.url);
      if (entry.status === "error") {
        engine.report(nodeId, "error", entry.message ?? "no decodable audio track");
      } else {
        engine.report(nodeId, "loading", "decoding audio…");
      }
      if (debug) {
        engine.debugRows(nodeId, [
          { label: "buffer", value: entry.status },
          { label: "detail", value: entry.message ?? "fetching + decoding" },
        ]);
      }
      return {};
    }

    const level = Math.max(0, Math.min(1, paramNumber(params, "master", 0.7)));
    master.gain.setTargetAtTime(playing ? level : 0, now, 0.02);

    if (ctx.state !== "running") {
      engine.report(nodeId, "loading", "click anywhere to start audio");
      if (debug) {
        engine.debugRows(nodeId, [
          { label: "audio ctx", value: ctx.state },
          { label: "detail", value: "blocked until a click or keypress" },
        ]);
      }
      return {};
    }

    const attack = Math.max(0.001, paramNumber(params, "attackMs", 80) / 1000);
    const release = Math.max(0.001, paramNumber(params, "releaseMs", 300) / 1000);
    const grainSec = Math.max(0.03, paramNumber(params, "grainMs", 240) / 1000);
    const fadeSec = Math.max(0.001, paramNumber(params, "crossfadeMs", 30) / 1000);
    const maxVoices = Math.max(1, Math.round(paramNumber(params, "maxVoices", 8)));
    const minScale = Math.max(0, paramNumber(params, "minScale", 0.02));
    const posMode = paramString(params, "posMode", "playhead");
    const spraySec = Math.max(0, paramNumber(params, "sprayMs", 0) / 1000);
    const resonance = Math.max(0.0001, paramNumber(params, "resonance", 1));
    const basePitch = paramNumber(params, "pitch", 0);
    const pitchByY = paramNumber(params, "pitchByY", 0);
    const panAmount = Math.max(0, Math.min(1, paramNumber(params, "pan", 0.6)));
    const mapping: CutoffMapping = {
      sizeMin: paramNumber(params, "sizeMin", 0.05),
      sizeMax: paramNumber(params, "sizeMax", 0.6),
      cutoffLow: paramNumber(params, "cutoffLow", 300),
      cutoffHigh: paramNumber(params, "cutoffHigh", 9000),
    };

    const trackSec = decoded.duration;
    const alive = new Set<number>();

    // Play off keeps nothing alive, but the voices still go out through the
    // release below rather than being cut mid-loop.
    for (const [index, box] of (playing ? (rects?.boxes ?? []) : []).entries()) {
      const scale = rectScale(box.w, box.h);
      if (scale < minScale) continue;
      // Boxes from sources without a tracker still get one voice each, keyed by
      // slot — stable enough while the detection order holds.
      const id = box.id ?? -(index + 1);
      alive.add(id);

      const centerX = box.x + box.w / 2;
      const centerY = box.y + box.h / 2;
      const cutoff = cutoffForScale(scale, mapping);
      const pan = (centerX * 2 - 1) * panAmount;

      const existing = state.voices.get(id);
      if (existing) {
        if (existing.endAt !== null) {
          // It came back inside the release — cancel the fade-out.
          existing.endAt = null;
          existing.gain.gain.cancelScheduledValues(now);
          existing.gain.gain.setTargetAtTime(existing.level, now, attack / 3);
        }
        existing.filter.frequency.setTargetAtTime(cutoff, now, 0.03);
        existing.filter.Q.setTargetAtTime(resonance, now, 0.05);
        existing.panner.pan.setTargetAtTime(pan, now, 0.05);
        continue;
      }

      if (state.voices.size >= maxVoices) continue;

      let offset: number;
      if (posMode === "rectX") offset = centerX * trackSec;
      else if (posMode === "random") offset = Math.random() * trackSec;
      else offset = audio.timeSec;
      if (spraySec > 0) offset += (Math.random() * 2 - 1) * spraySec;
      offset = Math.max(0, Math.min(offset, Math.max(0, trackSec - grainSec)));

      const grain = sliceLoop(ctx, decoded, offset, grainSec, fadeSec);
      if (!grain) continue;

      const source = ctx.createBufferSource();
      source.buffer = grain;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = grain.duration;
      const semitones = basePitch + (0.5 - centerY) * 2 * pitchByY;
      source.playbackRate.value = Math.pow(2, semitones / 12);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cutoff;
      filter.Q.value = resonance;

      const gain = ctx.createGain();
      // A fixed level per voice, not one divided by Max voices: raising the cap
      // should let more grains in, not quieten the one that is already playing.
      // The limiter is what deals with several landing at once.
      const voiceLevel = 0.6;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(voiceLevel, now + attack);

      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;

      source.connect(filter).connect(gain).connect(panner).connect(master);
      source.start(now);

      state.voices.set(id, {
        source,
        filter,
        gain,
        panner,
        level: voiceLevel,
        offsetSec: offset,
        pitch: semitones,
        endAt: null,
      });
    }

    for (const [id, voice] of state.voices) {
      if (alive.has(id)) continue;
      if (voice.endAt === null) {
        voice.endAt = now + release;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0.0001, voice.endAt);
        stopVoice(voice, voice.endAt + 0.02);
      } else if (now >= voice.endAt) {
        disposeVoice(voice);
        state.voices.delete(id);
      }
    }

    // Feed the timeline overlay: where each loop reads from, and how loud it is
    // right now. Published every frame — the store is deliberately outside React.
    const marks: GrainMark[] = [];
    for (const [id, voice] of state.voices) {
      marks.push({
        id,
        pos: trackSec > 0 ? voice.offsetSec / trackSec : 0,
        level: voice.level > 0 ? Math.min(1, voice.gain.gain.value / voice.level) : 0,
        pitch: voice.pitch,
      });
    }
    publishGrains(audio.url, marks);

    engine.report(
      nodeId,
      playing ? "ready" : "idle",
      playing ? `${state.voices.size} grains` : "stopped",
    );

    if (debug) {
      let releasing = 0;
      let lowest = Infinity;
      let highest = 0;
      for (const voice of state.voices.values()) {
        if (voice.endAt !== null) releasing += 1;
        lowest = Math.min(lowest, voice.filter.frequency.value);
        highest = Math.max(highest, voice.filter.frequency.value);
      }
      const meter = readLevel(state);
      engine.debugRows(nodeId, [
        { label: "audio ctx", value: `${ctx.state} @ ${Math.round(ctx.sampleRate / 1000)}k` },
        { label: "buffer", value: `${trackSec.toFixed(1)}s · ${decoded.numberOfChannels}ch` },
        { label: "voices", value: `${state.voices.size}/${maxVoices}${releasing ? ` (${releasing} releasing)` : ""}` },
        {
          label: "cutoff",
          value: state.voices.size > 0 ? `${Math.round(lowest)}–${Math.round(highest)} Hz` : "—",
        },
        // The one row that says the grains are audible rather than merely alive.
        {
          label: "out level",
          value:
            meter.peak > 0.0005
              ? `${meter.peak.toFixed(3)} (${meter.db.toFixed(1)} dB)`
              : "silent",
        },
        { label: "master", value: master.gain.value.toFixed(2) },
      ]);
    }
    return {};
  },
});
