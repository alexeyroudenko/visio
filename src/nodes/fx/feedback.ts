import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";

const FEEDBACK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform sampler2D uSrc;
uniform mat2 uTransform;
uniform vec2 uOffset;
uniform float uDecay;
uniform int uMode;
uniform bool uHasSrc;
out vec4 fragColor;

void main() {
  vec2 warped = uTransform * (vUv - 0.5) + 0.5 + uOffset;
  vec4 prev = vec4(0.0);
  if (warped.x >= 0.0 && warped.x <= 1.0 && warped.y >= 0.0 && warped.y <= 1.0) {
    prev = texture(uPrev, warped) * uDecay;
  }

  vec4 src = uHasSrc ? texture(uSrc, vUv) : vec4(0.0);

  // Colors are premultiplied, so "over" is a plain add against 1 - src.a.
  if (uMode == 1) {
    fragColor = min(src + prev, vec4(1.0));
  } else if (uMode == 2) {
    fragColor = max(src, prev);
  } else {
    fragColor = src + prev * (1.0 - src.a);
  }
}`;

interface FeedbackState {
  /** Which of the two targets holds the latest accumulation. */
  flip: boolean;
  primed: boolean;
}

const MODES: Record<string, number> = { over: 0, add: 1, max: 2 };

export const feedbackNode = defineNode<FeedbackState>({
  type: "fx.feedback",
  label: "Feedback",
  category: "fx",
  description: "Frame accumulator with decay, zoom, and rotation — trails like in TD.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "decay", label: "Decay", type: "range", min: 0.5, max: 1, step: 0.005, default: 0.94 },
    { key: "zoom", label: "Zoom", type: "range", min: 0.9, max: 1.1, step: 0.001, default: 1.01 },
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
    const hasSource = isRenderTarget(source);

    // Zoom > 1 must magnify the accumulation, so the sampling matrix shrinks.
    const zoom = Math.max(0.001, paramNumber(params, "zoom", 1.01));
    const angle = (paramNumber(params, "rotate", 0) * Math.PI) / 180;
    const cos = Math.cos(angle) / zoom;
    const sin = Math.sin(angle) / zoom;

    const program = getProgram(gl, FULLSCREEN_VS, FEEDBACK_FS);
    bindTarget(gl, write);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uPrev", read.texture, 0);
    if (hasSource) bindTexture(gl, program, "uSrc", source.texture, 1);
    gl.uniform1i(program.uniform("uHasSrc"), hasSource ? 1 : 0);
    gl.uniformMatrix2fv(program.uniform("uTransform"), false, [cos, sin, -sin, cos]);
    gl.uniform2f(
      program.uniform("uOffset"),
      paramNumber(params, "offsetX", 0),
      paramNumber(params, "offsetY", 0),
    );
    gl.uniform1f(program.uniform("uDecay"), paramNumber(params, "decay", 0.94));
    gl.uniform1i(program.uniform("uMode"), MODES[paramString(params, "mode", "over")] ?? 0);
    drawFullscreen(gl, program);

    state.flip = !state.flip;
    return { out: write };
  },
});
