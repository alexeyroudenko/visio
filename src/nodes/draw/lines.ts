import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { LinesValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface LinesState {
  batch: BatchBuilder;
}

export const drawLinesNode = defineNode<LinesState>({
  type: "draw.lines",
  label: "Draw Lines",
  category: "draw",
  description: "Line segments from line detection, optionally with endpoint dots.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "lines", label: "lines", type: "lines" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Color", type: "color", default: "#c39bff" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 20, step: 0.5, default: 2 },
    { key: "extend", label: "Extend ×", type: "range", min: 1, max: 3, step: 0.05, default: 1 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "scoreFade", label: "Fade by score", type: "toggle", default: true },
    { key: "endpoints", label: "Endpoint dots", type: "toggle", default: false },
    { key: "endpointSize", label: "Point size", type: "range", min: 1, max: 20, step: 0.5, default: 5 },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.lines as LinesValue | null;
    if (!data || data.lines.length === 0) return { out: target };

    const { batch } = runtime.state;
    batch.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 1);
    const strokeWidth = paramNumber(params, "width", 2);
    const fade = paramBool(params, "scoreFade", true);
    const extend = paramNumber(params, "extend", 1);
    const endpoints = paramBool(params, "endpoints", false);
    const endpointSize = paramNumber(params, "endpointSize", 5);

    for (const line of data.lines) {
      const alpha = fade ? Math.max(0.2, line.score) * opacity : opacity;
      if (alpha <= 0.01) continue;

      let x1 = line.x1 * width;
      let y1 = line.y1 * height;
      let x2 = line.x2 * width;
      let y2 = line.y2 * height;

      if (extend !== 1) {
        // Stretch around the midpoint so the segment stays centered.
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        x1 = midX + (x1 - midX) * extend;
        y1 = midY + (y1 - midY) * extend;
        x2 = midX + (x2 - midX) * extend;
        y2 = midY + (y2 - midY) * extend;
      }

      batch.addSegment(x1, y1, x2, y2, strokeWidth, alpha);
      if (endpoints) {
        batch.addPoint(x1, y1, endpointSize, alpha);
        batch.addPoint(x2, y2, endpointSize, alpha);
      }
    }

    const color = hexToRgb(paramString(params, "color", "#c39bff"));
    const blend = paramString(params, "blend", "normal") as BlendMode;
    drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });
    drawPoints(ctx.gl, batch.pointBatch(), { color, blend });

    return { out: target };
  },
});
