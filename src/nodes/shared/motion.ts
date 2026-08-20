import { getProgram } from "../../engine/gl/program";
import { bindTexture, copyTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { clearTarget, bindTarget, type RenderTarget } from "../../engine/gl/rt";
import type { EngineContext } from "../../engine/types";

/**
 * Block-matching motion estimation — the piece a codec keeps and a datamosh
 * abuses. Shared by `fx.motion` (which shows the field) and `fx.datamosh`
 * (which drags pixels along it), so both encode vectors the same way.
 *
 * The field is an RGBA8 texture at block resolution: RG hold the vector, B the
 * confidence, A is 1. RG are centred on 0.5 like every other displacement map
 * in the patch, so the output also lands straight in Displace Feedback's map
 * input. The vector points *into the previous frame* — where this block came
 * from — which is what both a codec and a texture lookup want.
 */

/** Half-range of an encoded vector, in uv units per frame. */
export const MOTION_SCALE = 0.25;

/** GLSL that turns a sampled field texel back into a uv offset. */
export const DECODE_MOTION_GLSL = `
vec2 decodeMotion(vec4 texel) {
  return (texel.rg - 0.5) * ${(2 * MOTION_SCALE).toFixed(4)};
}`;

const LUMA_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
/** Quarter of a destination texel, in source uv — a 4-tap box average. */
uniform vec2 uStep;
out vec4 fragColor;
float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  float sum = luma(texture(uTex, vUv + vec2(-uStep.x, -uStep.y)).rgb)
            + luma(texture(uTex, vUv + vec2( uStep.x, -uStep.y)).rgb)
            + luma(texture(uTex, vUv + vec2(-uStep.x,  uStep.y)).rgb)
            + luma(texture(uTex, vUv + vec2( uStep.x,  uStep.y)).rgb);
  fragColor = vec4(vec3(sum * 0.25), 1.0);
}`;

const MATCH_FS = `#version 300 es
precision highp float;
in vec2 vUv;
/** Luma pyramids: this frame and the last one, at the matching scale. */
uniform sampler2D uCur;
uniform sampler2D uPrev;
/** Last frame's field, for temporal smoothing. */
uniform sampler2D uPrevMv;
/** One matching texel, in uv. */
uniform vec2 uLoTexel;
/** Tap spacing inside a block, in uv. */
uniform vec2 uTap;
/** Search radius, in matching texels. */
uniform int uRadius;
uniform float uSmooth;
uniform float uThreshold;
uniform float uBoost;
out vec4 fragColor;
${DECODE_MOTION_GLSL}

/**
 * What a longer vector has to earn to be worth taking. Flat and periodic
 * regions match equally well at many offsets, and without this the winner is
 * whichever the loop happened to try first — a bar that only moved sideways
 * would come out with a vertical vector as long as the search allowed.
 */
const float BIAS = 0.0025;

/** Mean absolute difference over a 3×3 grid spanning the block. */
float cost(vec2 uv, vec2 off) {
  float sum = 0.0;
  for (int j = -1; j <= 1; j += 1) {
    for (int i = -1; i <= 1; i += 1) {
      vec2 d = vec2(float(i), float(j)) * uTap;
      sum += abs(texture(uCur, uv + d).r - texture(uPrev, uv + d + off).r);
    }
  }
  return sum * (1.0 / 9.0);
}

void main() {
  // Zero motion is the reference: a tie never invents a vector, and the first
  // frame (against an empty previous) comes out still.
  float zeroCost = cost(vUv, vec2(0.0));
  float bestCost = zeroCost;
  vec2 best = vec2(0.0);

  // Coarse pass on even offsets, then one refinement ring — together they
  // cover every whole-texel offset for a fraction of a full search.
  for (int y = -uRadius; y <= uRadius; y += 2) {
    for (int x = -uRadius; x <= uRadius; x += 2) {
      if (x == 0 && y == 0) continue;
      vec2 off = vec2(float(x), float(y)) * uLoTexel;
      float c = cost(vUv, off) + BIAS * length(vec2(float(x), float(y)));
      if (c < bestCost) {
        bestCost = c;
        best = off;
      }
    }
  }
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      if (x == 0 && y == 0) continue;
      vec2 off = best + vec2(float(x), float(y)) * uLoTexel;
      float c = cost(vUv, off) + BIAS * length(off / uLoTexel);
      if (c < bestCost) {
        bestCost = c;
        best = off;
      }
    }
  }

  // How much better than standing still — flat or unchanged blocks score 0, so
  // noise in an empty sky never turns into a vector.
  float conf = clamp((zeroCost - bestCost) / max(zeroCost, 0.01), 0.0, 1.0);
  vec2 mv = conf < uThreshold ? vec2(0.0) : best * uBoost;
  if (uSmooth > 0.0) mv = mix(mv, decodeMotion(texture(uPrevMv, vUv)), uSmooth);

  vec2 enc = clamp(mv * ${(1 / (2 * MOTION_SCALE)).toFixed(4)} + 0.5, 0.0, 1.0);
  fragColor = vec4(enc, conf, 1.0);
}`;

export interface MotionState {
  /** Ping-pong index of the field pair. */
  flip: boolean;
  primed: boolean;
  /** Block grid of the last estimate, for the debug panel. */
  gridW: number;
  gridH: number;
  /** Search radius actually used, in source px — the slider is capped. */
  searchPx: number;
}

export function createMotionState(): MotionState {
  return { flip: false, primed: false, gridW: 0, gridH: 0, searchPx: 0 };
}

export interface MotionOptions {
  /** Block edge in source px — one vector per block. */
  block: number;
  /** Search radius in source px. */
  search: number;
  /** Matching runs at 1/scale resolution. */
  scale: number;
  /** Minimum confidence; below it the block is called still. */
  threshold: number;
  /** Blend with the previous field, 0..1. */
  smooth: number;
  boost: number;
}

/** Search wider than this and the shader turns into a heater. */
const MAX_RADIUS = 12;

/**
 * Estimates the field for `source` against the frame this node saw last, and
 * returns it. Uses four persistent targets on `nodeId`, all prefixed `mo-`.
 */
export function estimateMotion(
  ctx: EngineContext,
  nodeId: string,
  state: MotionState,
  source: RenderTarget,
  opts: MotionOptions,
): RenderTarget {
  const gl = ctx.gl;
  const scale = Math.max(1, Math.round(opts.scale));
  const lowWidth = Math.max(2, Math.ceil(source.width / scale));
  const lowHeight = Math.max(2, Math.ceil(source.height / scale));
  const block = Math.max(2, Math.round(opts.block));
  const gridW = Math.max(1, Math.ceil(source.width / block));
  const gridH = Math.max(1, Math.ceil(source.height / block));

  const low = ctx.target(nodeId, "mo-low", lowWidth, lowHeight);
  const previous = ctx.target(nodeId, "mo-prev", lowWidth, lowHeight);
  const read = ctx.target(nodeId, state.flip ? "mo-b" : "mo-a", gridW, gridH);
  const write = ctx.target(nodeId, state.flip ? "mo-a" : "mo-b", gridW, gridH);

  if (!state.primed) {
    clearTarget(gl, previous, 0, 0, 0, 1);
    // A field of 0.5 decodes to no motion — the neutral start for smoothing.
    clearTarget(gl, read, 0.5, 0.5, 0, 1);
    clearTarget(gl, write, 0.5, 0.5, 0, 1);
    state.primed = true;
  }

  const lumaProgram = getProgram(gl, FULLSCREEN_VS, LUMA_FS);
  bindTarget(gl, low);
  gl.disable(gl.BLEND);
  lumaProgram.use();
  bindTexture(gl, lumaProgram, "uTex", source.texture, 0);
  gl.uniform2f(lumaProgram.uniform("uStep"), 0.25 / lowWidth, 0.25 / lowHeight);
  drawFullscreen(gl, lumaProgram);

  const matchProgram = getProgram(gl, FULLSCREEN_VS, MATCH_FS);
  bindTarget(gl, write);
  gl.disable(gl.BLEND);
  matchProgram.use();
  bindTexture(gl, matchProgram, "uCur", low.texture, 0);
  bindTexture(gl, matchProgram, "uPrev", previous.texture, 1);
  bindTexture(gl, matchProgram, "uPrevMv", read.texture, 2);
  gl.uniform2f(matchProgram.uniform("uLoTexel"), 1 / lowWidth, 1 / lowHeight);
  // Taps sit a third of a block apart, so the 3×3 grid spans the block itself.
  gl.uniform2f(
    matchProgram.uniform("uTap"),
    block / (3 * source.width),
    block / (3 * source.height),
  );
  // Coarser matching buys a wider reach for the same shader cost: the radius is
  // capped in matching texels, so 1/8 scale searches four times as far as 1/2.
  const radius = Math.max(1, Math.min(MAX_RADIUS, Math.round(opts.search / scale)));
  gl.uniform1i(matchProgram.uniform("uRadius"), radius);
  gl.uniform1f(matchProgram.uniform("uSmooth"), Math.max(0, Math.min(1, opts.smooth)));
  gl.uniform1f(matchProgram.uniform("uThreshold"), Math.max(0, opts.threshold));
  gl.uniform1f(matchProgram.uniform("uBoost"), opts.boost);
  drawFullscreen(gl, matchProgram);

  // Only now does this frame become the reference for the next one.
  copyTexture(gl, low.texture, previous);

  state.flip = !state.flip;
  state.gridW = gridW;
  state.gridH = gridH;
  state.searchPx = radius * scale;
  return write;
}

/** Shared param block, so both nodes expose the estimator identically. */
export const MOTION_SCALE_OPTIONS = [
  { value: "2", label: "½" },
  { value: "4", label: "¼" },
  { value: "8", label: "⅛" },
];
