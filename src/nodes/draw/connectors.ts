import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface ConnectorsState {
  batch: BatchBuilder;
}

/**
 * Connect nearby points with line segments — the Connections overlay from cv-reels.
 * Distance is in pixels at the current patch resolution.
 */
export const connectorsNode = defineNode<ConnectorsState>({
  type: "draw.connectors",
  label: "Connectors",
  category: "draw",
  description: "Link points within a max distance (cv-reels Connections).",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Color", type: "color", default: "#f5f0e6" },
    {
      key: "maxDist",
      label: "Max distance",
      type: "range",
      min: 0,
      max: 600,
      step: 5,
      default: 120,
    },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 1.5 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.85 },
    { key: "fade", label: "Fade by distance", type: "toggle", default: true },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    const maxDist = paramNumber(params, "maxDist", 120);
    if (!data || data.points.length === 0 || maxDist <= 0) return { out: target };

    const { batch } = runtime.state;
    batch.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 0.85);
    const stroke = paramNumber(params, "width", 1.5);
    const doFade = paramBool(params, "fade", true);

    const pixels = data.points.map((point) => ({
      x: point.x * width,
      y: point.y * height,
    }));

    const maxDistSq = maxDist * maxDist;
    for (let i = 0; i < pixels.length; i += 1) {
      for (let j = i + 1; j < pixels.length; j += 1) {
        const a = pixels[i]!;
        const b = pixels[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > maxDistSq || distSq <= 0) continue;
        const dist = Math.sqrt(distSq);
        const alpha = doFade ? (1 - dist / maxDist) * opacity : opacity;
        if (alpha <= 0.01) continue;
        batch.addSegment(a.x, a.y, b.x, b.y, stroke, alpha);
      }
    }

    const color = hexToRgb(paramString(params, "color", "#f5f0e6"));
    const blend = paramString(params, "blend", "normal") as BlendMode;
    drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });

    return { out: target };
  },
});
