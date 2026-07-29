import { clearTarget } from "../../engine/gl/rt";
import type { BoxesValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";

interface RectsState {
  overlay: CanvasOverlay;
}

/**
 * Filled rectangles as a luminance mask: black field, white cells.
 * Useful as a matte for blend / FX — Features Grid `rects` wire straight in.
 */
export const drawRectsNode = defineNode<RectsState>({
  type: "draw.rects",
  label: "Draw Rects",
  category: "draw",
  description: "White filled rectangles on black — a luminance mask from boxes.",
  inputs: [{ id: "rects", label: "rects", type: "boxes" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "inset", label: "Inset", type: "range", min: 0, max: 40, step: 1, default: 0 },
  ],
  createState() {
    return { overlay: new CanvasOverlay() };
  },
  disposeState(state) {
    state.overlay.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = ctx.target(nodeId, "out");
    // Opaque black — the mask's zero, not a transparent hole.
    clearTarget(ctx.gl, target, 0, 0, 0, 1);

    const data = inputs.rects as BoxesValue | null;
    if (!data || data.boxes.length === 0) return { out: target };

    const width = target.width;
    const height = target.height;
    const opacity = Math.max(0, Math.min(1, paramNumber(params, "opacity", 1)));
    const inset = Math.max(0, paramNumber(params, "inset", 0));

    const c2d = runtime.state.overlay.begin(width, height);
    c2d.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    for (const box of data.boxes) {
      const x = box.x * width + inset;
      const y = box.y * height + inset;
      const w = box.w * width - inset * 2;
      const h = box.h * height - inset * 2;
      if (w <= 0 || h <= 0) continue;
      c2d.fillRect(x, y, w, h);
    }
    runtime.state.overlay.commit(ctx, target);

    return { out: target };
  },
});
