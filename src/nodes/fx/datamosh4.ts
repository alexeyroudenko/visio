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
 * Datamosh4 decode pass — port of visio-datamosh4 / niccolofanton "Feeding a
 * Decoder the Wrong Frame". Motion comes from an external Motion Vectors node
 * (or a built-in matcher).
 *
 * Trigger: Auto cycle, Latch, or hold (when Auto is off and Latch is off).
 * Reset (I-frame): Auto+Latch → every Keyframe ms; Auto off → tap the preview.
 */
const DECODE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D inputBuffer;
uniform sampler2D pFrame;
uniform sampler2D uVelocity;
uniform vec2 resolution;
uniform float uTime;
uniform float uRecover;
uniform float uKeyframe;
uniform float uMotionGain;
uniform float uBlockSize;
uniform float uBlockiness;
uniform float uMvPrecision;
uniform float uSkipThreshold;
uniform float uMismatch;
uniform float uFrozenBlocks;
uniform float uLostLayers;
uniform float uLostLife;
uniform float uLostScale;
uniform float uLostAspect;
uniform float uLostVariance;
uniform float uResidualGain;
uniform float uResidualQuant;
uniform float uDebugMotion;
uniform float uDebugScale;
uniform float uShowLostSectors;
out vec4 fragColor;
${DECODE_MOTION_GLSL}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash23(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 lostRegion(vec2 uv) {
  if (uFrozenBlocks <= 0.0) return vec2(0.0);
  for (float fi = 0.0; fi < 4.0; fi++) {
    if (fi >= uLostLayers) break;
    vec2 scale = vec2(7.0, 5.0) * (1.0 + fi * 1.6) / max(uLostScale, 0.05);
    vec2 p = uv * scale;
    vec2 cellId = floor(p);
    float t = uTime / max(uLostLife, 16.0) + hash13(vec3(cellId, fi + 5.0));
    float slot = floor(t);
    if (hash13(vec3(cellId, slot * 7.0 + fi)) > uFrozenBlocks) continue;
    vec2 centre = 0.2 + hash23(vec3(cellId, slot + fi * 23.0)) * 0.6;
    vec2 halfSize = (0.05 + hash23(vec3(cellId, slot + fi * 41.0)) * vec2(0.45, 0.26) * uLostVariance)
                    * vec2(uLostAspect, 1.0 / max(uLostAspect, 0.05));
    vec2 d = abs(fract(p) - centre) - halfSize;
    if (any(greaterThan(d, vec2(0.0)))) continue;
    if (fract(t) > 0.12 + hash13(vec3(cellId, slot + 61.0)) * 0.45) continue;
    vec2 edge = d / scale * resolution;
    return vec2(1.0, step(-max(uBlockSize, 2.0), max(edge.x, edge.y)));
  }
  return vec2(0.0);
}

vec2 rawMotionAt(vec2 uv) {
  return -decodeMotion(texture(uVelocity, uv));
}

vec3 sampleHistory(vec2 uv) {
  vec2 samplePos = uv * resolution;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = 1.0 + f * f * (-2.5 + 1.5 * f) + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));
  vec3 px = (texPos1.x + vec3(-1.0, offset12.x, 2.0)) / resolution.x;
  vec3 py = (texPos1.y + vec3(-1.0, offset12.y, 2.0)) / resolution.y;
  vec3 wx = vec3(w0.x, w12.x, w3.x);
  vec3 wy = vec3(w0.y, w12.y, w3.y);
  vec3 result = vec3(0.0);
  for (int y = 0; y < 3; y++) {
    for (int x = 0; x < 3; x++) {
      result += texture(pFrame, vec2(px[x], py[y])).rgb * (wx[x] * wy[y]);
    }
  }
  return clamp(result, 0.0, 1.0);
}

vec3 residualAt(vec2 uv, vec2 motion, vec3 current, vec3 predicted) {
  vec2 r = vec2(1.5) / resolution;
  vec3 lowCurrent = texture(inputBuffer, uv + vec2(r.x, 0.0)).rgb
                  + texture(inputBuffer, uv - vec2(r.x, 0.0)).rgb
                  + texture(inputBuffer, uv + vec2(0.0, r.y)).rgb
                  + texture(inputBuffer, uv - vec2(0.0, r.y)).rgb;
  vec2 p = uv - motion;
  vec3 lowPredicted = texture(pFrame, clamp(p + vec2(r.x, 0.0), 0.002, 0.998)).rgb
                    + texture(pFrame, clamp(p - vec2(r.x, 0.0), 0.002, 0.998)).rgb
                    + texture(pFrame, clamp(p + vec2(0.0, r.y), 0.002, 0.998)).rgb
                    + texture(pFrame, clamp(p - vec2(0.0, r.y), 0.002, 0.998)).rgb;
  float hc = dot(current - lowCurrent * 0.25, vec3(0.299, 0.587, 0.114));
  float hp = dot(predicted - lowPredicted * 0.25, vec3(0.299, 0.587, 0.114));
  float steps = max(uResidualQuant, 1.0);
  return vec3(floor((abs(hc) > abs(hp) ? hc - hp : 0.0) * steps + 0.5) / steps);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

float sdArrow(vec2 p, float len) {
  vec2 tip = vec2(len, 0.0);
  vec2 barb = vec2(0.42, 0.42) * len;
  return min(sdSegment(p, vec2(-len, 0.0), tip),
             min(sdSegment(p, tip, tip - barb), sdSegment(p, tip, tip - barb * vec2(1.0, -1.0))));
}

float arrowAt(vec2 uv, vec2 blocks, vec2 blockId) {
  float span = max(floor(48.0 / max(uBlockSize, 1.0) + 0.5), 1.0);
  vec2 cellId = floor(blockId / span) * span;
  vec2 cellMotion = rawMotionAt((cellId + span * 0.5) / blocks) * uMotionGain * resolution;
  float speed = length(cellMotion);
  float reach = clamp(speed / max(uDebugScale, 0.01), 0.0, 1.0);
  vec2 dir = speed > 1e-4 ? cellMotion / speed : vec2(1.0, 0.0);
  vec2 local = ((uv * blocks - cellId) / span - 0.5) * 2.0;
  local = vec2(dot(local, dir), dot(local, vec2(-dir.y, dir.x)));
  float px = 2.0 * blocks.x / (span * resolution.x);
  return (1.0 - smoothstep(-px, px, sdArrow(local, 0.15 + reach * 0.7) - px)) * step(0.02, reach);
}

void main() {
  vec2 uv = vUv;
  vec4 inputColor = texture(inputBuffer, uv);
  vec2 blocks = max(resolution / max(uBlockSize, 1.0), vec2(1.0));
  vec2 blockId = floor(uv * blocks);
  vec2 blockUV = (blockId + 0.5) / blocks;

  if ((uRecover >= 1.0 && uDebugMotion < 0.5) || uKeyframe > 0.5) {
    float border = lostRegion(blockUV).y * uShowLostSectors * uBlockiness;
    fragColor = vec4(mix(inputColor.rgb, vec3(1.0), border), 1.0);
    return;
  }

  float warp = uDebugMotion > 0.5 ? 1.0 : 1.0 - uRecover;

  vec2 mvBlockUV = clamp(blockUV + (sign(hash23(vec3(blockId, 29.0)) - 0.5) / blocks)
                                   * (step(hash13(vec3(blockId, 23.0)), uMismatch) * uBlockiness), 0.0, 1.0);
  vec2 mvUV = mix(uv, mvBlockUV, uBlockiness);
  vec2 motion = rawMotionAt(mvUV) * uMotionGain * warp;

  float mvSteps = max(uMvPrecision, 1.0);
  vec2 motionPx = motion * resolution;
  motion = mix(motionPx, floor(motionPx * mvSteps + 0.5) / mvSteps, uBlockiness) / resolution;

  float skip = uSkipThreshold <= 0.0 ? 0.0
    : (1.0 - smoothstep(uSkipThreshold * 0.5, uSkipThreshold, length(motion * resolution))) * uBlockiness;

  if (uDebugMotion > 0.5) {
    vec2 shown = motion * (1.0 - skip);
    float value = clamp(length(shown * resolution) / max(uDebugScale, 0.01), 0.0, 1.0);
    // No floor brightness — sub-threshold motion stays black, not a tinted wash.
    vec3 wheel = clamp(abs(mod(atan(shown.y, shown.x) / 6.2831853 * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    vec3 debug = value < 0.04 ? vec3(0.0) : wheel * value;
    vec2 grid = abs(fract(uv * blocks) - 0.5);
    debug = mix(vec3(0.25), debug, 1.0 - step(0.47, max(grid.x, grid.y)));
    float arrow = arrowAt(uv, blocks, blockId) * step(0.04, value);
    debug = mix(debug, 1.0 - debug, arrow);
    float border = lostRegion(blockUV).y * uShowLostSectors * uBlockiness;
    fragColor = vec4(mix(debug, vec3(1.0), border), 1.0);
    return;
  }

  vec2 lost = lostRegion(blockUV);
  motion *= 1.0 - max(skip, lost.x * uBlockiness);

  vec3 moshed = length(motion * resolution) < 0.001
    ? texture(pFrame, uv).rgb
    : sampleHistory(uv - motion);
  moshed += residualAt(uv, motion, inputColor.rgb, moshed) * uResidualGain * (1.0 - skip) * warp;

  vec3 decoded = mix(clamp(moshed, 0.0, 1.0), inputColor.rgb, uRecover);
  fragColor = vec4(mix(decoded, vec3(1.0), lost.y * uShowLostSectors * uBlockiness), 1.0);
}`;

const LOST_SECTOR_DELAY_MS = 300;
const AUTO_HOLD_MS = 2600;
const AUTO_REST_MS = 1400;
/** When Auto+Latch and Keyframe ms is 0, still inject I-frames on this period. */
const AUTO_LATCH_KEYFRAME_MS = 1000;

interface Datamosh4State {
  motion: MotionState;
  flip: boolean;
  historyPrimed: boolean;
  pressed: boolean;
  lastRelease: number;
  wasActive: boolean;
  lastKeyframe: number;
  gestureStart: number;
  autoT0: number;
}

export const datamosh4Node = defineNode<Datamosh4State>({
  type: "fx.datamosh4",
  label: "Datamosh4",
  category: "fx",
  description:
    "P-frame bloom (datamosh4): warp history along motion vectors. Auto+Latch resets every Keyframe ms; Auto off moshes continuously (hold preview to bypass).",
  inputs: [
    { id: "src", label: "texture", type: "texture" },
    { id: "mv", label: "vectors", type: "texture" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "auto", label: "Auto", type: "toggle", default: false },
    { key: "latch", label: "Latch", type: "toggle", default: false },
    { key: "gain", label: "Motion gain", type: "range", min: 0, max: 30, step: 0.5, default: 1.5 },
    { key: "fade", label: "Recovery ms", type: "range", min: 1, max: 2000, step: 1, default: 370 },
    { key: "keyframe", label: "Keyframe ms", type: "range", min: 0, max: 3000, step: 10, default: 0 },
    { key: "residual", label: "Residual", type: "range", min: 0, max: 30, step: 0.1, default: 4 },
    { key: "quant", label: "Quant steps", type: "range", min: 2, max: 64, step: 1, default: 14 },
    { key: "block", label: "Macroblock", type: "range", min: 4, max: 64, step: 1, default: 16 },
    { key: "blockiness", label: "Blockiness", type: "range", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "skip", label: "Skip px", type: "range", min: 0, max: 8, step: 0.05, default: 0 },
    { key: "mismatch", label: "Mismatch", type: "range", min: 0, max: 0.5, step: 0.01, default: 0 },
    { key: "lostDensity", label: "Lost dens", type: "range", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "lostLayers", label: "Lost layers", type: "range", min: 1, max: 4, step: 1, default: 4 },
    { key: "lostLife", label: "Lost ms", type: "range", min: 40, max: 8000, step: 5, default: 50 },
    { key: "lostScale", label: "Lost size", type: "range", min: 0.2, max: 8, step: 0.05, default: 2.65 },
    { key: "lostAspect", label: "Lost aspect", type: "range", min: 0.2, max: 5, step: 0.05, default: 0.75 },
    { key: "lostVariance", label: "Lost var", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    {
      key: "precision",
      label: "MV precision",
      type: "select",
      options: [
        { value: "1", label: "full pel" },
        { value: "2", label: "half pel" },
        { value: "4", label: "quarter pel" },
      ],
      default: "2",
    },
    { key: "search", label: "Search (internal)", type: "range", min: 4, max: 96, step: 1, default: 32 },
    { key: "threshold", label: "Threshold (internal)", type: "range", min: 0, max: 1, step: 0.01, default: 0.08 },
    { key: "smooth", label: "Smooth (internal)", type: "range", min: 0, max: 0.95, step: 0.05, default: 0.3 },
    {
      key: "scale",
      label: "Match scale (internal)",
      type: "select",
      options: MOTION_SCALE_OPTIONS,
      default: "4",
    },
    { key: "vectors", label: "Debug vectors", type: "toggle", default: false },
    { key: "sectors", label: "Show lost sectors", type: "toggle", default: false },
    { key: "clear", label: "Reset", type: "toggle", default: false },
  ],
  createState() {
    return {
      motion: createMotionState(),
      flip: false,
      historyPrimed: false,
      pressed: false,
      lastRelease: -1,
      wasActive: false,
      lastKeyframe: 0,
      gestureStart: -Infinity,
      autoT0: -1,
    };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime, debug }) {
    const gl = ctx.gl;
    const state = runtime.state;
    const source = inputs.src;
    const read = ctx.target(nodeId, state.flip ? "acc-b" : "acc-a");
    const write = ctx.target(nodeId, state.flip ? "acc-a" : "acc-b");

    if (!isRenderTarget(source)) {
      clearTarget(gl, write, 0, 0, 0, 0);
      clearTarget(gl, read, 0, 0, 0, 0);
      state.historyPrimed = false;
      return { out: write };
    }

    if (paramBool(params, "clear", false)) {
      state.historyPrimed = false;
      state.pressed = false;
      state.lastRelease = -1;
      state.wasActive = false;
      state.autoT0 = -1;
    }

    const now = ctx.timeMs;
    const auto = paramBool(params, "auto", false);
    const latch = paramBool(params, "latch", false);

    let autoOn = false;
    if (auto) {
      if (state.autoT0 < 0) state.autoT0 = now;
      autoOn = (now - state.autoT0) % (AUTO_HOLD_MS + AUTO_REST_MS) >= AUTO_REST_MS;
    } else {
      state.autoT0 = -1;
    }

    // Mosh trigger: Auto hold phase, Latch, or continuous when Auto is off.
    // Preview hold is handled by the engine (passthrough / clean source).
    const pressed = autoOn || latch || !auto;
    if (pressed !== state.pressed) {
      state.pressed = pressed;
      state.lastRelease = pressed ? -1 : now;
    }
    const fade = Math.max(1, paramNumber(params, "fade", 370));
    const recover =
      !pressed && state.lastRelease < 0
        ? 1
        : pressed
          ? 0
          : Math.min(1, Math.max(0, (now - state.lastRelease) / fade));

    const gestureStart = pressed && !state.wasActive;
    const keyframeMs = paramNumber(params, "keyframe", 0);
    // Auto+Latch: periodic I-frames (Keyframe ms, or a 1s default when unset).
    const interval =
      auto && latch ? (keyframeMs > 0 ? keyframeMs : AUTO_LATCH_KEYFRAME_MS) : keyframeMs;
    const periodicGop =
      pressed && !gestureStart && interval > 0 && now - state.lastKeyframe >= interval;
    const gop = periodicGop;
    if (gestureStart || gop) state.lastKeyframe = now;
    if (gestureStart) state.gestureStart = now;
    state.wasActive = pressed;

    const external = inputs.mv;
    const field = isRenderTarget(external)
      ? external
      : estimateMotion(ctx, nodeId, state.motion, source, {
          block: paramNumber(params, "block", 16),
          search: paramNumber(params, "search", 32),
          scale: Number(paramString(params, "scale", "4")) || 4,
          threshold: paramNumber(params, "threshold", 0.08),
          smooth: paramNumber(params, "smooth", 0.3),
          boost: 1,
        });

    const showVectors = paramBool(params, "vectors", false);
    const frozen =
      now - state.gestureStart >= LOST_SECTOR_DELAY_MS ? paramNumber(params, "lostDensity", 1) : 0;
    const keyframe = gop || gestureStart || !state.historyPrimed ? 1 : 0;
    state.historyPrimed = true;

    const program = getProgram(gl, FULLSCREEN_VS, DECODE_FS);
    bindTarget(gl, write);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "inputBuffer", source.texture, 0);
    bindTexture(gl, program, "pFrame", read.texture, 1);
    bindTexture(gl, program, "uVelocity", field.texture, 2);
    gl.uniform2f(program.uniform("resolution"), write.width, write.height);
    gl.uniform1f(program.uniform("uTime"), now);
    gl.uniform1f(program.uniform("uRecover"), recover);
    gl.uniform1f(program.uniform("uKeyframe"), keyframe);
    gl.uniform1f(program.uniform("uMotionGain"), paramNumber(params, "gain", 1.5));
    gl.uniform1f(program.uniform("uBlockSize"), paramNumber(params, "block", 16));
    gl.uniform1f(program.uniform("uBlockiness"), paramNumber(params, "blockiness", 1));
    gl.uniform1f(program.uniform("uMvPrecision"), Number(paramString(params, "precision", "2")) || 2);
    gl.uniform1f(program.uniform("uSkipThreshold"), paramNumber(params, "skip", 0));
    gl.uniform1f(program.uniform("uMismatch"), paramNumber(params, "mismatch", 0));
    gl.uniform1f(program.uniform("uFrozenBlocks"), frozen);
    gl.uniform1f(program.uniform("uLostLayers"), paramNumber(params, "lostLayers", 4));
    gl.uniform1f(program.uniform("uLostLife"), paramNumber(params, "lostLife", 50));
    gl.uniform1f(program.uniform("uLostScale"), paramNumber(params, "lostScale", 2.65));
    gl.uniform1f(program.uniform("uLostAspect"), paramNumber(params, "lostAspect", 0.75));
    gl.uniform1f(program.uniform("uLostVariance"), paramNumber(params, "lostVariance", 1));
    gl.uniform1f(program.uniform("uResidualGain"), paramNumber(params, "residual", 4) / 10);
    gl.uniform1f(program.uniform("uResidualQuant"), paramNumber(params, "quant", 14));
    gl.uniform1f(program.uniform("uDebugMotion"), showVectors ? 1 : 0);
    gl.uniform1f(program.uniform("uDebugScale"), 8);
    gl.uniform1f(program.uniform("uShowLostSectors"), paramBool(params, "sectors", false) ? 1 : 0);
    drawFullscreen(gl, program);

    // When clean / I-frame, keep the accumulator equal to the honest picture.
    if (keyframe > 0 || (recover >= 1 && !showVectors)) {
      copyTexture(gl, source.texture, write);
    }

    if (debug) {
      const label =
        recover < 1 ? (pressed ? "MOSH" : `recover ${Math.round(recover * 100)}%`) : "clean";
      ctx.debugRows(nodeId, [
        { label: "state", value: label },
        {
          label: "trigger",
          value: pressed ? (autoOn ? "auto" : latch ? "latch" : "always") : "—",
        },
        {
          label: "i-frame",
          value: keyframe
            ? periodicGop
              ? "interval"
              : gestureStart
                ? "start"
                : "prime"
            : "—",
        },
        { label: "vectors", value: isRenderTarget(external) ? "external" : "internal" },
      ]);
    }

    state.flip = !state.flip;
    return { out: write };
  },
});
