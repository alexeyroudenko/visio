import { clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { mulberry32, PixelBuffer } from "../shared/pixelBuffer";

interface SliceAnim {
  syF: number;
  shF: number;
  dir: number;
  dx: number;
}

interface SliceShiftState {
  buffer: PixelBuffer;
  slices: SliceAnim[];
}

function shiftBand(
  src: Uint8ClampedArray,
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sy: number,
  sh: number,
  dxIn: number,
): void {
  const dx = ((Math.round(dxIn) % w) + w) % w;
  for (let y = sy; y < Math.min(sy + sh, h); y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = (x - dx + w) % w;
      const di = (y * w + x) * 4;
      const si = (y * w + sx) * 4;
      data[di] = src[si];
      data[di + 1] = src[si + 1];
      data[di + 2] = src[si + 2];
      data[di + 3] = src[si + 3];
    }
  }
}

export const sliceShiftNode = defineNode<SliceShiftState>({
  type: "fx.sliceShift",
  label: "Slice Shift",
  category: "fx",
  description: "Горизонтальный сдвиг случайных полос (glitcher).",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "count", label: "Полос", type: "range", min: 0, max: 120, step: 1, default: 28 },
    { key: "maxH", label: "Толщина", type: "range", min: 1, max: 80, step: 1, default: 22 },
    { key: "amount", label: "Сдвиг", type: "range", min: 0, max: 100, step: 1, default: 35 },
    { key: "animate", label: "Анимация", type: "toggle", default: false },
    { key: "seed", label: "Сид", type: "range", min: 0, max: 999999, step: 1, default: 1234 },
  ],
  createState() {
    return { buffer: new PixelBuffer(), slices: [] };
  },
  disposeState(state) {
    state.buffer.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    const image = runtime.state.buffer.read(gl, source);
    const { width: w, height: h, data } = image;
    const count = Math.round(paramNumber(params, "count", 28));
    const maxH = paramNumber(params, "maxH", 22);
    const amount = paramNumber(params, "amount", 35);
    const animate = paramBool(params, "animate", false);
    const seed = paramNumber(params, "seed", 1234);

    if (count > 0) {
      const src = new Uint8ClampedArray(data);
      if (!animate) {
        const rnd = mulberry32(seed + 5 * 9973);
        const maxShift = (amount / 100) * w;
        for (let n = 0; n < count; n += 1) {
          shiftBand(
            src,
            data,
            w,
            h,
            Math.floor(rnd() * h),
            1 + Math.floor(rnd() * maxH),
            (rnd() * 2 - 1) * maxShift,
          );
        }
      } else {
        const st = runtime.state;
        while (st.slices.length < count) {
          st.slices.push({
            syF: Math.random(),
            shF: Math.random(),
            dir: Math.random() * 2 - 1,
            dx: 0,
          });
        }
        if (st.slices.length > count) st.slices.length = count;

        const speed = (amount / 100) * w * 0.05;
        for (const s of st.slices) {
          s.dx += s.dir * speed;
          shiftBand(src, data, w, h, Math.floor(s.syF * h), 1 + Math.floor(s.shF * maxH), s.dx);
        }
      }
    }

    runtime.state.buffer.syncToCanvas();
    runtime.state.buffer.write(ctx, target);
    return { out: target };
  },
});
