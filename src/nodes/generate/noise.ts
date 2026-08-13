import { getProgram } from "../../engine/gl/program";
import { drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber } from "../defineNode";

/**
 * TouchDesigner-style Noise TOP as a GPU fullscreen pass.
 * Value noise (hash + trilinear fade) with harmonic sum, matching the TD
 * Noise page: seed / period / harmonics / harmonic spread / harmonic gain /
 * exponent / amplitude / offset / monochrome, plus translate + speed for
 * animation (TD Transform page + time).
 */

const NOISE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uSeed;
uniform float uPeriod;
uniform int uHarmonics;
uniform float uHarmonicSpread;
uniform float uHarmonicGain;
uniform float uExponent;
uniform float uAmplitude;
uniform float uOffset;
uniform bool uMonochrome;
uniform vec3 uTranslate;
uniform float uAspect;
out vec4 fragColor;

float hashCell(vec3 p, float seed) {
  // Integer lattice hash → 0..1. Matches the spirit of the CPU valueNoise3.
  ivec3 ip = ivec3(floor(p));
  int h = ip.x * 374761393;
  h = h + ip.y * 668265263;
  h = h + ip.z * 1274126177;
  h = h + int(seed) * 1013904223;
  h = (h ^ (h >> 13)) * 1274126177;
  return float((h ^ (h >> 16)) & 0x7fffffff) / float(0x7fffffff);
}

float fade(float t) {
  return t * t * (3.0 - 2.0 * t);
}

float valueNoise3(vec3 p, float seed) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = vec3(fade(f.x), fade(f.y), fade(f.z));

  float c000 = hashCell(i + vec3(0.0, 0.0, 0.0), seed);
  float c100 = hashCell(i + vec3(1.0, 0.0, 0.0), seed);
  float c010 = hashCell(i + vec3(0.0, 1.0, 0.0), seed);
  float c110 = hashCell(i + vec3(1.0, 1.0, 0.0), seed);
  float c001 = hashCell(i + vec3(0.0, 0.0, 1.0), seed);
  float c101 = hashCell(i + vec3(1.0, 0.0, 1.0), seed);
  float c011 = hashCell(i + vec3(0.0, 1.0, 1.0), seed);
  float c111 = hashCell(i + vec3(1.0, 1.0, 1.0), seed);

  float x00 = mix(c000, c100, u.x);
  float x10 = mix(c010, c110, u.x);
  float x01 = mix(c001, c101, u.x);
  float x11 = mix(c011, c111, u.x);
  float y0v = mix(x00, x10, u.y);
  float y1v = mix(x01, x11, u.y);
  return mix(y0v, y1v, u.z);
}

float fbm(vec3 p, float seed) {
  float sum = 0.0;
  float amp = 1.0;
  float total = 0.0;
  float freq = 1.0;
  // harmonics = extra octaves; loop runs harmonics + 1 times.
  int count = clamp(uHarmonics, 0, 6) + 1;
  for (int i = 0; i < 7; i++) {
    if (i >= count) break;
    sum += valueNoise3(p * freq, seed + float(i) * 1013.0) * amp;
    total += amp;
    amp *= uHarmonicGain;
    freq *= uHarmonicSpread;
  }
  float n = total > 0.0 ? sum / total : 0.0;
  // Sign-preserving power curve (noise is 0..1 so this is just a gamma).
  n = sign(n) * pow(abs(n), max(uExponent, 0.001));
  return clamp(n * uAmplitude + uOffset, 0.0, 1.0);
}

void main() {
  float period = max(uPeriod, 0.001);
  // Keep features square regardless of render aspect.
  vec3 p = vec3((vUv.x - 0.5) * uAspect, vUv.y - 0.5, 0.0) + uTranslate;
  p /= period;

  if (uMonochrome) {
    float n = fbm(p, uSeed);
    fragColor = vec4(vec3(n), 1.0);
  } else {
    float r = fbm(p, uSeed);
    float g = fbm(p, uSeed + 17.0);
    float b = fbm(p, uSeed + 31.0);
    fragColor = vec4(r, g, b, 1.0);
  }
}`;

export const noiseNode = defineNode<Record<string, never>>({
  type: "source.noise",
  label: "Noise",
  category: "source",
  description:
    "TouchDesigner-style noise field — seed, period, harmonics, exponent, amplitude/offset, monochrome.",
  inputs: [],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 1 },
    { key: "period", label: "Period", type: "range", min: 0.01, max: 4, step: 0.01, default: 1 },
    { key: "harmonics", label: "Harmonics", type: "range", min: 0, max: 6, step: 1, default: 2 },
    {
      key: "harmonicSpread",
      label: "Harmonic Spread",
      type: "range",
      min: 1,
      max: 4,
      step: 0.05,
      default: 2,
    },
    {
      key: "harmonicGain",
      label: "Harmonic Gain",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
    { key: "exponent", label: "Exponent", type: "range", min: 0.1, max: 4, step: 0.05, default: 1 },
    { key: "amplitude", label: "Amplitude", type: "range", min: 0, max: 2, step: 0.01, default: 0.5 },
    { key: "offset", label: "Offset", type: "range", min: -1, max: 2, step: 0.01, default: 0.5 },
    { key: "monochrome", label: "Monochrome", type: "toggle", default: true },
    { key: "translateX", label: "Translate X", type: "range", min: -4, max: 4, step: 0.01, default: 0 },
    { key: "translateY", label: "Translate Y", type: "range", min: -4, max: 4, step: 0.01, default: 0 },
    { key: "translateZ", label: "Translate Z", type: "range", min: -4, max: 4, step: 0.01, default: 0 },
    { key: "speed", label: "Speed", type: "range", min: 0, max: 2, step: 0.01, default: 0 },
  ],
  createState() {
    return {};
  },
  evaluate({ ctx, nodeId, params }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const speed = paramNumber(params, "speed", 0);
    const tz =
      paramNumber(params, "translateZ", 0) + (ctx.timeMs / 1000) * speed;

    const program = getProgram(gl, FULLSCREEN_VS, NOISE_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    gl.uniform1f(program.uniform("uSeed"), paramNumber(params, "seed", 1));
    gl.uniform1f(program.uniform("uPeriod"), paramNumber(params, "period", 1));
    gl.uniform1i(program.uniform("uHarmonics"), Math.round(paramNumber(params, "harmonics", 2)));
    gl.uniform1f(program.uniform("uHarmonicSpread"), paramNumber(params, "harmonicSpread", 2));
    gl.uniform1f(program.uniform("uHarmonicGain"), paramNumber(params, "harmonicGain", 0.7));
    gl.uniform1f(program.uniform("uExponent"), paramNumber(params, "exponent", 1));
    gl.uniform1f(program.uniform("uAmplitude"), paramNumber(params, "amplitude", 0.5));
    gl.uniform1f(program.uniform("uOffset"), paramNumber(params, "offset", 0.5));
    gl.uniform1i(program.uniform("uMonochrome"), paramBool(params, "monochrome", true) ? 1 : 0);
    gl.uniform3f(
      program.uniform("uTranslate"),
      paramNumber(params, "translateX", 0),
      paramNumber(params, "translateY", 0),
      tz,
    );
    gl.uniform1f(program.uniform("uAspect"), ctx.height > 0 ? ctx.width / ctx.height : 1);
    drawFullscreen(gl, program);

    return { out: target };
  },
});
