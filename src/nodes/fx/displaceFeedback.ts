import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";

/**
 * Feedback accumulator that also warps by a displacement map.
 * Same internal ping-pong as fx.feedback — no graph cycle needed. With the
 * disp input unwired (or amount at 0) it behaves like plain Feedback.
 */

const DISPLACE_FEEDBACK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform sampler2D uSrc;
uniform sampler2D uDisp;
uniform mat2 uTransform;
uniform vec2 uOffset;
uniform float uDecay;
uniform float uAmount;
uniform int uMode;
uniform int uDispSource;
uniform bool uHasSrc;
uniform bool uHasDisp;
uniform bool uWarpPrev;
uniform bool uWarpSrc;
uniform vec2 uTexel;
out vec4 fragColor;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec2 sampleDisp(vec2 uv) {
  if (!uHasDisp) return vec2(0.0);
  if (uDispSource == 1) {
    // Luma gradient from four neighbour taps — works with any grayscale map.
    float l = luma(texture(uDisp, uv + vec2(-uTexel.x, 0.0)).rgb);
    float r = luma(texture(uDisp, uv + vec2( uTexel.x, 0.0)).rgb);
    float d = luma(texture(uDisp, uv + vec2(0.0, -uTexel.y)).rgb);
    float u = luma(texture(uDisp, uv + vec2(0.0,  uTexel.y)).rgb);
    return vec2(r - l, u - d);
  }
  // RG as a vector centered on 0.5 → -1..1.
  vec3 rgb = texture(uDisp, uv).rgb;
  return (rgb.rg - 0.5) * 2.0;
}

vec4 sampleBounded(sampler2D tex, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(tex, uv);
}

void main() {
  vec2 d = sampleDisp(vUv) * uAmount;
  vec2 warped = uTransform * (vUv - 0.5) + 0.5 + uOffset - (uWarpPrev ? d : vec2(0.0));
  vec2 srcUv = uWarpSrc ? vUv - d : vUv;

  vec4 prev = sampleBounded(uPrev, warped) * uDecay;
  vec4 src = uHasSrc ? sampleBounded(uSrc, srcUv) : vec4(0.0);

  // Colors are premultiplied, so "over" is a plain add against 1 - src.a.
  if (uMode == 1) {
    fragColor = min(src + prev, vec4(1.0));
  } else if (uMode == 2) {
    fragColor = max(src, prev);
  } else {
    fragColor = src + prev * (1.0 - src.a);
  }
}`;

interface DisplaceFeedbackState {
  flip: boolean;
  primed: boolean;
}

const MODES: Record<string, number> = { over: 0, add: 1, max: 2 };
const DISP_SOURCES: Record<string, number> = { rg: 0, luma: 1 };

export const displaceFeedbackNode = defineNode<DisplaceFeedbackState>({
  type: "fx.displaceFeedback",
  label: "Displace Feedback",
  category: "fx",
  description:
    "Feedback accumulator that warps by a second texture — trails that flow with the displacement map.",
  inputs: [
    { id: "src", label: "content", type: "texture" },
    { id: "disp", label: "displace", type: "texture" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "decay", label: "Decay", type: "range", min: 0.5, max: 1, step: 0.005, default: 0.94 },
    { key: "zoom", label: "Zoom", type: "range", min: 0.9, max: 1.1, step: 0.001, default: 1 },
    { key: "rotate", label: "Rotate °/frame", type: "range", min: -3, max: 3, step: 0.05, default: 0 },
    { key: "offsetX", label: "Offset X", type: "range", min: -0.02, max: 0.02, step: 0.0005, default: 0 },
    { key: "offsetY", label: "Offset Y", type: "range", min: -0.02, max: 0.02, step: 0.0005, default: 0 },
    {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [
        { value: "over", label: "over" },
        { value: "add", label: "add" },
        { value: "max", label: "max" },
      ],
      default: "over",
    },
    { key: "amount", label: "Amount", type: "range", min: -0.2, max: 0.2, step: 0.001, default: 0.02 },
    {
      key: "dispSource",
      label: "Disp source",
      type: "select",
      options: [
        { value: "rg", label: "rg" },
        { value: "luma", label: "luma gradient" },
      ],
      default: "rg",
    },
    {
      key: "displace",
      label: "Displace",
      type: "select",
      options: [
        { value: "prev", label: "prev" },
        { value: "source", label: "source" },
        { value: "both", label: "both" },
      ],
      default: "prev",
    },
    { key: "clear", label: "Clear", type: "toggle", default: false },
  ],
  createState() {
    return { flip: false, primed: false };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const state = runtime.state;

    const read = ctx.target(nodeId, state.flip ? "b" : "a");
    const write = ctx.target(nodeId, state.flip ? "a" : "b");

    if (!state.primed) {
      clearTarget(gl, read, 0, 0, 0, 0);
      clearTarget(gl, write, 0, 0, 0, 0);
      state.primed = true;
    }

    if (params.clear === true) {
      clearTarget(gl, read, 0, 0, 0, 0);
      clearTarget(gl, write, 0, 0, 0, 0);
    }

    const source = inputs.src;
    const disp = inputs.disp;
    const hasSource = isRenderTarget(source);
    const hasDisp = isRenderTarget(disp);

    const zoom = Math.max(0.001, paramNumber(params, "zoom", 1));
    const angle = (paramNumber(params, "rotate", 0) * Math.PI) / 180;
    const cos = Math.cos(angle) / zoom;
    const sin = Math.sin(angle) / zoom;

    const displace = paramString(params, "displace", "prev");
    const warpPrev = displace === "prev" || displace === "both";
    const warpSrc = displace === "source" || displace === "both";

    const program = getProgram(gl, FULLSCREEN_VS, DISPLACE_FEEDBACK_FS);
    bindTarget(gl, write);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uPrev", read.texture, 0);
    if (hasSource) bindTexture(gl, program, "uSrc", source.texture, 1);
    if (hasDisp) bindTexture(gl, program, "uDisp", disp.texture, 2);
    gl.uniform1i(program.uniform("uHasSrc"), hasSource ? 1 : 0);
    gl.uniform1i(program.uniform("uHasDisp"), hasDisp ? 1 : 0);
    gl.uniform1i(program.uniform("uWarpPrev"), warpPrev ? 1 : 0);
    gl.uniform1i(program.uniform("uWarpSrc"), warpSrc ? 1 : 0);
    gl.uniformMatrix2fv(program.uniform("uTransform"), false, [cos, sin, -sin, cos]);
    gl.uniform2f(
      program.uniform("uOffset"),
      paramNumber(params, "offsetX", 0),
      paramNumber(params, "offsetY", 0),
    );
    gl.uniform1f(program.uniform("uDecay"), paramNumber(params, "decay", 0.94));
    gl.uniform1f(program.uniform("uAmount"), paramNumber(params, "amount", 0.02));
    gl.uniform1i(program.uniform("uMode"), MODES[paramString(params, "mode", "over")] ?? 0);
    gl.uniform1i(
      program.uniform("uDispSource"),
      DISP_SOURCES[paramString(params, "dispSource", "rg")] ?? 0,
    );
    gl.uniform2f(
      program.uniform("uTexel"),
      write.width > 0 ? 1 / write.width : 0,
      write.height > 0 ? 1 / write.height : 0,
    );
    drawFullscreen(gl, program);

    state.flip = !state.flip;
    return { out: write };
  },
});
