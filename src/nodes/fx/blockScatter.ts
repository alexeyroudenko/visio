import { clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber } from "../defineNode";
import { mulberry32, PixelBuffer } from "../shared/pixelBuffer";

interface BlockScatterState {
  buffer: PixelBuffer;
  offscreen: HTMLCanvasElement;
  offCtx: CanvasRenderingContext2D;
}

export const blockScatterNode = defineNode<BlockScatterState>({
  type: "fx.blockScatter",
  label: "Block Scatter",
  category: "fx",
  description: "Разлёт прямоугольных блоков с опциональным tint (glitcher).",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "count", label: "Блоков", type: "range", min: 0, max: 400, step: 1, default: 90 },
    { key: "size", label: "Размер", type: "range", min: 2, max: 120, step: 1, default: 34 },
    { key: "spread", label: "Разлёт", type: "range", min: 0, max: 100, step: 1, default: 30 },
    { key: "tint", label: "Цвет", type: "range", min: 0, max: 100, step: 1, default: 25 },
    { key: "seed", label: "Сид", type: "range", min: 0, max: 999999, step: 1, default: 1234 },
  ],
  createState() {
    const offscreen = document.createElement("canvas");
    return {
      buffer: new PixelBuffer(),
      offscreen,
      offCtx: offscreen.getContext("2d")!,
    };
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

    const { buffer, offscreen, offCtx } = runtime.state;
    const image = buffer.read(gl, source);
    const { width: w, height: h } = image;
    const count = Math.round(paramNumber(params, "count", 90));
    const size = paramNumber(params, "size", 34);
    const spreadAmt = paramNumber(params, "spread", 30);
    const tint = paramNumber(params, "tint", 25);
    const seed = paramNumber(params, "seed", 1234);

    buffer.syncToCanvas();
    const canvasCtx = buffer.context;

    if (count > 0) {
      if (offscreen.width !== w || offscreen.height !== h) {
        offscreen.width = w;
        offscreen.height = h;
      }
      offCtx.putImageData(image, 0, 0);

      const rnd = mulberry32(seed + 6 * 9973);
      const spread = (spreadAmt / 100) * Math.max(w, h);
      for (let n = 0; n < count; n += 1) {
        const bw = 2 + Math.floor(rnd() * size);
        const bh = 2 + Math.floor(rnd() * size);
        const sx = Math.floor(rnd() * Math.max(1, w - bw));
        const sy = Math.floor(rnd() * Math.max(1, h - bh));
        const dx = Math.max(0, Math.min(w - bw, sx + Math.floor((rnd() * 2 - 1) * spread)));
        const dy = Math.max(0, Math.min(h - bh, sy + Math.floor((rnd() * 2 - 1) * spread * 0.4)));
        canvasCtx.drawImage(offscreen, sx, sy, bw, bh, dx, dy, bw, bh);
        if (tint > 0 && rnd() < tint / 100) {
          const hue = Math.floor(rnd() * 40) + (rnd() < 0.5 ? 0 : 200);
          canvasCtx.save();
          canvasCtx.globalCompositeOperation = "overlay";
          canvasCtx.globalAlpha = 0.35 + rnd() * 0.4;
          canvasCtx.fillStyle = `hsl(${hue},85%,55%)`;
          canvasCtx.fillRect(dx, dy, bw, bh);
          canvasCtx.restore();
        }
      }
    }

    buffer.write(ctx, target);
    return { out: target };
  },
});
