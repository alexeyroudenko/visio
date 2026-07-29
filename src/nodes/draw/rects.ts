import { clearTarget } from "../../engine/gl/rt";
import type { BoxesValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";

interface RectsState {
  overlay: CanvasOverlay;
}

/**
 * Filled rectangles as a luminance mask: black field, white cells.
 *
 * Features Grid puts score=1 on cells that got the smear/glitch and score=0 on
 * the rest — so wiring its `rects` here paints white only where the effect
 * landed, not over the whole grid (which tiles the frame).
 */
export const drawRectsNode = defineNode<RectsState>({
  type: "draw.rects",
  label: "Draw Rects",
  category: "draw",
  description: "White filled rectangles on black — a luminance mask from effect cells.",
  inputs: [{ id: "rects", label: "rects", type: "boxes" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "minScore",
      label: "Min score",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
    },
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
    const minScore = Math.max(0, Math.min(1, paramNumber(params, "minScore", 0.5)));
    const opacity = Math.max(0, Math.min(1, paramNumber(params, "opacity", 1)));
    const inset = Math.max(0, paramNumber(params, "inset", 0));

    const c2d = runtime.state.overlay.begin(width, height);
    c2d.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    for (const box of data.boxes) {
      if (box.score < minScore) continue;
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
