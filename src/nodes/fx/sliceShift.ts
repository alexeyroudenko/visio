import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { mulberry32 } from "../shared/rng";

const SLICE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
/** One texel per row: how far that row slides, in uv units. */
uniform sampler2D uShift;
out vec4 fragColor;
void main() {
  float dx = texture(uShift, vec2(vUv.y, 0.5)).r;
  // Wrap horizontally, like the original band shift did with its modulo.
  fragColor = texture(uTex, vec2(fract(vUv.x - dx), vUv.y));
}`;

interface Slice {
  /** Normalized band start and thickness — stable across frames. */
  startF: number;
  heightF: number;
  direction: number;
  /** Accumulated displacement in px; animated mode only. */
  offset: number;
}

interface SliceState {
  shifts: Float32Array;
  lut: WebGLTexture | null;
  lutHeight: number;
  slices: Slice[];
}

/**
 * Rows shift in bands, wrapping at the edges.
 *
 * The glitcher original applies each band to a pristine copy in order, so a row
 * covered by two bands keeps the *last* one's shift. That makes "one shift per
 * row" an exact model rather than an approximation — which collapses the whole
 * effect into a 1-D lookup the shader reads per pixel, with no frame readback.
 */
export const sliceShiftNode = defineNode<SliceState>({
  type: "fx.sliceShift",
  label: "Slice Shift",
  category: "fx",
  description: "Горизонтальные полосы, съезжающие в стороны с заворотом по краям.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "count", label: "Полос", type: "range", min: 0, max: 120, step: 1, default: 28 },
    { key: "maxH", label: "Толщина", type: "range", min: 1, max: 80, step: 1, default: 22 },
    { key: "amount", label: "Сдвиг", type: "range", min: 0, max: 100, step: 1, default: 35 },
    { key: "animate", label: "Анимация", type: "toggle", default: false },
    { key: "seed", label: "Сид", type: "range", min: 0, max: 9999, step: 1, default: 1234 },
  ],
  createState() {
    return { shifts: new Float32Array(0), lut: null, lutHeight: 0, slices: [] };
  },
  disposeState(state, ctx) {
    if (state.lut) ctx.gl.deleteTexture(state.lut);
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const state = runtime.state;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;

    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    const width = target.width;
    const height = target.height;

    if (state.shifts.length !== height) state.shifts = new Float32Array(height);
    const shifts = state.shifts;
    shifts.fill(0);

    const count = Math.round(paramNumber(params, "count", 28));
    const maxH = Math.max(1, paramNumber(params, "maxH", 22));
    const amount = paramNumber(params, "amount", 35);

    const fillBand = (start: number, bandHeight: number, shiftPx: number): void => {
      // Whole pixels only: the original shifts by integer columns, and a
      // fractional offset would make the linear sampler blend neighbours
      // instead of rotating the row cleanly.
      const dx = Math.round(shiftPx) / width;
      const end = Math.min(start + bandHeight, height);
      for (let y = Math.max(0, start); y < end; y += 1) shifts[y] = dx;
    };

    if (count > 0) {
      if (paramBool(params, "animate", false)) {
        // Sliders drive speed; displacement accumulates frame over frame.
        const slices = state.slices;
        while (slices.length < count) {
          slices.push({
            startF: Math.random(),
            heightF: Math.random(),
            direction: Math.random() * 2 - 1,
            offset: 0,
          });
        }
        if (slices.length > count) slices.length = count;

        const speed = (amount / 100) * width * 0.05;
        for (const slice of slices) {
          slice.offset += slice.direction * speed;
          fillBand(
            Math.floor(slice.startF * height),
            1 + Math.floor(slice.heightF * maxH),
            slice.offset,
          );
        }
      } else {
        // Static: the seed alone decides every band.
        const rnd = mulberry32(paramNumber(params, "seed", 1234) + 5 * 9973);
        const maxShift = (amount / 100) * width;
        for (let n = 0; n < count; n += 1) {
          fillBand(
            Math.floor(rnd() * height),
            1 + Math.floor(rnd() * maxH),
            (rnd() * 2 - 1) * maxShift,
          );
        }
      }
    }

    if (!state.lut) {
      state.lut = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, state.lut);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      state.lutHeight = 0;
    }

    gl.bindTexture(gl.TEXTURE_2D, state.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (state.lutHeight !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, height, 1, 0, gl.RED, gl.FLOAT, shifts);
      state.lutHeight = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, height, 1, gl.RED, gl.FLOAT, shifts);
    }

    const program = getProgram(gl, FULLSCREEN_VS, SLICE_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uTex", source.texture, 0);
    bindTexture(gl, program, "uShift", state.lut, 1);
    drawFullscreen(gl, program);

    return { out: target };
  },
});
