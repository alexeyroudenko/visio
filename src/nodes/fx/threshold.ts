import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";

/**
 * Keep pixels whose luma passes a comparison, otherwise write transparent black.
 * Rejected pixels are vec4(0) (not just a=0) so premultiplied add/max blends
 * downstream do not leak color.
 */

const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uTolerance;
uniform int uCmp;
out vec4 fragColor;

void main() {
  vec4 c = texture(uTex, vUv);
  // Unpremultiply before luma so alpha edges do not darken the measure.
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  bool keep = uCmp == 0
    ? luma < uThreshold
    : uCmp == 2
      ? luma > uThreshold
      : abs(luma - uThreshold) <= uTolerance;
  fragColor = keep ? c : vec4(0.0);
}`;

const CMP: Record<string, number> = { lt: 0, eq: 1, gt: 2 };

export const thresholdNode = defineNode<Record<string, never>>({
  type: "fx.threshold",
  label: "Threshold",
  category: "fx",
  description: "Keep pixels whose luma is <, =, or > a threshold; everything else becomes transparent.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "compare",
      label: "Luma",
      type: "select",
      options: [
        { value: "lt", label: "<" },
        { value: "eq", label: "=" },
        { value: "gt", label: ">" },
      ],
      default: "lt",
    },
    { key: "threshold", label: "Threshold", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
    {
      key: "tolerance",
      label: "Tolerance (=)",
      type: "range",
      min: 0,
      max: 0.5,
      step: 0.005,
      default: 0.05,
    },
  ],
  createState() {
    return {};
  },
  evaluate({ ctx, nodeId, inputs, params }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    const program = getProgram(gl, FULLSCREEN_VS, THRESHOLD_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uTex", source.texture, 0);
    gl.uniform1f(program.uniform("uThreshold"), paramNumber(params, "threshold", 0.5));
    gl.uniform1f(program.uniform("uTolerance"), paramNumber(params, "tolerance", 0.05));
    gl.uniform1i(program.uniform("uCmp"), CMP[paramString(params, "compare", "lt")] ?? 0);
    drawFullscreen(gl, program);

    return { out: target };
  },
});
