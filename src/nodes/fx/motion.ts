import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";
import {
  createMotionState,
  DECODE_MOTION_GLSL,
  estimateMotion,
  MOTION_SCALE,
  MOTION_SCALE_OPTIONS,
  type MotionState,
} from "../shared/motion";

/**
 * Colour view of the field: hue is the direction the block came from, value is
 * how far. Inspection only — a graph that consumes vectors wants the raw field.
 */
const VIEW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uMv;
uniform float uGain;
out vec4 fragColor;
${DECODE_MOTION_GLSL}

vec3 hsv(float h, float s, float v) {
  vec3 k = fract(vec3(5.0, 3.0, 1.0) / 6.0 + h);
  return v * mix(vec3(1.0), clamp(abs(k * 6.0 - 3.0) - 1.0, 0.0, 1.0), s);
}

void main() {
  vec2 mv = decodeMotion(texture(uMv, vUv));
  float mag = clamp(length(mv) * uGain, 0.0, 1.0);
  float angle = atan(mv.y, mv.x) / 6.2831853 + 0.5;
  fragColor = vec4(hsv(angle, 1.0, mag), 1.0);
}`;

/**
 * One motion vector per block, matched against the previous frame. On its own
 * it is a diagnostic; wired into Datamosh (or Displace Feedback) it is the
 * thing that moves the pixels.
 */
export const motionNode = defineNode<MotionState>({
  type: "fx.motion",
  label: "Motion Vectors",
  category: "fx",
  description:
    "Block-matching motion field between consecutive frames — RG hold where each block came from.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
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
    { key: "boost", label: "Boost", type: "range", min: 0.25, max: 4, step: 0.05, default: 1 },
    {
      key: "view",
      label: "Output",
      type: "select",
      options: [
        { value: "vectors", label: "vectors" },
        { value: "color", label: "colour (look only)" },
      ],
      default: "vectors",
    },
  ],
  createState() {
    return createMotionState();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime, debug }) {
    const gl = ctx.gl;
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      const target = ctx.target(nodeId, "out");
      clearTarget(gl, target, 0.5, 0.5, 0, 1);
      return { out: target };
    }

    const field = estimateMotion(ctx, nodeId, runtime.state, source, {
      block: paramNumber(params, "block", 16),
      search: paramNumber(params, "search", 32),
      scale: Number(paramString(params, "scale", "4")) || 4,
      threshold: paramNumber(params, "threshold", 0.12),
      smooth: paramNumber(params, "smooth", 0.3),
      boost: paramNumber(params, "boost", 1),
    });

    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "grid", value: `${runtime.state.gridW}×${runtime.state.gridH}` },
        { label: "match", value: `1/${paramString(params, "scale", "4")}` },
        { label: "search", value: `${runtime.state.searchPx}px` },
      ]);
    }

    if (paramString(params, "view", "vectors") !== "color") return { out: field };

    const target = ctx.target(nodeId, "out");
    const program = getProgram(gl, FULLSCREEN_VS, VIEW_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uMv", field.texture, 0);
    // A vector a tenth of the frame long already saturates — per-frame motion
    // never comes close to the ±MOTION_SCALE the encoding allows.
    gl.uniform1f(program.uniform("uGain"), 1 / (MOTION_SCALE * 0.4));
    drawFullscreen(gl, program);
    return { out: target };
  },
});
