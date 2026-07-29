import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { PointsValue } from "../../engine/types";
import { defineNode, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";
import { mulberry32 } from "../shared/rng";

interface ParticleState {
  /** Struct-of-arrays, sized to the count param — nothing is allocated per frame. */
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  /** Seconds left; <= 0 means the slot is free. */
  life: Float32Array;
  span: Float32Array;
  capacity: number;
  /** Emission is fractional per frame, so the remainder carries over. */
  pending: number;
  random: () => number;
  seed: number;
  dots: BatchBuilder;
  trails: BatchBuilder;
}

function ensureCapacity(state: ParticleState, capacity: number): void {
  if (state.capacity === capacity) return;
  state.x = new Float32Array(capacity);
  state.y = new Float32Array(capacity);
  state.vx = new Float32Array(capacity);
  state.vy = new Float32Array(capacity);
  state.life = new Float32Array(capacity);
  state.span = new Float32Array(capacity);
  state.capacity = capacity;
  state.pending = 0;
}

/**
 * Particles emitted from tracked points and pulled around by them.
 *
 * The step is a fixed 1/fps rather than wall-clock delta: the simulation carries
 * state, so a frame that took 80 ms would otherwise fling everything across the
 * screen, and an offline render would not reproduce what playback showed.
 */
export const particlesNode = defineNode<ParticleState>({
  type: "draw.particles",
  label: "Particles",
  category: "draw",
  description: "Particles emitted from tracked points, attracted or repelled by them.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "count", label: "Max particles", type: "range", min: 50, max: 4000, step: 50, default: 800 },
    { key: "rate", label: "Emit per second", type: "range", min: 0, max: 2000, step: 10, default: 400 },
    { key: "life", label: "Life sec", type: "range", min: 0.1, max: 10, step: 0.1, default: 1.6 },
    { key: "speed", label: "Speed px/s", type: "range", min: 0, max: 800, step: 5, default: 120 },
    { key: "gravity", label: "Gravity px/s²", type: "range", min: -800, max: 800, step: 10, default: 0 },
    { key: "drag", label: "Drag", type: "range", min: 0, max: 4, step: 0.05, default: 0.6 },
    { key: "attract", label: "Attract", type: "range", min: -800, max: 800, step: 10, default: 0 },
    { key: "size", label: "Size", type: "range", min: 0.5, max: 20, step: 0.5, default: 2.5 },
    { key: "trail", label: "Trail", type: "range", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "color", label: "Color", type: "color", default: "#7ee0b8" },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.9 },
    { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    BLEND_PARAM,
  ],
  createState() {
    return {
      x: new Float32Array(0),
      y: new Float32Array(0),
      vx: new Float32Array(0),
      vy: new Float32Array(0),
      life: new Float32Array(0),
      span: new Float32Array(0),
      capacity: 0,
      pending: 0,
      random: mulberry32(7),
      seed: 7,
      dots: new BatchBuilder(),
      trails: new BatchBuilder(),
    };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const state = runtime.state;
    const width = target.width;
    const height = target.height;

    const capacity = Math.max(1, Math.round(paramNumber(params, "count", 800)));
    ensureCapacity(state, capacity);

    const seed = Math.round(paramNumber(params, "seed", 7));
    if (seed !== state.seed) {
      state.seed = seed;
      state.random = mulberry32(seed);
    }

    const data = inputs.points as PointsValue | null;
    const sources = data?.points ?? [];
    const dt = 1 / Math.max(1, ctx.timelineFps);
    const rnd = state.random;

    // --- emit ---------------------------------------------------------------
    const life = paramNumber(params, "life", 1.6);
    if (sources.length > 0) {
      state.pending += paramNumber(params, "rate", 400) * dt;
      const speed = paramNumber(params, "speed", 120);
      let budget = Math.floor(state.pending);
      state.pending -= budget;
      for (let slot = 0; slot < capacity && budget > 0; slot += 1) {
        if (state.life[slot]! > 0) continue;
        const from = sources[Math.floor(rnd() * sources.length)]!;
        const angle = rnd() * Math.PI * 2;
        const kick = speed * (0.4 + rnd() * 0.6);
        state.x[slot] = from.x * width;
        state.y[slot] = from.y * height;
        state.vx[slot] = Math.cos(angle) * kick;
        state.vy[slot] = Math.sin(angle) * kick;
        state.span[slot] = life * (0.6 + rnd() * 0.8);
        state.life[slot] = state.span[slot]!;
        budget -= 1;
      }
      // Nothing free left this frame — do not let the debt pile up forever.
      if (budget > 0) state.pending = 0;
    } else {
      state.pending = 0;
    }

    // --- step ---------------------------------------------------------------
    const gravity = paramNumber(params, "gravity", 0);
    const damping = Math.exp(-paramNumber(params, "drag", 0.6) * dt);
    const attract = paramNumber(params, "attract", 0);

    const { dots, trails } = state;
    dots.reset();
    trails.reset();

    const opacity = paramNumber(params, "opacity", 0.9);
    const size = paramNumber(params, "size", 2.5);
    const trail = paramNumber(params, "trail", 0);

    for (let i = 0; i < capacity; i += 1) {
      const remaining = state.life[i]!;
      if (remaining <= 0) continue;

      let vx = state.vx[i]!;
      let vy = state.vy[i]!;

      if (attract !== 0 && sources.length > 0) {
        // Pull toward the nearest source, so particles track whichever landmark
        // they are closest to rather than the centroid of all of them.
        let bestX = 0;
        let bestY = 0;
        let bestDistSq = Infinity;
        for (const point of sources) {
          const dx = point.x * width - state.x[i]!;
          const dy = point.y * height - state.y[i]!;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestX = dx;
            bestY = dy;
          }
        }
        // Normalising keeps the pull steady instead of exploding up close.
        const dist = Math.sqrt(bestDistSq) || 1;
        vx += (bestX / dist) * attract * dt;
        vy += (bestY / dist) * attract * dt;
      }

      vy += gravity * dt;
      vx *= damping;
      vy *= damping;

      const x = state.x[i]! + vx * dt;
      const y = state.y[i]! + vy * dt;
      const next = remaining - dt;

      state.vx[i] = vx;
      state.vy[i] = vy;
      state.x[i] = x;
      state.y[i] = y;
      state.life[i] = next;
      if (next <= 0) continue;

      const fade = (next / (state.span[i]! || 1)) * opacity;
      dots.addPoint(x, y, size, fade);
      if (trail > 0) {
        trails.addSegment(x - vx * dt * trail * 8, y - vy * dt * trail * 8, x, y, size, fade * 0.6);
      }
    }

    // --- draw ---------------------------------------------------------------
    const color = hexToRgb(paramString(params, "color", "#7ee0b8"));
    const blend = paramString(params, "blend", "normal") as BlendMode;
    if (trail > 0) drawSegments(ctx.gl, trails.segmentBatch(), { color, blend });
    drawPoints(ctx.gl, dots.pointBatch(), { color, blend });

    return { out: target };
  },
});
