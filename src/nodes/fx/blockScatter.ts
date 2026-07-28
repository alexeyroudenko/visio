import { BlockBatch, drawBlocks } from "../../engine/gl/blocks";
import { copyTexture } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber } from "../defineNode";
import { mulberry32 } from "../shared/rng";

interface BlockScatterState {
  batch: BlockBatch;
}

/** hsl(h, 85%, 55%) as the original tint used, in 0..1 rgb. */
function hslToRgb(hue: number): [number, number, number] {
  const s = 0.85;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (hue % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/**
 * Rectangles lifted from the frame and dropped somewhere near where they came
 * from. Every block samples the *original* input — same as the glitcher version,
 * which reads from an untouched snapshot — so it becomes one instanced draw of
 * textured quads instead of a frame readback.
 */
export const blockScatterNode = defineNode<BlockScatterState>({
  type: "fx.blockScatter",
  label: "Block Scatter",
  category: "fx",
  description: "Разлёт прямоугольных блоков с опциональным цветным tint.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "count", label: "Блоков", type: "range", min: 0, max: 400, step: 1, default: 90 },
    { key: "size", label: "Размер", type: "range", min: 2, max: 120, step: 1, default: 34 },
    { key: "spread", label: "Разлёт", type: "range", min: 0, max: 100, step: 1, default: 30 },
    { key: "tint", label: "Цвет", type: "range", min: 0, max: 100, step: 1, default: 25 },
    { key: "seed", label: "Сид", type: "range", min: 0, max: 9999, step: 1, default: 1234 },
    { key: "drift", label: "Дрожание", type: "range", min: 0, max: 30, step: 1, default: 0 },
  ],
  createState() {
    return { batch: new BlockBatch() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    // The untouched frame goes down first; blocks land on top of it.
    copyTexture(gl, source.texture, target);

    const count = Math.round(paramNumber(params, "count", 90));
    if (count <= 0) return { out: target };

    const w = target.width;
    const h = target.height;
    const size = paramNumber(params, "size", 34);
    const spread = (paramNumber(params, "spread", 30) / 100) * Math.max(w, h);
    const tintChance = paramNumber(params, "tint", 25);

    // Drift re-rolls the seed over time; at 0 the scatter is perfectly static.
    const drift = Math.round(paramNumber(params, "drift", 0));
    const seedOffset = drift > 0 ? Math.floor(ctx.frameCount / Math.max(1, 31 - drift)) : 0;
    const rnd = mulberry32(paramNumber(params, "seed", 1234) + 6 * 9973 + seedOffset);

    const { batch } = runtime.state;
    batch.reset();

    for (let n = 0; n < count; n += 1) {
      const bw = 2 + Math.floor(rnd() * size);
      const bh = 2 + Math.floor(rnd() * size);
      const sx = Math.floor(rnd() * Math.max(1, w - bw));
      const sy = Math.floor(rnd() * Math.max(1, h - bh));
      const dx = Math.max(0, Math.min(w - bw, sx + Math.floor((rnd() * 2 - 1) * spread)));
      const dy = Math.max(0, Math.min(h - bh, sy + Math.floor((rnd() * 2 - 1) * spread * 0.4)));

      let tint: [number, number, number] = [0, 0, 0];
      let tintAlpha = 0;
      if (tintChance > 0 && rnd() < tintChance / 100) {
        const hue = Math.floor(rnd() * 40) + (rnd() < 0.5 ? 0 : 200);
        tint = hslToRgb(hue);
        tintAlpha = 0.35 + rnd() * 0.4;
      }

      batch.add(
        [sx / w, sy / h, bw / w, bh / h],
        [dx / w, dy / h, bw / w, bh / h],
        tint,
        tintAlpha,
      );
    }

    bindTarget(gl, target);
    drawBlocks(gl, source.texture, batch);

    return { out: target };
  },
});
