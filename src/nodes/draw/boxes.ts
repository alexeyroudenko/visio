import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { BoxesValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface BoxesState {
  batch: BatchBuilder;
}

export const drawBoxesNode = defineNode<BoxesState>({
  type: "draw.boxes",
  label: "Draw Boxes",
  category: "draw",
  description: "Detection boxes; optionally a point at each center.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "boxes", label: "boxes", type: "boxes" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Color", type: "color", default: "#ff5c7a" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 2 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "scoreFade", label: "Fade by score", type: "toggle", default: true },
    { key: "centers", label: "Center point", type: "toggle", default: true },
    { key: "centerSize", label: "Point size", type: "range", min: 1, max: 30, step: 1, default: 8 },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.boxes as BoxesValue | null;
    if (!data || data.boxes.length === 0) return { out: target };

    const { batch } = runtime.state;
    batch.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 1);
    const strokeWidth = paramNumber(params, "width", 2);
    const fade = paramBool(params, "scoreFade", true);
    const centers = paramBool(params, "centers", true);
    const centerSize = paramNumber(params, "centerSize", 8);
    const blend = paramString(params, "blend", "normal") as BlendMode;

    for (const box of data.boxes) {
      const alpha = fade ? Math.max(0.15, box.score) * opacity : opacity;
      const x = box.x * width;
      const y = box.y * height;
      const w = box.w * width;
      const h = box.h * height;
      batch.addRect(x, y, w, h, strokeWidth, alpha);
      if (centers) batch.addPoint(x + w / 2, y + h / 2, centerSize, alpha);
    }

    const color = hexToRgb(paramString(params, "color", "#ff5c7a"));
    drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });
    drawPoints(ctx.gl, batch.pointBatch(), { color, blend });

    return { out: target };
  },
});
