import type { PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { fbm3 } from "../shared/noise";
import { mulberry32 } from "../shared/rng";

/**
 * Noise displacement for a point cloud.
 *
 * With `points` wired up it shakes whatever comes in — tracked landmarks,
 * corners — sampling the field at each point's own position, so neighbours move
 * together instead of scattering. With nothing wired up it generates the cloud
 * itself, so a patch can be built and tuned before a tracker is in it at all.
 */

interface NoisePointsState {
  homeX: Float32Array;
  homeY: Float32Array;
  /** Rebuilt only when count / layout / seed change. */
  layoutKey: string;
  /** Reused between frames — the graph consumes the value in the same tick. */
  points: PointsValue["points"];
  /**
   * Noise field time. When Animate is on this is derived from the timeline
   * playhead so scrubbing / offline Render hit the same cloud; when off it
   * freezes where it last stood.
   */
  phase: number;
}

/** Grow/shrink the output array in place, keeping the objects already in it. */
function ensureSize(state: NoisePointsState, size: number): void {
  if (state.points.length === size) return;
  while (state.points.length < size) state.points.push({ x: 0, y: 0, score: 1 });
  state.points.length = size;
}

function ensureLayout(
  state: NoisePointsState,
  count: number,
  layout: string,
  seed: number,
): void {
  const key = `${count}:${layout}:${seed}`;
  if (state.layoutKey === key) return;
  state.layoutKey = key;

  state.homeX = new Float32Array(count);
  state.homeY = new Float32Array(count);

  if (layout === "grid") {
    // Square-ish grid, inset by half a cell so nothing sits on the border.
    const cols = Math.max(1, Math.round(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    for (let i = 0; i < count; i += 1) {
      state.homeX[i] = ((i % cols) + 0.5) / cols;
      state.homeY[i] = (Math.floor(i / cols) + 0.5) / rows;
    }
    return;
  }

  if (layout === "ring") {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      state.homeX[i] = 0.5 + Math.cos(angle) * 0.35;
      state.homeY[i] = 0.5 + Math.sin(angle) * 0.35;
    }
    return;
  }

  const random = mulberry32(seed);
  for (let i = 0; i < count; i += 1) {
    state.homeX[i] = random();
    state.homeY[i] = random();
  }
}

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

export const pointsNoiseNode = defineNode<NoisePointsState>({
  type: "generate.pointsNoise",
  label: "Points Noise",
  category: "tracking",
  description: "Shakes incoming points with a noise field; generates its own cloud when nothing is wired in.",
  inputs: [{ id: "points", label: "points", type: "points" }],
  outputs: [{ id: "out", label: "points", type: "points" }],
  params: [
    { key: "count", label: "Count (no input)", type: "range", min: 1, max: 2000, step: 1, default: 160 },
    {
      key: "layout",
      label: "Layout (no input)",
      type: "select",
      options: [
        { value: "random", label: "random" },
        { value: "grid", label: "grid" },
        { value: "ring", label: "ring" },
      ],
      default: "random",
    },
    { key: "frequency", label: "Frequency", type: "range", min: 0.1, max: 20, step: 0.1, default: 2.5 },
    { key: "octaves", label: "Octaves", type: "range", min: 1, max: 5, step: 1, default: 2 },
    { key: "amount", label: "Displacement", type: "range", min: 0, max: 1, step: 0.01, default: 0.2 },
    { key: "animate", label: "Animate", type: "toggle", default: true },
    { key: "speed", label: "Speed", type: "range", min: 0, max: 5, step: 0.05, default: 0.4 },
    { key: "driftX", label: "Drift X", type: "range", min: -1, max: 1, step: 0.01, default: 0 },
    { key: "driftY", label: "Drift Y", type: "range", min: -1, max: 1, step: 0.01, default: 0 },
    {
      key: "edges",
      label: "Edges",
      type: "select",
      options: [
        { value: "wrap", label: "wrap" },
        { value: "clamp", label: "clamp" },
      ],
      default: "wrap",
    },
    { key: "size", label: "Point size", type: "range", min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: "sizeNoise", label: "Size noise", type: "range", min: 0, max: 1, step: 0.05, default: 0.4 },
    { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 11 },
  ],
  createState() {
    return {
      homeX: new Float32Array(0),
      homeY: new Float32Array(0),
      layoutKey: "",
      points: [],
      phase: 0,
    };
  },
  evaluate({ ctx, inputs, params, runtime }) {
    const state = runtime.state;
    // Connected-but-empty is still "driven from outside": a tracker that loses
    // everything for a frame must not make 160 synthetic points appear.
    const source = (inputs.points as PointsValue | null)?.points ?? null;

    const seed = Math.round(paramNumber(params, "seed", 11));
    if (!source) {
      const count = Math.max(1, Math.round(paramNumber(params, "count", 160)));
      ensureLayout(state, count, paramString(params, "layout", "random"), seed);
    }
    const total = source ? source.length : state.homeX.length;
    ensureSize(state, total);

    // Timeline-locked phase: one playhead position → one field. Accumulating
    // per tick broke offline Render (two ticks per frame) and drifted from the
    // video when Media was on Sync with timeline.
    if (paramBool(params, "animate", true)) {
      const speed = paramNumber(params, "speed", 0.4);
      state.phase = (ctx.timelineFrame / Math.max(1, ctx.timelineFps)) * speed;
    }

    const frequency = Math.max(0.01, paramNumber(params, "frequency", 2.5));
    const octaves = paramNumber(params, "octaves", 2);
    const amount = paramNumber(params, "amount", 0.2);
    const driftX = paramNumber(params, "driftX", 0);
    const driftY = paramNumber(params, "driftY", 0);
    const wrap = paramString(params, "edges", "wrap") !== "clamp";
    const size = paramNumber(params, "size", 0.7);
    const sizeNoise = Math.max(0, Math.min(1, paramNumber(params, "sizeNoise", 0.4)));
    const phase = state.phase;

    for (let i = 0; i < total; i += 1) {
      const from = source ? source[i]! : null;
      // Drift means two different things by necessity. Generated points have no
      // anchor, so sliding their homes is the whole effect — the cloud flows
      // across the frame. Incoming points do have one, and dragging them off it
      // would break the tracking they came from, so there drift only moves where
      // the field is *sampled*: the noise flows past points that stay put.
      const baseX = from ? from.x : wrapUnit(state.homeX[i]! + driftX * phase);
      const baseY = from ? from.y : wrapUnit(state.homeY[i]! + driftY * phase);
      const hx = from ? wrapUnit(from.x + driftX * phase) : baseX;
      const hy = from ? wrapUnit(from.y + driftY * phase) : baseY;

      const nx = fbm3(hx * frequency, hy * frequency, phase, seed, octaves) - 0.5;
      // A different slice of the same field, so x and y are not correlated.
      const ny = fbm3(hx * frequency + 37.7, hy * frequency - 12.3, phase, seed + 101, octaves) - 0.5;

      let px = baseX + nx * 2 * amount;
      let py = baseY + ny * 2 * amount;
      if (wrap) {
        px = wrapUnit(px);
        py = wrapUnit(py);
      } else {
        px = Math.min(1, Math.max(0, px));
        py = Math.min(1, Math.max(0, py));
      }

      // Incoming confidence is kept as the base, so a shaky detection stays
      // small instead of being flattened to whatever Point size says.
      let score = size * (from ? from.score : 1);
      if (sizeNoise > 0) {
        const s = fbm3(hx * frequency * 0.5, hy * frequency * 0.5, phase * 0.5, seed + 7, 1);
        score *= 1 - sizeNoise + sizeNoise * 2 * s;
      }

      const point = state.points[i]!;
      point.x = px;
      point.y = py;
      point.score = Math.min(1, Math.max(0, score));
    }

    return { out: { points: state.points } };
  },
});
