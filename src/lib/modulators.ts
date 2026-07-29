import type { ParamSpec } from "../engine/types";
import { mulberry32 } from "../nodes/shared/rng";
import type { ParamPath } from "./keyframes";
import { parseParamPath } from "./keyframes";

export type ModulatorShape = "sine" | "triangle" | "saw" | "square" | "noise";

export interface Modulator {
  shape: ModulatorShape;
  /** Cycles per second of timeline time. */
  rateHz: number;
  /** Swing as a fraction of the parameter's own half-range. */
  depth: number;
  /** Constant offset in the same units, so the swing can sit off-centre. */
  bias: number;
  /** Starting point in the cycle, 0..1 — lets two modulators run out of step. */
  phase: number;
}

export type Modulators = Record<ParamPath, Modulator>;

export const MODULATOR_SHAPES: { value: ModulatorShape; label: string }[] = [
  { value: "sine", label: "sine" },
  { value: "triangle", label: "triangle" },
  { value: "saw", label: "saw" },
  { value: "square", label: "square" },
  { value: "noise", label: "noise" },
];

export const DEFAULT_MODULATOR: Modulator = {
  shape: "sine",
  rateHz: 0.5,
  depth: 0.5,
  bias: 0,
  phase: 0,
};

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
 * Modulation swings around whatever the parameter already is — its own value,
 * or the one keyframes resolved for this frame. Depth 0 therefore leaves it
 * exactly alone, and a modulator layered on an animated parameter rides the
 * curve instead of replacing it.
 */
export function modulatedValue(
  spec: Extract<ParamSpec, { type: "range" }>,
  base: number,
  modulator: Modulator,
  timeSec: number,
): number {
  const half = (spec.max - spec.min) / 2;
  const turns = timeSec * modulator.rateHz + modulator.phase;
  const swing = waveAt(modulator.shape, turns) * modulator.depth * half;
  const value = base + swing + modulator.bias * half;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/**
 * Overlay modulated values on params that already went through keyframes.
 * Only `range` params can be modulated — a swing needs bounds to be a fraction
 * of, and there is nothing sensible to interpolate on a file or a select.
 */
export function applyModulatorsToNodes(
  timeSec: number,
  keyed: Map<string, Record<string, unknown>>,
  modulators: Modulators,
  specOf: (nodeId: string, key: string) => ParamSpec | undefined,
): Map<string, Record<string, unknown>> {
  for (const [path, modulator] of Object.entries(modulators)) {
    const parsed = parseParamPath(path);
    if (!parsed) continue;
    const params = keyed.get(parsed.nodeId);
    if (!params) continue;
    const spec = specOf(parsed.nodeId, parsed.key);
    if (!spec || spec.type !== "range") continue;
    const base = typeof params[parsed.key] === "number" ? (params[parsed.key] as number) : spec.default;
    params[parsed.key] = modulatedValue(spec, base, modulator, timeSec);
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
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    out[path] = {
      shape,
      rateHz: Math.max(0, num(m.rateHz, DEFAULT_MODULATOR.rateHz)),
      depth: Math.max(0, Math.min(1, num(m.depth, DEFAULT_MODULATOR.depth))),
      bias: Math.max(-1, Math.min(1, num(m.bias, DEFAULT_MODULATOR.bias))),
      phase: num(m.phase, DEFAULT_MODULATOR.phase),
    };
  }
  return out;
}
