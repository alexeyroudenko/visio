import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber } from "../defineNode";

const COLOR_CORRECTION_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uHue;
uniform float uSaturation;
uniform float uValue;
uniform float uGamma;
uniform float uBrightness;
uniform float uContrast;
uniform float uAlpha;
out vec4 fragColor;

// RGB to HSV conversion
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

// HSV to RGB conversion
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 texel = texture(uTex, vUv);
  
  // Work unpremultiplied so alpha edges keep their color
  vec3 rgb = texel.a > 0.001 ? texel.rgb / texel.a : texel.rgb;
  
  // Apply gamma correction
  rgb = pow(rgb, vec3(1.0 / uGamma));
  
  // Convert to HSV
  vec3 hsv = rgb2hsv(rgb);
  
  // Apply HSV adjustments
  hsv.x = fract(hsv.x + uHue); // Hue shift (wrap around)
  hsv.y = clamp(hsv.y * uSaturation, 0.0, 1.0); // Saturation
  hsv.z = clamp(hsv.z * uValue, 0.0, 1.0); // Value
  
  // Convert back to RGB
  rgb = hsv2rgb(hsv);
  
  // Apply brightness and contrast
  rgb = (rgb - 0.5) * uContrast + 0.5 + uBrightness;
  
  // Clamp to valid range
  rgb = clamp(rgb, 0.0, 1.0);
  
  // Apply alpha multiplier
  float alpha = texel.a * uAlpha;
  
  fragColor = vec4(rgb * alpha, alpha);
}`;

export const colorCorrectionNode = defineNode<Record<string, never>>({
  type: "fx.colorCorrection",
  label: "Color Correction",
  category: "fx",
  description: "HSV color correction with gamma, brightness, contrast, and alpha controls.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "hue", label: "Hue", type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0 },
    { key: "saturation", label: "Saturation", type: "range", min: 0, max: 3, step: 0.05, default: 1 },
    { key: "value", label: "Value (HSV)", type: "range", min: 0, max: 3, step: 0.05, default: 1 },
    { key: "gamma", label: "Gamma", type: "range", min: 0.1, max: 5, step: 0.05, default: 1 },
    { key: "brightness", label: "Brightness", type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0 },
    { key: "contrast", label: "Contrast", type: "range", min: 0, max: 3, step: 0.05, default: 1 },
    { key: "alpha", label: "Alpha", type: "range", min: 0, max: 1, step: 0.01, default: 1 },
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

    const program = getProgram(gl, FULLSCREEN_VS, COLOR_CORRECTION_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uTex", source.texture, 0);
    gl.uniform1f(program.uniform("uHue"), paramNumber(params, "hue", 0));
    gl.uniform1f(program.uniform("uSaturation"), paramNumber(params, "saturation", 1));
    gl.uniform1f(program.uniform("uValue"), paramNumber(params, "value", 1));
    gl.uniform1f(program.uniform("uGamma"), paramNumber(params, "gamma", 1));
    gl.uniform1f(program.uniform("uBrightness"), paramNumber(params, "brightness", 0));
    gl.uniform1f(program.uniform("uContrast"), paramNumber(params, "contrast", 1));
    gl.uniform1f(program.uniform("uAlpha"), paramNumber(params, "alpha", 1));
    drawFullscreen(gl, program);

    return { out: target };
  },
});
