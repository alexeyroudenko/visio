import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";

const BLEND_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uTop;
uniform bool uHasBase;
uniform bool uHasTop;
uniform float uOpacity;
uniform int uMode;
out vec4 fragColor;

void main() {
  vec4 base = uHasBase ? texture(uBase, vUv) : vec4(0.0);
  vec4 top = (uHasTop ? texture(uTop, vUv) : vec4(0.0)) * uOpacity;

  if (uMode == 1) {
    fragColor = min(base + top, vec4(1.0));
  } else if (uMode == 2) {
    fragColor = base * (1.0 - uOpacity) + base * top * uOpacity;
  } else if (uMode == 3) {
    fragColor = vec4(1.0) - (vec4(1.0) - base) * (vec4(1.0) - top);
  } else if (uMode == 4) {
    fragColor = abs(base - top);
  } else {
    fragColor = top + base * (1.0 - top.a);
  }
  fragColor.a = clamp(fragColor.a, 0.0, 1.0);
}`;

const MODES: Record<string, number> = {
  over: 0,
  add: 1,
  multiply: 2,
  screen: 3,
  difference: 4,
};

export const blendNode = defineNode<Record<string, never>>({
  type: "fx.blend",
  label: "Blend",
  category: "fx",
  description: "Смешивает две текстуры: over / add / multiply / screen / difference.",
  inputs: [
    { id: "base", label: "base", type: "texture" },
    { id: "top", label: "top", type: "texture" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "mode",
      label: "Режим",
      type: "select",
      options: [
        { value: "over", label: "over" },
        { value: "add", label: "add" },
        { value: "multiply", label: "multiply" },
        { value: "screen", label: "screen" },
        { value: "difference", label: "difference" },
      ],
      default: "over",
    },
    { key: "opacity", label: "Прозрачность top", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
  ],
  createState() {
    return {};
  },
  evaluate({ ctx, nodeId, inputs, params }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const base = inputs.base;
    const top = inputs.top;

    const program = getProgram(gl, FULLSCREEN_VS, BLEND_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    if (isRenderTarget(base)) bindTexture(gl, program, "uBase", base.texture, 0);
    if (isRenderTarget(top)) bindTexture(gl, program, "uTop", top.texture, 1);
    gl.uniform1i(program.uniform("uHasBase"), isRenderTarget(base) ? 1 : 0);
    gl.uniform1i(program.uniform("uHasTop"), isRenderTarget(top) ? 1 : 0);
    gl.uniform1f(program.uniform("uOpacity"), paramNumber(params, "opacity", 1));
    gl.uniform1i(program.uniform("uMode"), MODES[paramString(params, "mode", "over")] ?? 0);
    drawFullscreen(gl, program);

    return { out: target };
  },
});
