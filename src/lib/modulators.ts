import type { ParamSpec } from "../engine/types";
import { mulberry32 } from "../nodes/shared/rng";
import type { ParamPath } from "./keyframes";
import { parseParamPath } from "./keyframes";

export type ModulatorShape = "sine" | "triangle" | "saw" | "square" | "noise";

/** Where the −1..1 drive comes from. `audio` needs a sample each apply. */
export type ModulatorSource = "lfo" | "audio";

export interface Modulator {
  source: ModulatorSource;
  shape: ModulatorShape;
  /** Cycles per second of timeline time. Ignored when `source` is `audio`. */
  rateHz: number;
  /** Swing as a fraction of the parameter's own half-range. */
  depth: number;
  /** Constant offset in the same units, so the swing can sit off-centre. */
  bias: number;
  /** Starting point in the cycle, 0..1 — lets two modulators run out of step. */
  phase: number;
  /**
   * FFT band lower edge in Hz (audio source). Defaults applied at parse time;
   * the band helper reads these in later steps.
   */
  bandLoHz?: number;
  /** FFT band upper edge in Hz (audio source). */
  bandHiHz?: number;
}

export type Modulators = Record<ParamPath, Modulator>;

export const MODULATOR_SOURCES: { value: ModulatorSource; label: string }[] = [
  { value: "lfo", label: "LFO" },
  { value: "audio", label: "Audio" },
];

export const MODULATOR_SHAPES: { value: ModulatorShape; label: string }[] = [
  { value: "sine", label: "sine" },
  { value: "triangle", label: "triangle" },
  { value: "saw", label: "saw" },
  { value: "square", label: "square" },
  { value: "noise", label: "noise" },
];

export const DEFAULT_MODULATOR: Modulator = {
  source: "lfo",
  shape: "sine",
  rateHz: 0.5,
  depth: 0.5,
  bias: 0,
  phase: 0,
  bandLoHz: 20,
  bandHiHz: 200,
};

/** Named FFT bands for the Inspector — values land in bandLoHz / bandHiHz. */
export const AUDIO_BAND_PRESETS: { value: string; label: string; lo: number; hi: number }[] = [
  { value: "low", label: "low (20–200 Hz)", lo: 20, hi: 200 },
  { value: "mid", label: "mid (200–2k Hz)", lo: 200, hi: 2000 },
  { value: "high", label: "high (2k–8k Hz)", lo: 2000, hi: 8000 },
  { value: "custom", label: "custom", lo: 20, hi: 200 },
];

export function matchAudioBandPreset(loHz: number, hiHz: number): string {
  const hit = AUDIO_BAND_PRESETS.find(
    (p) => p.value !== "custom" && p.lo === loHz && p.hi === hiHz,
  );
  return hit?.value ?? "custom";
}

/** Smooth value noise: random per whole cycle, cosine-eased in between. */
function valueNoise(turns: number): number {
  const cell = Math.floor(turns);
  const t = turns - cell;
  const at = (n: number) => mulberry32(n * 2654435761)() * 2 - 1;
  const a = at(cell);
  const b = at(cell + 1);
  const eased = 0.5 - 0.5 * Math.cos(t * Math.PI);
  return a + (b - a) * eased;
}

/** All shapes return -1..1 for a position measured in cycles. */
export function waveAt(shape: ModulatorShape, turns: number): number {
  switch (shape) {
    case "sine":
      return Math.sin(turns * Math.PI * 2);
    case "triangle":
      return 4 * Math.abs(turns - Math.floor(turns + 0.5)) - 1;
    case "saw":
      return 2 * (turns - Math.floor(turns + 0.5));
    case "square":
      return turns - Math.floor(turns) < 0.5 ? 1 : -1;
    case "noise":
      return valueNoise(turns);
    default:
      return 0;
  }
}

/**
 * Resolve the −1..1 drive for a modulator. LFO uses the wave; audio uses the
 * supplied sample (missing sample → 0 so the param sits at base+bias).
 */
export function modulatorDrive(
  modulator: Modulator,
  timeSec: number,
  sample?: number,
): number {
  if (modulator.source === "audio") {
    return typeof sample === "number" && Number.isFinite(sample)
      ? Math.min(1, Math.max(-1, sample))
      : 0;
  }
  const turns = timeSec * modulator.rateHz + modulator.phase;
  return waveAt(modulator.shape, turns);
}

/**
 * Modulation swings around whatever the parameter already is — its own value,
 * or the one keyframes resolved for this frame. Depth 0 therefore leaves it
 * exactly alone, and a modulator layered on an animated parameter rides the
 * curve instead of replacing it.
 *
 * `sample` is the −1..1 audio drive when `modulator.source === "audio"`.
 */
export function modulatedValue(
  spec: Extract<ParamSpec, { type: "range" }>,
  base: number,
  modulator: Modulator,
  timeSec: number,
  sample?: number,
): number {
  const half = (spec.max - spec.min) / 2;
  const drive = modulatorDrive(modulator, timeSec, sample);
  const swing = drive * modulator.depth * half;
  const value = base + swing + modulator.bias * half;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/**
 * Overlay modulated values on params that already went through keyframes.
 * Only `range` params can be modulated — a swing needs bounds to be a fraction
 * of, and there is nothing sensible to interpolate on a file or a select.
 *
 * `sampleAt` supplies a −1..1 sample per path for `source: "audio"` modulators.
 * Paths without a sample sit at base+bias (drive 0) until media is ready.
 */
export function applyModulatorsToNodes(
  timeSec: number,
  keyed: Map<string, Record<string, unknown>>,
  modulators: Modulators,
  specOf: (nodeId: string, key: string) => ParamSpec | undefined,
  sampleAt?: (path: ParamPath) => number | undefined,
): Map<string, Record<string, unknown>> {
  for (const [path, modulator] of Object.entries(modulators)) {
    const parsed = parseParamPath(path);
    if (!parsed) continue;
    const params = keyed.get(parsed.nodeId);
    if (!params) continue;
    const spec = specOf(parsed.nodeId, parsed.key);
    if (!spec || spec.type !== "range") continue;
    const base = typeof params[parsed.key] === "number" ? (params[parsed.key] as number) : spec.default;
    const sample = sampleAt?.(path);
    params[parsed.key] = modulatedValue(spec, base, modulator, timeSec, sample);
  }
  return keyed;
}

/** Drops malformed entries rather than letting one bad modulator break a load. */
export function parseModulators(raw: unknown, nodeIds: Set<string>): Modulators {
  if (!raw || typeof raw !== "object") return {};
  const out: Modulators = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseParamPath(path);
    if (!parsed || !nodeIds.has(parsed.nodeId) || !value || typeof value !== "object") continue;
    const m = value as Partial<Modulator>;
    const shape = MODULATOR_SHAPES.some((s) => s.value === m.shape)
      ? (m.shape as ModulatorShape)
      : DEFAULT_MODULATOR.shape;
    const source = MODULATOR_SOURCES.some((s) => s.value === m.source)
      ? (m.source as ModulatorSource)
      : DEFAULT_MODULATOR.source;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    out[path] = {
      source,
      shape,
      rateHz: Math.max(0, num(m.rateHz, DEFAULT_MODULATOR.rateHz)),
      depth: Math.max(0, Math.min(1, num(m.depth, DEFAULT_MODULATOR.depth))),
      bias: Math.max(-1, Math.min(1, num(m.bias, DEFAULT_MODULATOR.bias))),
      phase: num(m.phase, DEFAULT_MODULATOR.phase),
      bandLoHz: Math.max(0, num(m.bandLoHz, DEFAULT_MODULATOR.bandLoHz ?? 20)),
      bandHiHz: Math.max(0, num(m.bandHiHz, DEFAULT_MODULATOR.bandHiHz ?? 200)),
    };
  }
  return out;
}
