import { clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { PixelBuffer } from "../shared/pixelBuffer";

interface PixelSortState {
  buffer: PixelBuffer;
}

function applySorted(
  data: Uint8ClampedArray,
  sorted: number[],
  positions: number[],
): void {
  const tmp = new Uint8ClampedArray(sorted.length * 4);
  for (let k = 0; k < sorted.length; k += 1) {
    const s = sorted[k];
    tmp[k * 4] = data[s];
    tmp[k * 4 + 1] = data[s + 1];
    tmp[k * 4 + 2] = data[s + 2];
    tmp[k * 4 + 3] = data[s + 3];
  }
  for (let k = 0; k < positions.length; k += 1) {
    const ppos = positions[k];
    data[ppos] = tmp[k * 4];
    data[ppos + 1] = tmp[k * 4 + 1];
    data[ppos + 2] = tmp[k * 4 + 2];
    data[ppos + 3] = tmp[k * 4 + 3];
  }
}

function pixelSort(data: Uint8ClampedArray, w: number, h: number, thresh: number, vert: boolean): void {
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const sortSpan = (idxs: number[]) => {
    idxs.sort((a, b) => lum(a) - lum(b));
    return idxs;
  };

  if (!vert) {
    for (let y = 0; y < h; y += 1) {
      let x = 0;
      while (x < w) {
        const base = (y * w + x) * 4;
        if (lum(base) > thresh) {
          const span: number[] = [];
          while (x < w) {
            const i = (y * w + x) * 4;
            if (lum(i) <= thresh) break;
            span.push(i);
            x += 1;
          }
          applySorted(data, sortSpan(span.slice()), span);
        } else {
          x += 1;
        }
      }
    }
  } else {
    for (let x = 0; x < w; x += 1) {
      let y = 0;
      while (y < h) {
        const base = (y * w + x) * 4;
        if (lum(base) > thresh) {
          const span: number[] = [];
          while (y < h) {
            const i = (y * w + x) * 4;
            if (lum(i) <= thresh) break;
            span.push(i);
            y += 1;
          }
          applySorted(data, sortSpan(span.slice()), span);
        } else {
          y += 1;
        }
      }
    }
  }
}

export const pixelSortNode = defineNode<PixelSortState>({
  type: "fx.pixelSort",
  label: "Pixel Sort",
  category: "fx",
  description: "Сортировка пикселей по яркости в непрерывных спанах (glitcher).",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "thresh", label: "Порог", type: "range", min: 0, max: 255, step: 1, default: 110 },
    { key: "vert", label: "Вертикаль", type: "toggle", default: false },
  ],
  createState() {
    return { buffer: new PixelBuffer() };
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
    pixelSort(
      image.data,
      image.width,
      image.height,
      paramNumber(params, "thresh", 110),
      paramBool(params, "vert", false),
    );
    runtime.state.buffer.syncToCanvas();
    runtime.state.buffer.write(ctx, target);
    return { out: target };
  },
});
