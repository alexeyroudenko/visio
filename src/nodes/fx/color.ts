import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber } from "../defineNode";

const COLOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uHue;
out vec4 fragColor;

vec3 hueRotate(vec3 color, float angle) {
  const vec3 k = vec3(0.57735);
  float c = cos(angle);
  return color * c + cross(k, color) * sin(angle) + k * dot(k, color) * (1.0 - c);
}

void main() {
  vec4 texel = texture(uTex, vUv);
  // Work unpremultiplied so alpha edges keep their color.
  vec3 rgb = texel.a > 0.001 ? texel.rgb / texel.a : texel.rgb;

  rgb = (rgb - 0.5) * uContrast + 0.5 + uBrightness;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma), rgb, uSaturation);
  rgb = hueRotate(rgb, uHue);

  rgb = clamp(rgb, 0.0, 1.0);
  fragColor = vec4(rgb * texel.a, texel.a);
}`;

export const colorNode = defineNode<Record<string, never>>({
  type: "fx.color",
  label: "Color",
  category: "fx",
  description: "Яркость, контраст, насыщенность и сдвиг оттенка.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "brightness", label: "Яркость", type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0 },
    { key: "contrast", label: "Контраст", type: "range", min: 0, max: 3, step: 0.05, default: 1 },
    { key: "saturation", label: "Насыщенность", type: "range", min: 0, max: 3, step: 0.05, default: 1 },
    { key: "hue", label: "Оттенок °", type: "range", min: -180, max: 180, step: 1, default: 0 },
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

    const program = getProgram(gl, FULLSCREEN_VS, COLOR_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uTex", source.texture, 0);
    gl.uniform1f(program.uniform("uBrightness"), paramNumber(params, "brightness", 0));
    gl.uniform1f(program.uniform("uContrast"), paramNumber(params, "contrast", 1));
    gl.uniform1f(program.uniform("uSaturation"), paramNumber(params, "saturation", 1));
    gl.uniform1f(program.uniform("uHue"), (paramNumber(params, "hue", 0) * Math.PI) / 180);
    drawFullscreen(gl, program);

    return { out: target };
  },
});
