import { getProgram } from "../../engine/gl/program";
import { bindTexture, copyTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import {
  createMotionState,
  DECODE_MOTION_GLSL,
  estimateMotion,
  MOTION_SCALE_OPTIONS,
  type MotionState,
} from "../shared/motion";

/**
 * One decoded P-frame: the accumulator resampled along the motion field, plus
 * the difference between the two source frames. That is exactly what a codec
 * does — the difference is that nobody ever sends the I-frame, so the residual
 * keeps landing on a picture it was never computed against.
 */
const MOSH_FS = `#version 300 es
precision highp float;
in vec2 vUv;
/** Last output — the reference frame this prediction is built from. */
uniform sampler2D uAcc;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform sampler2D uMv;
uniform bool uHasMv;
uniform float uAmount;
uniform float uDecay;
uniform float uBloom;
uniform float uRefresh;
out vec4 fragColor;
${DECODE_MOTION_GLSL}

void main() {
  vec2 mv = uHasMv ? decodeMotion(texture(uMv, vUv)) * uAmount : vec2(0.0);
  // Vectors point back into the reference, so this is a plain lookup; outside
  // the frame the clamped sampler smears the edge, like a decoder would.
  vec4 predicted = texture(uAcc, vUv + mv) * uDecay;
  vec4 current = texture(uCur, vUv);
  vec4 residual = current - texture(uPrev, vUv);
  vec4 moshed = predicted + residual * uBloom;
  fragColor = clamp(mix(moshed, current, uRefresh), 0.0, 1.0);
}`;

interface DatamoshState {
  motion: MotionState;
  flip: boolean;
  primed: boolean;
  /** Previous playhead — edge-detect the return to frame 0. */
  lastTimelineFrame: number;
  /** Frames since the last I-frame, for the debug panel. */
  sinceKey: number;
}

export const datamoshNode = defineNode<DatamoshState>({
  type: "fx.datamosh",
  label: "Datamosh",
  category: "fx",
  description:
    "Compression bloom: the picture is dragged along its own motion vectors and never refreshed.",
  inputs: [
    { id: "src", label: "texture", type: "texture" },
    { id: "mv", label: "vectors", type: "texture" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "amount", label: "Drag", type: "range", min: 0, max: 4, step: 0.05, default: 1 },
    { key: "bloom", label: "Residual", type: "range", min: 0, max: 2, step: 0.05, default: 1 },
    { key: "decay", label: "Persistence", type: "range", min: 0.9, max: 1, step: 0.002, default: 1 },
    { key: "refresh", label: "Bleed", type: "range", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "keyframe", label: "I-frame every", type: "range", min: 0, max: 240, step: 1, default: 0 },
    { key: "block", label: "Block", type: "range", min: 4, max: 96, step: 2, default: 16 },
    { key: "search", label: "Search", type: "range", min: 4, max: 96, step: 1, default: 32 },
    {
      key: "scale",
      label: "Match scale",
      type: "select",
      options: MOTION_SCALE_OPTIONS,
      default: "4",
    },
    { key: "threshold", label: "Threshold", type: "range", min: 0, max: 1, step: 0.01, default: 0.12 },
    { key: "smooth", label: "Smooth", type: "range", min: 0, max: 0.95, step: 0.05, default: 0.3 },
    { key: "resetAtFirst", label: "Reset at first frame", type: "toggle", default: true },
    { key: "clear", label: "Reset", type: "toggle", default: false },
  ],
  createState() {
    return {
      motion: createMotionState(),
      flip: false,
      primed: false,
      lastTimelineFrame: 0,
      sinceKey: 0,
    };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime, debug }) {
    const gl = ctx.gl;
    const state = runtime.state;
    const source = inputs.src;

    const read = ctx.target(nodeId, state.flip ? "acc-b" : "acc-a");
    const write = ctx.target(nodeId, state.flip ? "acc-a" : "acc-b");
    const previous = ctx.target(nodeId, "prev");

    if (!isRenderTarget(source)) {
      clearTarget(gl, write, 0, 0, 0, 0);
      clearTarget(gl, read, 0, 0, 0, 0);
      clearTarget(gl, previous, 0, 0, 0, 0);
      state.primed = false;
      return { out: write };
    }

    const external = inputs.mv;
    const field = isRenderTarget(external)
      ? external
      : estimateMotion(ctx, nodeId, state.motion, source, {
          block: paramNumber(params, "block", 16),
          search: paramNumber(params, "search", 32),
          scale: Number(paramString(params, "scale", "4")) || 4,
          threshold: paramNumber(params, "threshold", 0.12),
          smooth: paramNumber(params, "smooth", 0.3),
          boost: 1,
        });

    // Only on the edge into frame 0 (loop / scrub / offline start) — not every
    // tick while the playhead sits there, which is the usual idle state.
    const frame = ctx.timelineFrame;
    const hitFirst =
      paramBool(params, "resetAtFirst", true) &&
      frame <= 0 &&
      (state.lastTimelineFrame > 0 || ctx.timelineForceSync);
    state.lastTimelineFrame = frame;

    const interval = Math.round(paramNumber(params, "keyframe", 0));
    state.sinceKey += 1;
    const scheduled = interval > 0 && state.sinceKey >= interval;
    const keyframe =
      !state.primed || hitFirst || scheduled || paramBool(params, "clear", false);

    if (keyframe) {
      // An I-frame is the whole picture, with nothing predicted from before it.
      copyTexture(gl, source.texture, write);
      state.primed = true;
      state.sinceKey = 0;
    } else {
      const program = getProgram(gl, FULLSCREEN_VS, MOSH_FS);
      bindTarget(gl, write);
      gl.disable(gl.BLEND);
      program.use();
      bindTexture(gl, program, "uAcc", read.texture, 0);
      bindTexture(gl, program, "uCur", source.texture, 1);
      bindTexture(gl, program, "uPrev", previous.texture, 2);
      bindTexture(gl, program, "uMv", field.texture, 3);
      gl.uniform1i(program.uniform("uHasMv"), 1);
      gl.uniform1f(program.uniform("uAmount"), paramNumber(params, "amount", 1));
      gl.uniform1f(program.uniform("uDecay"), paramNumber(params, "decay", 1));
      gl.uniform1f(program.uniform("uBloom"), paramNumber(params, "bloom", 1));
      gl.uniform1f(program.uniform("uRefresh"), paramNumber(params, "refresh", 0));
      drawFullscreen(gl, program);
    }

    // The residual is always measured against the frame before this one, so the
    // copy happens after the pass that reads it.
    copyTexture(gl, source.texture, previous);

    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "vectors", value: isRenderTarget(external) ? "external" : "internal" },
        {
          label: "grid",
          value: isRenderTarget(external)
            ? `${external.width}×${external.height}`
            : `${state.motion.gridW}×${state.motion.gridH}`,
        },
        {
          label: "search",
          value: isRenderTarget(external) ? "—" : `${state.motion.searchPx}px`,
        },
        { label: "since I-frame", value: String(state.sinceKey) },
      ]);
    }

    state.flip = !state.flip;
    return { out: write };
  },
});
