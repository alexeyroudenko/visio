import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";
import {
  DECODE_MOTION_GLSL,
  ENCODE_MOTION_GLSL,
  MOTION_SCALE,
} from "../shared/motion";

/**
 * Colour view of the field — same mapping Motion Vectors uses, so a generated
 * field and an estimated one read the same way in the graph.
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
 * Synthetic motion field, same RG encoding as `fx.motion`. Datamosh (and
 * Displace Feedback) consume it without caring whether the vectors came from
 * a match or were invented.
 *
 * Modes map onto the usual datamosh accidents:
 *   constant — one direction, every block (vertical smear / slit-scan)
 *   bands    — horizontal slices, each with its own sideways shove
 *   columns  — vertical slices, each dragging up or down
 *   blocks   — random vector per macroblock (corrupted P-frame)
 *   wave     — sine displacement across the frame
 *   swirl    — vortex around the centre
 *   noise    — smooth flowing field
 */
const FIELD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform int uMode;
uniform float uAmount;
uniform float uAngle;
uniform float uSeed;
uniform float uTime;
uniform float uBands;
uniform float uJitter;
uniform float uFreq;
uniform vec2 uCell;
out vec4 fragColor;
${ENCODE_MOTION_GLSL}

float hash11(float n) {
  return fract(sin(n) * 43758.5453123);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 hash22(vec2 p) {
  return vec2(hash21(p), hash21(p + 19.19));
}

float fade(float t) {
  return t * t * (3.0 - 2.0 * t);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = vec2(fade(f.x), fade(f.y));
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 cellId(vec2 uv) {
  vec2 cell = max(uCell, vec2(1.0 / 4096.0));
  return floor(uv / cell);
}

void main() {
  vec2 id = cellId(vUv);
  vec2 dir = vec2(cos(uAngle), sin(uAngle));
  float mag = uAmount;
  vec2 mv = vec2(0.0);

  if (uMode == 0) {
    mv = dir * mag;
  } else if (uMode == 1) {
    float band = floor(vUv.y * max(uBands, 1.0));
    float h = hash11(band + uSeed + floor(uTime * 8.0) * 13.0);
    vec2 rnd = hash22(vec2(band + uSeed, uSeed + 7.0)) * 2.0 - 1.0;
    mv = mix(dir * (h * 2.0 - 1.0), rnd, uJitter) * mag;
  } else if (uMode == 2) {
    float col = floor(vUv.x * max(uBands, 1.0));
    float h = hash11(col + uSeed + 3.0 + floor(uTime * 8.0) * 17.0);
    vec2 rnd = hash22(vec2(col + uSeed, uSeed + 11.0)) * 2.0 - 1.0;
    mv = mix(dir * (h * 2.0 - 1.0), rnd, uJitter) * mag;
  } else if (uMode == 3) {
    vec2 rnd = hash22(id + vec2(uSeed, floor(uTime * 8.0))) * 2.0 - 1.0;
    mv = mix(dir * (hash21(id + uSeed) * 2.0 - 1.0), rnd, uJitter) * mag;
  } else if (uMode == 4) {
    float phase = uTime * 6.2831853;
    float s = sin(dot(vUv, dir.yx) * uFreq * 6.2831853 + phase);
    vec2 across = vec2(-dir.y, dir.x);
    mv = mix(across * s, dir * s, uJitter) * mag;
  } else if (uMode == 5) {
    vec2 p = vUv - 0.5;
    vec2 tang = vec2(-p.y, p.x);
    float r = length(p);
    vec2 rnd = hash22(id + uSeed) * 2.0 - 1.0;
    mv = mix(tang * 2.0, rnd * r, uJitter) * mag;
  } else {
    vec2 p = vUv * uFreq + vec2(uSeed * 0.01, uTime);
    float nx = valueNoise(p) * 2.0 - 1.0;
    float ny = valueNoise(p + 17.7) * 2.0 - 1.0;
    mv = mix(dir * nx, vec2(nx, ny), uJitter) * mag;
  }

  vec2 enc = encodeMotion(mv);
  fragColor = vec4(enc, 1.0, 1.0);
}`;

const MODE_IDS: Record<string, number> = {
  constant: 0,
  bands: 1,
  columns: 2,
  blocks: 3,
  wave: 4,
  swirl: 5,
  noise: 6,
};

export const genMotionNode = defineNode<Record<string, never>>({
  type: "fx.genMotion",
  label: "Gen Motion Vectors",
  category: "fx",
  description:
    "Invented motion field for Datamosh: bands, columns, blocks, waves, swirl, noise, or a constant drag.",
  inputs: [],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [
        { value: "constant", label: "constant" },
        { value: "bands", label: "bands (slices)" },
        { value: "columns", label: "columns" },
        { value: "blocks", label: "blocks" },
        { value: "wave", label: "wave" },
        { value: "swirl", label: "swirl" },
        { value: "noise", label: "noise" },
      ],
      default: "bands",
    },
    {
      key: "amount",
      label: "Amount",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
    },
    {
      key: "angle",
      label: "Angle",
      type: "range",
      min: 0,
      max: 360,
      step: 1,
      default: 0,
    },
    { key: "block", label: "Block", type: "range", min: 1, max: 96, step: 1, default: 16 },
    { key: "bands", label: "Bands", type: "range", min: 1, max: 80, step: 1, default: 24 },
    { key: "jitter", label: "Jitter", type: "range", min: 0, max: 1, step: 0.05, default: 0.25 },
    { key: "freq", label: "Frequency", type: "range", min: 0.25, max: 16, step: 0.25, default: 4 },
    { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 },
    { key: "speed", label: "Speed", type: "range", min: 0, max: 4, step: 0.05, default: 0 },
    { key: "phase", label: "Phase", type: "range", min: 0, max: 8, step: 0.05, default: 0 },
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
    return {};
  },
  evaluate({ ctx, nodeId, params, debug }) {
    const gl = ctx.gl;
    const field = ctx.target(nodeId, "field");
    const block = Math.max(1, Math.round(paramNumber(params, "block", 16)));
    const amount = Math.max(0, Math.min(1, paramNumber(params, "amount", 0.35))) * MOTION_SCALE;
    const angle = (paramNumber(params, "angle", 0) * Math.PI) / 180;
    const speed = paramNumber(params, "speed", 0);
    const time = ctx.frameCount * speed * (1 / 30) + paramNumber(params, "phase", 0);
    const modeKey = paramString(params, "mode", "bands");
    const mode = MODE_IDS[modeKey] ?? 1;

    const program = getProgram(gl, FULLSCREEN_VS, FIELD_FS);
    bindTarget(gl, field);
    gl.disable(gl.BLEND);
    program.use();
    gl.uniform1i(program.uniform("uMode"), mode);
    gl.uniform1f(program.uniform("uAmount"), amount);
    gl.uniform1f(program.uniform("uAngle"), angle);
    gl.uniform1f(program.uniform("uSeed"), paramNumber(params, "seed", 7));
    gl.uniform1f(program.uniform("uTime"), time);
    gl.uniform1f(program.uniform("uBands"), paramNumber(params, "bands", 24));
    gl.uniform1f(program.uniform("uJitter"), Math.max(0, Math.min(1, paramNumber(params, "jitter", 0.25))));
    gl.uniform1f(program.uniform("uFreq"), paramNumber(params, "freq", 4));
    gl.uniform2f(program.uniform("uCell"), block / Math.max(1, field.width), block / Math.max(1, field.height));
    drawFullscreen(gl, program);

    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "mode", value: modeKey },
        { label: "block", value: `${block}px` },
        { label: "amount", value: amount.toFixed(3) },
      ]);
    }

    if (paramString(params, "view", "vectors") !== "color") return { out: field };

    const target = ctx.target(nodeId, "out");
    const view = getProgram(gl, FULLSCREEN_VS, VIEW_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    view.use();
    bindTexture(gl, view, "uMv", field.texture, 0);
    gl.uniform1f(view.uniform("uGain"), 1 / (MOTION_SCALE * 0.4));
    drawFullscreen(gl, view);
    return { out: target };
  },
});
